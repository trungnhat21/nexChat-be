import { Injectable } from "@nestjs/common";
import type { users_status } from "@prisma/client";
import bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service.js";

interface UpdateUserData {
    email: string | undefined;
    status: users_status | undefined;
    userName: string | undefined;
    firstName: string | undefined;
    lastName: string | undefined;
    avatar: string | undefined;
}

@Injectable()
export class UsersService {
    constructor(private readonly prisma: PrismaService) {}

    getAllUsers() {
        return this.prisma.users.findMany({
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
        });
    }

    getUserById(id: bigint) {
        return this.prisma.users.findUnique({
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
    }

    getUserByEmail(email: string) {
        return this.prisma.users.findUnique({
            where: {
                email,
                deleted: "NO",
            },
        });
    }

    createUser(
        email: string,
        passwordHash: string,
        firstName: string,
        lastName: string,
        userName?: string,
        avatar?: string,
    ) {
        return this.prisma.users.create({
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

    updateUser(id: bigint, data: UpdateUserData) {
        const updateData = {
            ...(data.email !== undefined && { email: data.email }),
            ...(data.status !== undefined && { status: data.status }),
            ...(data.userName !== undefined && { user_name: data.userName }),
            ...(data.firstName !== undefined && { first_name: data.firstName }),
            ...(data.lastName !== undefined && { last_name: data.lastName }),
            ...(data.avatar !== undefined && { avatar: data.avatar }),
        };

        return this.prisma.users.update({
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
    }

    deleteUser(id: bigint) {
        return this.prisma.users.update({
            where: { id },
            data: {
                deleted: "YES",
                deleted_at: new Date(),
            },
        });
    }
}
