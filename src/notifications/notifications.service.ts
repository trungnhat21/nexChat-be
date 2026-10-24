import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { notifications_type, posts_privacy } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { NotificationsGateway } from "./notifications.gateway.js";

const READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
    private cleanupTimer?: ReturnType<typeof setInterval>;

    constructor(private readonly prisma: PrismaService, private readonly gateway: NotificationsGateway) {}

    onModuleInit() {
        void this.purgeExpiredReadNotifications().catch(() => undefined);
        this.cleanupTimer = setInterval(() => void this.purgeExpiredReadNotifications().catch(() => undefined), 60 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }

    onModuleDestroy() {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    }

    private readCutoff() {
        return new Date(Date.now() - READ_RETENTION_MS);
    }

    purgeExpiredReadNotifications() {
        return this.prisma.notifications.deleteMany({
            where: { is_read: true, read_at: { lte: this.readCutoff() } },
        });
    }

    async createNotification(userId: bigint, actorId: bigint | null, type: notifications_type, referenceId?: bigint) {
        const notification = await this.prisma.notifications.create({
            data: { user_id: userId, actor_id: actorId, type, ...(referenceId !== undefined ? { reference_id: referenceId } : {}) },
        });
        this.gateway.notifyUser(userId);
        return notification;
    }

    async notifyPostPublished(authorId: bigint, postId: bigint, privacy: posts_privacy) {
        if (privacy === "private") return;
        const [followers, friendships] = await Promise.all([
            privacy === "public" ? this.prisma.follows.findMany({ where: { following_id: authorId }, select: { follower_id: true } }) : [],
            this.prisma.friendships.findMany({ where: { status: "accepted", OR: [{ requester_id: authorId }, { addressee_id: authorId }] }, select: { requester_id: true, addressee_id: true } }),
        ]);
        const recipients = new Set<string>();
        for (const follow of followers) if (follow.follower_id !== authorId) recipients.add(follow.follower_id.toString());
        for (const friendship of friendships) {
            const friendId = friendship.requester_id === authorId ? friendship.addressee_id : friendship.requester_id;
            if (friendId !== authorId) recipients.add(friendId.toString());
        }
        if (!recipients.size) return;
        await this.prisma.notifications.createMany({ data: [...recipients].map(recipient => ({
            user_id: BigInt(recipient), actor_id: authorId, type: "new_post" as const, reference_id: postId,
        })) });
        for (const recipient of recipients) this.gateway.notifyUser(recipient);
    }

    emitCreated(userId: bigint) {
        this.gateway.notifyUser(userId);
    }

    notifyFriendshipAccepted(userA: bigint, userB: bigint) {
        this.gateway.notifyFriendshipAccepted(userA, userB);
    }

    getNotifications(userId: bigint) {
        return this.prisma.notifications.findMany({
            where: { user_id: userId, OR: [{ is_read: false }, { is_read: true, read_at: { gt: this.readCutoff() } }] },
            include: {
                users_notifications_actor_idTousers: {
                    select: { id: true, user_name: true, first_name: true, last_name: true, avatar: true },
                },
            },
            orderBy: { created_at: "desc" },
        });
    }

    getUnreadCount(userId: bigint) {
        return this.prisma.notifications.count({ where: { user_id: userId, is_read: false } });
    }

    async markAsRead(notificationId: bigint, userId: bigint) {
        const updated = await this.prisma.notifications.updateMany({
            where: { id: notificationId, user_id: userId, is_read: false },
            data: { is_read: true, read_at: new Date() },
        });
        if (updated.count) return this.prisma.notifications.findUniqueOrThrow({ where: { id: notificationId } });
        const notification = await this.prisma.notifications.findFirst({ where: { id: notificationId, user_id: userId } });
        if (!notification) throw new Error("NOTIFICATION_NOT_FOUND");
        return notification;
    }

    markAllAsRead(userId: bigint) {
        return this.prisma.notifications.updateMany({
            where: { user_id: userId, is_read: false },
            data: { is_read: true, read_at: new Date() },
        });
    }

    async deleteNotification(notificationId: bigint, userId: bigint) {
        const result = await this.prisma.notifications.deleteMany({ where: { id: notificationId, user_id: userId } });
        if (!result.count) throw new Error("NOTIFICATION_NOT_FOUND");
    }
}
