import { PostStorageService } from "../posts/post-storage.service.js";
import { Injectable } from "@nestjs/common";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { PrismaService } from "../prisma/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import { UsersService } from "../users/users.service.js";
import {
    createAccessToken,
    createRefreshToken,
    createTwoFactorToken,
    verifyRefreshToken,
    verifyTwoFactorToken,
} from "../utils/token.js";
import type { CurrentUser, JwtPayload } from "./auth.types.js";

export class AuthFlowError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

type LoginResult =
    | {
        kind: "two-factor";
        challengeToken: string;
    }
    | {
        kind: "authenticated";
        accessToken: string;
        refreshToken: string;
        currentUser: CurrentUser;
    };

interface CurrentUserSource {
    id: bigint;
    email: string;
    status: string;
    user_name: string | null;
    first_name: string | null;
    last_name: string | null;
    avatar: string | null;
    created_at: Date;
    updated_at: Date;
}

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_KEY_PREFIX = "auth:session:";

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly usersService: UsersService,
        private readonly storage: PostStorageService,
    ) {}

    hashPassword(password: string) {
        return bcrypt.hash(password, 10);
    }

    comparePassword(password: string, passwordHash: string) {
        return bcrypt.compare(password, passwordHash);
    }

    hashToken(token: string): string {
        return crypto
            .createHash("sha256")
            .update(token)
            .digest("hex");
    }

    saveRefreshToken(userId: bigint, token: string) {
        const tokenHash = this.hashToken(token);
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        return this.prisma.refresh_tokens.create({
            data: {
                user_id: userId,
                token_hash: tokenHash,
                expires_at: expiresAt,
            },
        });
    }

    findRefreshToken(token: string) {
        const tokenHash = this.hashToken(token);

        return this.prisma.refresh_tokens.findFirst({
            where: {
                token_hash: tokenHash,
                revoked_at: null,
                expires_at: {
                    gt: new Date(),
                },
            },
        });
    }

    revokeRefreshToken(token: string) {
        const tokenHash = this.hashToken(token);

        return this.prisma.refresh_tokens.updateMany({
            where: {
                token_hash: tokenHash,
                revoked_at: null,
            },
            data: {
                revoked_at: new Date(),
            },
        });
    }

    getTwoFactor(userId: bigint) {
        return this.prisma.user_two_factor_auth.findUnique({
            where: {
                user_id: userId,
            },
        });
    }

    async register(
        email: string,
        password: string,
        firstName: string,
        lastName: string,
        userName?: string,
    ) {
        const existingUser = await this.usersService.getUserByEmail(email);

        if (existingUser) {
            throw new AuthFlowError("EMAIL_ALREADY_EXISTS");
        }

        const passwordHash = await this.hashPassword(password);
        return this.usersService.createUser(
            email,
            passwordHash,
            firstName,
            lastName,
            userName,
        );
    }

    async login(email: string, password: string): Promise<LoginResult> {
        const user = await this.usersService.getUserByEmail(email);

        if (!user) {
            throw new AuthFlowError("INVALID_CREDENTIALS");
        }

        const passwordValid = await this.comparePassword(password, user.password_hash);

        if (!passwordValid) {
            throw new AuthFlowError("INVALID_CREDENTIALS");
        }

        const twoFactor = await this.getTwoFactor(user.id);

        if (twoFactor?.is_enabled) {
            return {
                kind: "two-factor",
                challengeToken: createTwoFactorToken(user.id),
            };
        }

        const session = await this.createSession(user);

        return {
            kind: "authenticated",
            ...session,
        };
    }

    async refresh(refreshToken: string) {
        const payload = verifyRefreshToken(refreshToken) as JwtPayload;

        if (payload.type !== "refresh") {
            throw new AuthFlowError("INVALID_REFRESH_TOKEN");
        }

        if (!payload.sessionId) {
            throw new AuthFlowError("INVALID_REFRESH_TOKEN");
        }

        const savedToken = await this.findRefreshToken(refreshToken);

        if (!savedToken) {
            throw new AuthFlowError("REFRESH_TOKEN_NOT_FOUND");
        }

        const sessionUser = await this.getSessionCurrentUser(
            payload.sessionId,
            BigInt(payload.userId),
        );

        if (!sessionUser) {
            throw new AuthFlowError("SESSION_NOT_FOUND");
        }

        const user = await this.usersService.getUserById(BigInt(payload.userId));

        if (!user) {
            throw new AuthFlowError("USER_NOT_FOUND");
        }

        const currentUser = await this.toCurrentUser(user);
        await this.saveSession(payload.sessionId, currentUser);

        return {
            accessToken: createAccessToken(user.id, payload.sessionId),
            currentUser,
        };
    }

    async getCurrentUser(userId: bigint): Promise<CurrentUser> {
        const user = await this.usersService.getUserById(userId);

        if (!user) {
            throw new AuthFlowError("USER_NOT_FOUND");
        }

        return this.toCurrentUser(user);
    }

    async getSessionCurrentUser(
        sessionId: string,
        userId: bigint,
    ): Promise<CurrentUser | null> {
        const value = await this.redis.get(this.getSessionKey(sessionId));

        if (!value) {
            return null;
        }

        try {
            const currentUser = JSON.parse(value) as CurrentUser;

            if (currentUser.id !== userId.toString()) {
                return null;
            }

            return currentUser;
        } catch {
            await this.deleteSession(sessionId);
            return null;
        }
    }

    async logout(refreshToken: string): Promise<void> {
        await this.revokeRefreshToken(refreshToken);

        let sessionId: string | undefined;

        try {
            const payload = verifyRefreshToken(refreshToken) as JwtPayload;
            sessionId = payload.sessionId;
        } catch {
            // An invalid/expired cookie must not prevent an idempotent logout.
        }

        if (sessionId) {
            await this.deleteSession(sessionId);
        }
    }

    async setupTwoFactor(userId: bigint) {
        const secret = generateSecret();

        await this.prisma.user_two_factor_auth.upsert({
            where: {
                user_id: userId,
            },
            update: {
                secret,
                is_enabled: false,
                enabled_at: null,
            },
            create: {
                user_id: userId,
                secret,
                is_enabled: false,
            },
        });

        return generateURI({
            secret,
            issuer: "NexChat",
            label: userId.toString(),
        });
    }

    async enableTwoFactor(userId: bigint, code: string): Promise<void> {
        const config = await this.prisma.user_two_factor_auth.findUnique({
            where: {
                user_id: userId,
            },
        });

        if (!config) {
            throw new AuthFlowError("TWO_FACTOR_NOT_CONFIGURED");
        }

        const result = await verify({
            token: code,
            secret: config.secret,
        });

        if (!result.valid) {
            throw new AuthFlowError("INVALID_OTP");
        }

        await this.prisma.user_two_factor_auth.update({
            where: {
                user_id: userId,
            },
            data: {
                is_enabled: true,
                enabled_at: new Date(),
            },
        });
    }

    async verifyTwoFactor(challengeToken: string, code: string) {
        const payload = verifyTwoFactorToken(challengeToken) as JwtPayload;

        if (payload.type !== "2fa") {
            throw new AuthFlowError("INVALID_TWO_FACTOR_CHALLENGE");
        }

        const userId = BigInt(payload.userId);
        const config = await this.getTwoFactor(userId);

        if (!config || !config.is_enabled) {
            throw new AuthFlowError("TWO_FACTOR_NOT_ENABLED");
        }

        const result = await verify({
            token: code,
            secret: config.secret,
        });

        if (!result.valid) {
            throw new AuthFlowError("INVALID_OTP");
        }

        const user = await this.usersService.getUserById(userId);

        if (!user) {
            throw new AuthFlowError("USER_NOT_FOUND");
        }

        return this.createSession(user);
    }

    private async createSession(user: CurrentUserSource) {
        const sessionId = crypto.randomUUID();
        const currentUser = await this.toCurrentUser(user);
        const accessToken = createAccessToken(user.id, sessionId);
        const refreshToken = createRefreshToken(user.id, sessionId);

        await this.saveRefreshToken(user.id, refreshToken);
        await this.saveSession(sessionId, currentUser);

        return {
            accessToken,
            refreshToken,
            currentUser,
        };
    }

    private saveSession(sessionId: string, currentUser: CurrentUser) {
        return this.redis.set(
            this.getSessionKey(sessionId),
            JSON.stringify(currentUser),
            SESSION_TTL_SECONDS,
        );
    }

    private deleteSession(sessionId: string) {
        return this.redis.del(this.getSessionKey(sessionId));
    }

    private getSessionKey(sessionId: string): string {
        return `${SESSION_KEY_PREFIX}${sessionId}`;
    }

    private async toCurrentUser(user: CurrentUserSource): Promise<CurrentUser> {
        return {
            id: user.id.toString(),
            email: user.email,
            status: user.status,
            userName: user.user_name,
            firstName: user.first_name,
            lastName: user.last_name,
            avatar: user.avatar?.startsWith("profiles/") ? await this.storage.url(user.avatar, null) : user.avatar,
            createdAt: user.created_at.toISOString(),
            updatedAt: user.updated_at.toISOString(),
        };
    }
}
