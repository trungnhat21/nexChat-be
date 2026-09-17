import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Res,
} from "@nestjs/common";
import type { users_status } from "@prisma/client";
import type { Response } from "express";
import { UsersService } from "./users.service.js";

interface CreateUserBody {
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    userName?: string;
    avatar?: string;
}

interface UpdateUserBody {
    email?: string;
    status?: string;
    firstName?: string;
    lastName?: string;
    userName?: string;
    avatar?: string;
}

@Controller("api/users")
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Get()
    async getUsers(@Res() response: Response): Promise<Response> {
        try {
            const users = await this.usersService.getAllUsers();
            const data = users.map((user) => ({
                ...user,
                id: user.id.toString(),
            }));

            return response.status(200).json({
                success: true,
                data,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Get(":id")
    async getUser(
        @Param("id") id: string,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            if (!id) {
                return response.status(400).json({
                    success: false,
                    message: "User ID is required",
                });
            }

            const user = await this.usersService.getUserById(BigInt(id));

            if (!user) {
                return response.status(404).json({
                    success: false,
                    message: "User not found",
                });
            }

            return response.status(200).json({
                success: true,
                data: {
                    ...user,
                    id: user.id.toString(),
                },
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Post()
    async createUser(
        @Body() body: CreateUserBody,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const { email, password, firstName, lastName, userName, avatar } = body;

            if (!email || !password || !firstName || !lastName) {
                return response.status(400).json({
                    success: false,
                    message: "Email and password are required",
                });
            }

            const existingUser = await this.usersService.getUserByEmail(email);

            if (existingUser) {
                return response.status(409).json({
                    success: false,
                    message: "Email already exists",
                });
            }

            const user = await this.usersService.createUserWithPassword(
                email,
                password,
                firstName,
                lastName,
                userName,
                avatar,
            );

            return response.status(201).json({
                success: true,
                message: "User created successfully",
                data: {
                    ...user,
                    id: user.id.toString(),
                },
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Patch(":id")
    async updateUser(
        @Param("id") id: string,
        @Body() body: UpdateUserBody,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const { email, status, firstName, lastName, userName, avatar } = body;

            if (!id || !/^\d+$/.test(id)) {
                return response.status(400).json({
                    success: false,
                    message: "Invalid user ID",
                });
            }

            if (status !== undefined && !["active", "inactive"].includes(status)) {
                return response.status(400).json({
                    success: false,
                    message: "Invalid status",
                });
            }

            let normalizedStatus: users_status | undefined;

            if (status === "active" || status === "inactive") {
                normalizedStatus = status;
            }

            const existingUser = await this.usersService.getUserById(BigInt(id));

            if (!existingUser) {
                return response.status(404).json({
                    success: false,
                    message: "User not found",
                });
            }

            const user = await this.usersService.updateUser(BigInt(id), {
                email,
                status: normalizedStatus,
                firstName,
                lastName,
                userName,
                avatar,
            });

            return response.status(200).json({
                success: true,
                message: "User updated successfully",
                data: {
                    ...user,
                    id: user.id.toString(),
                },
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Delete(":id")
    async deleteUser(
        @Param("id") id: string,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            if (!id || !/^\d+$/.test(id)) {
                return response.status(400).json({
                    success: false,
                    message: "Invalid user ID",
                });
            }

            const existingUser = await this.usersService.getUserById(BigInt(id));

            if (!existingUser) {
                return response.status(404).json({
                    success: false,
                    message: "User not found",
                });
            }

            await this.usersService.deleteUser(BigInt(id));

            return response.status(200).json({
                success: true,
                message: "User deleted successfully",
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }
}
