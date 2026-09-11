import type { Request, Response } from "express";
import * as userService from "../services/use.service";

export const getUsers = async (req: Request, res: Response) => {
    try {
        const users = await userService.getAllUser();
        res.status(200).json({
            success: true,
            data: users,
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
        const userId = BigInt(id);
        const user = await userService.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        res.status(200).json({
            success: true,
            data: user,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};