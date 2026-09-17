import { Injectable } from "@nestjs/common";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { PrismaService } from "../prisma/prisma.service.js";
import { UsersService } from "../users/users.service.js";
import {
    createAccessToken,
    createRefreshToken,
    createTwoFactorToken,
    verifyRefreshToken,
    verifyTwoFactorToken,
} from "../utils/token.js";
import type { JwtPayload } from "./auth.types.js";

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
    };

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly usersService: UsersService,
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

        const accessToken = createAccessToken(user.id);
        const refreshToken = createRefreshToken(user.id);
        await this.saveRefreshToken(user.id, refreshToken);

        return {
            kind: "authenticated",
            accessToken,
            refreshToken,
        };
    }

    async refresh(refreshToken: string) {
        const payload = verifyRefreshToken(refreshToken) as JwtPayload;

        if (payload.type !== "refresh") {
            throw new AuthFlowError("INVALID_REFRESH_TOKEN");
        }

        const savedToken = await this.findRefreshToken(refreshToken);

        if (!savedToken) {
            throw new AuthFlowError("REFRESH_TOKEN_NOT_FOUND");
        }

        const user = await this.usersService.getUserById(BigInt(payload.userId));

        if (!user) {
            throw new AuthFlowError("USER_NOT_FOUND");
        }

        return {
            accessToken: createAccessToken(user.id),
            user,
        };
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

        const accessToken = createAccessToken(userId);
        const refreshToken = createRefreshToken(userId);
        await this.saveRefreshToken(userId, refreshToken);

        return {
            accessToken,
            refreshToken,
        };
    }
}
