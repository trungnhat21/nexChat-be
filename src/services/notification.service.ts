import prisma from "../configs/prisma.js";
import type { notifications_type } from "@prisma/client";

export const createNotification = async (userId: bigint, actorId: bigint | null, type: notifications_type, referenceId?: bigint) => {
    return prisma.notifications.create({
        data: {
            user_id: userId,
            actor_id: actorId,
            type,
            ...(referenceId !== undefined && {
            reference_id: referenceId,
            }),
        },
    });
};

export const getNotifications = async (userId: bigint) => {
    return prisma.notifications.findMany({
        where: { user_id: userId },
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
};

export const getUnreadCount = async (userId: bigint) => {
    return prisma.notifications.count({
        where: {
            user_id: userId,
            is_read: false,
        },
    });
};

export const markAsRead = async (notificationId: bigint, userId: bigint) => {
    const notification = await prisma.notifications.findFirst({
        where: {
            id: notificationId,
            user_id: userId,
        },
    });

    if (!notification) {
        throw new Error("NOTIFICATION_NOT_FOUND");
    }

    return prisma.notifications.update({
        where: {id: notification.id,},
        data: {is_read: true,},
    });
};

export const markAllAsRead = async (userId: bigint) => {
    return prisma.notifications.updateMany({
        where: {
            user_id: userId,
            is_read: false
        },
        data: {
            is_read: true,
        },
    });
};

export const deleteNotification = async (notificationId: bigint, userId: bigint) => {
    const notification = await prisma.notifications.findFirst({
        where: {
            id: notificationId,
            user_id: userId,
        },
    });

    if (!notification) {
        throw new Error("NOTIFICATION_NOT_FOUND");
    }

    return prisma.notifications.delete({
        where: {id: notification.id,},
    });
};