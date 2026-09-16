import type { Response } from "express";
import type { AuthRequest } from "../middlewares/auth.middleware.js";
import * as notificationService from "../services/notification.service.js";

export const getNotifications = async (req: AuthRequest, res: Response) => {
    try {
        const notifications = await notificationService.getNotifications(req.userId!);

        const data = notifications.map((notification) => {
            const actor = notification.users_notifications_actor_idTousers;
            return {
                id: notification.id.toString(),
                type: notification.type,
                referenceId: notification.reference_id?.toString() ?? null,
                isRead: notification.is_read,
                createdAt: notification.created_at,
                actor: actor? {
                    ...actor,
                    id: actor.id.toString(),
                } : null,
            };
        });

        return res.status(200).json({
            success: true,
            notifications: data,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const getUnreadCount = async (req: AuthRequest,res: Response) => {
    try {
        const count = await notificationService.getUnreadCount(req.userId!);

        return res.status(200).json({
            success: true,
            unreadCount: count,
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const markAsRead = async (req: AuthRequest,res: Response) => {
    try {
        const id = req.params.id;

        if (!id || Array.isArray(id)) {
            return res.status(400).json({
                success: false,
                message: "Notification id is required",
            });
        }

        const notification = await notificationService.markAsRead(BigInt(id),req.userId!);

        return res.status(200).json({
            success: true,
            message: "Notification marked as read",
            notification: {
                id: notification.id.toString(),
                isRead: notification.is_read,
            },
        });

    } catch (error) {
        if (
            error instanceof Error &&
            error.message === "NOTIFICATION_NOT_FOUND"
        ) {
            return res.status(404).json({
                success: false,
                message: "Notification not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const markAllAsRead = async (req: AuthRequest,res: Response) => {
    try {
        const result = await notificationService.markAllAsRead(req.userId!);

        return res.status(200).json({
            success: true,
            message: "All notifications marked as read",
            updatedCount: result.count,
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message:"Internal server error",
        });
    }
};

export const deleteNotification = async (req: AuthRequest,res: Response) => {
    try {
        const id = req.params.id;

        if (!id || Array.isArray(id)) {
            return res.status(400).json({
                success: false,
                message: "Notification id is required",
            });
        }

        await notificationService.deleteNotification(BigInt(id),req.userId!) 

        return res.status(200).json({
            success: true,
            message: "Notification deleted successfully",
        });

    } catch (error) {

        if (
            error instanceof Error &&
            error.message === "NOTIFICATION_NOT_FOUND"
        ) {
            return res.status(404).json({
                success: false,
                message: "Notification not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};