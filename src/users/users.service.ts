import { Injectable, Logger } from "@nestjs/common";
import type { users_deleted, users_status } from "@prisma/client";
import bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service.js";
import {
    type GraphUser,
    Neo4jUsersRepository,
} from "./neo4j-users.repository.js";
import type { PaginationParams } from "../utils/common.js";

interface UpdateUserData {
    email: string | undefined;
    status: users_status | undefined;
    userName: string | undefined;
    firstName: string | undefined;
    lastName: string | undefined;
    avatar: string | undefined;
}

interface UserGraphSource {
    id: bigint;
    email: string;
    status: users_status;
    user_name: string | null;
    first_name: string | null;
    last_name: string | null;
    avatar: string | null;
    created_at: Date;
    updated_at: Date;
    deleted?: users_deleted;
    deleted_at?: Date | null;
}

@Injectable()
export class UsersService {
    private readonly logger = new Logger(UsersService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly neo4jUsersRepository: Neo4jUsersRepository,
    ) { }

    async getAllUsers(
        pagination?: PaginationParams,
    ) {
        const skip = pagination?.page && pagination.size ? (pagination.page - 1) * pagination.size : undefined;
        const take = pagination?.size ? Number(pagination.size) : undefined;
        const users = await this.prisma.users.findMany({
            where: {
                deleted: "NO",
            },
            select: {
                id: true,
                email: true,
                status: true,
                user_name: true,
                first_name: true,
                last_name: true,
                avatar: true,
                created_at: true,
                updated_at: true,
            },
            orderBy: {
                id: "desc",
            },
            ...(skip !== undefined ? { skip } : {}),
            ...(take !== undefined ? { take } : {}),
        });

        await this.observeGraph("getAllUsers", async () => {
            const graphUserIds = await this.neo4jUsersRepository.findActiveUserIds();
            const missingUserIds = users
                .map((user) => user.id.toString())
                .filter((id) => !graphUserIds.has(id));

            if (missingUserIds.length > 0 || graphUserIds.size !== users.length) {
                this.logger.warn(
                    `User data drift detected: MariaDB=${users.length}, Neo4j=${graphUserIds.size}, missingInNeo4j=${missingUserIds.length}`,
                );
            }
        });

        return users;
    }

    async getUserById(id: bigint) {
        const user = await this.prisma.users.findUnique({
            where: {
                id,
                deleted: "NO",
            },
            select: {
                id: true,
                email: true,
                status: true,
                user_name: true,
                first_name: true,
                last_name: true,
                avatar: true,
                created_at: true,
                updated_at: true,
            },
        });

        await this.observeGraph("getUserById", async () => {
            const graphUserExists =
                await this.neo4jUsersRepository.findActiveUserById(id.toString());

            if (Boolean(user) !== graphUserExists) {
                this.logger.warn(
                    `User data drift detected for user id ${id.toString()}`,
                );
            }
        });

        return user;
    }

    async getUserByEmail(email: string) {
        const user = await this.prisma.users.findUnique({
            where: {
                email,
                deleted: "NO",
            },
        });

        await this.observeGraph("getUserByEmail", async () => {
            const graphUserId =
                await this.neo4jUsersRepository.findActiveUserIdByEmail(email);
            const mariaDbUserId = user?.id.toString() ?? null;

            if (mariaDbUserId !== graphUserId) {
                this.logger.warn("User data drift detected for an email lookup");
            }
        });

        return user;
    }

    async createUser(
        email: string,
        passwordHash: string,
        firstName: string,
        lastName: string,
        userName?: string,
        avatar?: string,
    ) {
        const user = await this.prisma.users.create({
            data: {
                email,
                password_hash: passwordHash,
                status: "active",
                ...(userName && { user_name: userName }),
                ...(firstName && { first_name: firstName }),
                ...(lastName && { last_name: lastName }),
                ...(avatar && { avatar }),
            },
            select: {
                id: true,
                email: true,
                status: true,
                user_name: true,
                first_name: true,
                last_name: true,
                avatar: true,
                created_at: true,
                updated_at: true,
            },
        });

        await this.synchronizeGraph("createUser", user);
        return user;
    }

    async createUserWithPassword(
        email: string,
        password: string,
        firstName: string,
        lastName: string,
        userName?: string,
        avatar?: string,
    ) {
        const passwordHash = await bcrypt.hash(password, 10);
        return this.createUser(
            email,
            passwordHash,
            firstName,
            lastName,
            userName,
            avatar,
        );
    }

    async updateUser(id: bigint, data: UpdateUserData) {
        const updateData = {
            ...(data.email !== undefined && { email: data.email }),
            ...(data.status !== undefined && { status: data.status }),
            ...(data.userName !== undefined && { user_name: data.userName }),
            ...(data.firstName !== undefined && { first_name: data.firstName }),
            ...(data.lastName !== undefined && { last_name: data.lastName }),
            ...(data.avatar !== undefined && { avatar: data.avatar }),
        };

        const user = await this.prisma.users.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                email: true,
                status: true,
                user_name: true,
                first_name: true,
                last_name: true,
                avatar: true,
                created_at: true,
                updated_at: true,
            },
        });

        await this.synchronizeGraph("updateUser", user);
        return user;
    }

    async deleteUser(id: bigint) {
        const user = await this.prisma.users.update({
            where: { id },
            data: {
                deleted: "YES",
                deleted_at: new Date(),
            },
        });

        await this.synchronizeGraph("deleteUser", user);
        return user;
    }

    async syncProfileImage(user: UserGraphSource): Promise<void> {
        await this.synchronizeGraph("profileImage", user);
    }

    private async observeGraph(
        operation: string,
        action: () => Promise<void>,
    ): Promise<void> {
        if (!this.neo4jUsersRepository.isEnabled()) {
            return;
        }

        try {
            await action();
        } catch (error) {
            this.logGraphError(operation, error);
        }
    }

    private async synchronizeGraph(
        operation: string,
        user: UserGraphSource,
    ): Promise<void> {
        if (!this.neo4jUsersRepository.isEnabled()) {
            return;
        }

        try {
            await this.neo4jUsersRepository.upsertUser(this.toGraphUser(user));
        } catch (error) {
            this.logGraphError(operation, error);
        }
    }

    private toGraphUser(user: UserGraphSource): GraphUser {
        return {
            id: user.id.toString(),
            email: user.email,
            status: user.status,
            userName: user.user_name,
            firstName: user.first_name,
            lastName: user.last_name,
            avatar: user.avatar,
            deleted: user.deleted === "YES",
            deletedAt: user.deleted_at?.toISOString() ?? null,
            createdAt: user.created_at.toISOString(),
            updatedAt: user.updated_at.toISOString(),
        };
    }

    private logGraphError(operation: string, error: unknown): void {
        const message = error instanceof Error ? error.message : "Unknown error";
        this.logger.error(
            `Neo4j operation failed during ${operation}; MariaDB remains the source of truth: ${message}`,
        );
    }
}
