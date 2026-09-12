import type { Request, Response } from "express";
import * as userService from "../services/user.service";
import bcrypt from "bcrypt";

export const getUsers = async (req: Request, res: Response) => {
    try {
        const users = await userService.getAllUser();
        const data = users.map((user) => ({
            ...user,
            id: user.id.toString(),
        }));

        res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const getUser = async (req: Request, res: Response) => {
    try {
        const {id} = req.params;
        if (!id || Array.isArray(id)) {
            return res.status(400).json({
                success: false,
                message: "User ID is required",
            });
        }
        const user = await userService.getUserById(BigInt(id));
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        res.status(200).json({
            success: true,
            data: {
                ...user,
                id: user.id.toString(),
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const createUser = async (req: Request, res: Response) => {
    try {
        const { email, password, firstName, lastName, userName, avatar } = req.body;

        if (!email || !password || !firstName || !lastName) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required",
            });
        }

        const existingUser = await userService.getUserByEmail(email);

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "Email already exists",
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const user = await userService.createUser(
            email,
            passwordHash,
            firstName,
            lastName,
            userName,
            avatar
        );

        return res.status(201).json({
            success: true,
            message: "User created successfully",
            data: {
                ...user,
                id: user.id.toString(),
            },
        });
    } catch (error) {

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const updateUser = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { email, status, firstName, lastName, userName, avatar } = req.body;

        if (!id || Array.isArray(id) || !/^\d+$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID",
            });
        }

        if (
            status !== undefined &&
            !["active", "inactive"].includes(status)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid status",
            });
        }

        const existingUser =
            await userService.getUserById(BigInt(id));

        if (!existingUser) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const user = await userService.updateUser(
            BigInt(id),
            {
                email,
                status,
                firstName,
                lastName,
                userName,
                avatar,
            }
        );

        return res.status(200).json({
            success: true,
            message: "User updated successfully",
            data: {
                ...user,
                id: user.id.toString(),
            },
        });
    } catch (error) {

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const deleteUser = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        if (!id || Array.isArray(id) || !/^\d+$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID",
            });
        }

        const existingUser = await userService.getUserById(BigInt(id));

        if (!existingUser) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        await userService.deleteUser(BigInt(id));

        return res.status(200).json({
            success: true,
            message: "User deleted successfully",
        });
    } catch (error) {

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};