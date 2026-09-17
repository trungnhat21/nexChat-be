import { Injectable } from "@nestjs/common";
import type { notifications_type } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class NotificationsService {
    constructor(private readonly prisma: PrismaService) {}

    createNotification(
        userId: bigint,
        actorId: bigint | null,
        type: notifications_type,
        referenceId?: bigint,
    ) {
        return this.prisma.notifications.create({
            data: {
                user_id: userId,
                actor_id: actorId,
                type,
                ...(referenceId !== undefined && {
                    reference_id: referenceId,
                }),
            },
        });
    }

    getNotifications(userId: bigint) {
        return this.prisma.notifications.findMany({
            where: {
                user_id: userId,
            },
            include: {
                users_notifications_actor_idTousers: {
                    select: {
                        id: true,
                        user_name: true,
                        first_name: true,
                        last_name: true,
                        avatar: true,
                    },
                },
            },
            orderBy: {
                created_at: "desc",
            },
            take: 50,
        });
    }

    getUnreadCount(userId: bigint) {
        return this.prisma.notifications.count({
            where: {
                user_id: userId,
                is_read: false,
            },
        });
    }

    async markAsRead(notificationId: bigint, userId: bigint) {
        const notification = await this.prisma.notifications.findFirst({
            where: {
                id: notificationId,
                user_id: userId,
            },
        });

        if (!notification) {
            throw new Error("NOTIFICATION_NOT_FOUND");
        }

        return this.prisma.notifications.update({
            where: {
                id: notification.id,
            },
            data: {
                is_read: true,
            },
        });
    }

    markAllAsRead(userId: bigint) {
        return this.prisma.notifications.updateMany({
            where: {
                user_id: userId,
                is_read: false,
            },
            data: {
                is_read: true,
            },
        });
    }

    async deleteNotification(notificationId: bigint, userId: bigint) {
        const notification = await this.prisma.notifications.findFirst({
            where: {
                id: notificationId,
                user_id: userId,
            },
        });

        if (!notification) {
            throw new Error("NOTIFICATION_NOT_FOUND");
        }

        return this.prisma.notifications.delete({
            where: {
                id: notification.id,
            },
        });
    }
}
