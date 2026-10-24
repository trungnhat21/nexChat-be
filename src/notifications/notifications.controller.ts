import {
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Req,
    Res,
    UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { NotificationsService } from "./notifications.service.js";

function parseNotificationId(value: string): bigint | null {
    if (!/^[1-9]\d{0,19}$/.test(value)) return null;
    const id = BigInt(value);
    return id <= 18446744073709551615n ? id : null;
}

@Controller("api/notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
    constructor(private readonly notificationsService: NotificationsService) {}

    @Get()
    async getNotifications(
        @Req() request: AuthenticatedRequest,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const [notifications, unreadCount] = await Promise.all([
                this.notificationsService.getNotifications(request.userId!),
                this.notificationsService.getUnreadCount(request.userId!),
            ]);
            const data = notifications.map((notification) => {
                const actor = notification.users_notifications_actor_idTousers;
                return {
                    id: notification.id.toString(),
                    type: notification.type,
                    referenceId: notification.reference_id?.toString() ?? null,
                    isRead: notification.is_read,
                    createdAt: notification.created_at,
                    actor: actor
                        ? {
                            ...actor,
                            id: actor.id.toString(),
                        }
                        : null,
                };
            });

            return response.status(200).json({
                success: true,
                notifications: data,
                unreadCount,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Get("unread-count")
    async getUnreadCount(
        @Req() request: AuthenticatedRequest,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const count = await this.notificationsService.getUnreadCount(request.userId!);

            return response.status(200).json({
                success: true,
                unreadCount: count,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Patch("read-all")
    async markAllAsRead(
        @Req() request: AuthenticatedRequest,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const result = await this.notificationsService.markAllAsRead(request.userId!);

            return response.status(200).json({
                success: true,
                message: "All notifications marked as read",
                updatedCount: result.count,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Patch(":id/read")
    async markAsRead(
        @Req() request: AuthenticatedRequest,
        @Param("id") id: string,
        @Res() response: Response,
    ): Promise<Response> {
        const notificationId = parseNotificationId(id);
        if (notificationId === null) {
            return response.status(400).json({
                success: false,
                message: "Notification id is required",
            });
        }

        try {
            const notification = await this.notificationsService.markAsRead(
                notificationId,
                request.userId!,
            );

            return response.status(200).json({
                success: true,
                message: "Notification marked as read",
                notification: {
                    id: notification.id.toString(),
                    isRead: notification.is_read,
                },
            });
        } catch (error) {
            if (error instanceof Error && error.message === "NOTIFICATION_NOT_FOUND") {
                return response.status(404).json({
                    success: false,
                    message: "Notification not found",
                });
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Delete(":id")
    async deleteNotification(
        @Req() request: AuthenticatedRequest,
        @Param("id") id: string,
        @Res() response: Response,
    ): Promise<Response> {
        const notificationId = parseNotificationId(id);
        if (notificationId === null) {
            return response.status(400).json({
                success: false,
                message: "Notification id is required",
            });
        }

        try {
            await this.notificationsService.deleteNotification(
                notificationId,
                request.userId!,
            );

            return response.status(200).json({
                success: true,
                message: "Notification deleted successfully",
            });
        } catch (error) {
            if (error instanceof Error && error.message === "NOTIFICATION_NOT_FOUND") {
                return response.status(404).json({
                    success: false,
                    message: "Notification not found",
                });
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }
}
