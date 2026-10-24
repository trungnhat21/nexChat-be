import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { PostStorageService } from "../posts/post-storage.service.js";
import { NotificationsGateway } from "../notifications/notifications.gateway.js";

const personSelect = {
    id: true,
    user_name: true,
    first_name: true,
    last_name: true,
    avatar: true,
    status: true,
    deleted: true,
    profiles: { select: { display_name: true, avatar_url: true } },
} as const;
const messageInclude = {
    users: { select: personSelect },
    message_reads: { select: { user_id: true } },
} as const;
const conversationInclude = {
    conversation_members: {
        where: { left_at: null },
        include: { users: { select: personSelect } },
    },
    messages: {
        where: { deleted_at: null },
        orderBy: { id: "desc" },
        take: 1,
        include: messageInclude,
    },
} as const;

type Person = Prisma.usersGetPayload<{ select: typeof personSelect }>;
type MessageRow = Prisma.messagesGetPayload<{ include: typeof messageInclude }>;
type ConversationRow = Prisma.conversationsGetPayload<{ include: typeof conversationInclude }>;

@Injectable()
export class MessagingService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: PostStorageService,
        private readonly gateway: NotificationsGateway,
    ) {}

    private async person(user: Person) {
        const avatar = user.profiles?.avatar_url || user.avatar;
        return {
            id: user.id.toString(),
            name: user.profiles?.display_name || [user.last_name, user.first_name].filter(Boolean).join(" ") || user.user_name || "Người dùng",
            avatar: avatar?.startsWith("profiles/") ? await this.storage.url(avatar, null) : avatar,
        };
    }

    private async message(row: MessageRow, viewerId: bigint) {
        return {
            id: row.id.toString(),
            conversationId: row.conversation_id.toString(),
            clientMessageId: row.client_message_id,
            content: row.content ?? "",
            createdAt: row.created_at.toISOString(),
            isMine: row.sender_id === viewerId,
            isRead: row.message_reads.some(read => read.user_id === viewerId),
            status: row.sender_id !== viewerId ? null : row.message_reads.some(read => read.user_id !== viewerId) ? "read" : row.delivered_at ? "delivered" : "sent",
            sender: row.users ? await this.person(row.users) : null,
        };
    }

    async listConversations(userId: bigint) {
        const rows: ConversationRow[] = await this.prisma.conversations.findMany({
            where: { type: "direct", conversation_members: { some: { user_id: userId, left_at: null } } },
            orderBy: [{ updated_at: "desc" }, { id: "desc" }],
            include: conversationInclude,
        });
        const ids = rows.map(row => row.id);
        const unreadRows = ids.length ? await this.prisma.messages.groupBy({
            by: ["conversation_id"],
            where: {
                conversation_id: { in: ids },
                deleted_at: null,
                sender_id: { not: userId },
                message_reads: { none: { user_id: userId } },
            },
            _count: { _all: true },
        }) : [];
        const unread = new Map(unreadRows.map(row => [row.conversation_id.toString(), row._count._all]));
        const conversations = await Promise.all(rows.map(async row => {
            if (row.conversation_members.length !== 2) return null;
            const other = row.conversation_members.find(member => member.user_id !== userId)?.users;
            if (!other || other.status !== "active" || other.deleted !== "NO") return null;
            const last = row.messages[0];
            return {
                id: row.id.toString(),
                participant: { ...await this.person(other), online: this.gateway.isOnline(other.id) },
                lastMessage: last ? await this.message(last, userId) : null,
                updatedAt: (last?.created_at ?? row.updated_at).toISOString(),
                unreadCount: unread.get(row.id.toString()) ?? 0,
            };
        }));
        const result = conversations.filter((row): row is NonNullable<typeof row> => row !== null);
        result.sort((a, b) => {
            if (a.lastMessage && b.lastMessage) {
                const left = BigInt(a.lastMessage.id);
                const right = BigInt(b.lastMessage.id);
                if (left !== right) return left > right ? -1 : 1;
            } else if (a.lastMessage || b.lastMessage) {
                return a.lastMessage ? -1 : 1;
            }
            const timeDifference = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
            if (timeDifference) return timeDifference;
            const left = BigInt(a.id);
            const right = BigInt(b.id);
            return left === right ? 0 : left > right ? -1 : 1;
        });
        return { success: true, conversations: result };
    }

    async getOrCreateDirect(userId: bigint, recipientId: bigint) {
        if (userId === recipientId) throw new ForbiddenException("Bạn không thể tạo cuộc trò chuyện với chính mình.");
        const low = userId < recipientId ? userId : recipientId;
        const high = userId < recipientId ? recipientId : userId;

        let result: { id: bigint; reused: boolean };
        try {
            result = await this.prisma.$transaction(async tx => {
                const sender = await tx.users.findFirst({ where: { id: userId, status: "active", deleted: "NO" }, select: { id: true } });
                if (!sender) throw new NotFoundException("Tài khoản không tồn tại.");
                const recipient = await tx.users.findFirst({ where: { id: recipientId, status: "active", deleted: "NO" }, select: { id: true } });
                if (!recipient) throw new NotFoundException("Không tìm thấy người nhận.");
                const friendship = await tx.friendships.findFirst({
                    where: { status: "accepted", OR: [
                        { requester_id: userId, addressee_id: recipientId },
                        { requester_id: recipientId, addressee_id: userId },
                    ] }, select: { id: true },
                });
                if (!friendship) throw new ForbiddenException("Only accepted friends can message each other.");
                const blocked = await tx.friendships.findFirst({
                    where: { status: "blocked", OR: [
                        { requester_id: userId, addressee_id: recipientId },
                        { requester_id: recipientId, addressee_id: userId },
                    ] }, select: { id: true },
                });
                if (blocked) throw new ForbiddenException("Không thể nhắn tin do quan hệ tài khoản bị chặn.");
                const existing = await tx.conversations.findUnique({
                    where: { direct_user_low_id_direct_user_high_id: { direct_user_low_id: low, direct_user_high_id: high } },
                    select: { id: true },
                });
                if (existing) return { id: existing.id, reused: true };
                const conversation = await tx.conversations.create({
                    data: {
                        type: "direct",
                        created_by: userId,
                        direct_user_low_id: low,
                        direct_user_high_id: high,
                        conversation_members: { create: [{ user_id: userId }, { user_id: recipientId }] },
                    },
                    select: { id: true },
                });
                return { id: conversation.id, reused: false };
            }, { maxWait: 15000, timeout: 15000 });
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
            const raced = await this.prisma.conversations.findUnique({
                where: { direct_user_low_id_direct_user_high_id: { direct_user_low_id: low, direct_user_high_id: high } },
                select: { id: true },
            });
            if (!raced) throw error;
            result = { id: raced.id, reused: true };
        }
        return { success: true, conversationId: result.id.toString(), reused: result.reused };
    }

    private async requireMember(tx: Prisma.TransactionClient, conversationId: bigint, userId: bigint) {
        const conversation = await tx.conversations.findFirst({ where: { id: conversationId, type: "direct" }, select: { id: true } });
        if (!conversation) throw new NotFoundException("Không tìm thấy cuộc trò chuyện.");
        const members = await tx.conversation_members.findMany({
            where: { conversation_id: conversationId, left_at: null },
            select: { user_id: true },
        });
        if (members.length !== 2 || !members.some(member => member.user_id === userId)) throw new NotFoundException("Không tìm thấy cuộc trò chuyện.");
        const otherId = members.find(member => member.user_id !== userId)?.user_id;
        if (!otherId) throw new NotFoundException("Không tìm thấy cuộc trò chuyện.");
        const otherUser = await tx.users.findFirst({ where: { id: otherId, status: "active", deleted: "NO" }, select: { id: true } });
        if (!otherUser) throw new NotFoundException("Không tìm thấy cuộc trò chuyện.");
        const friendship = await tx.friendships.findFirst({
            where: { status: "accepted", OR: [
                { requester_id: userId, addressee_id: otherId },
                { requester_id: otherId, addressee_id: userId },
            ] }, select: { id: true },
        });
        if (!friendship) throw new ForbiddenException("Only accepted friends can message each other.");
        const blocked = await tx.friendships.findFirst({
            where: { status: "blocked", OR: [
                { requester_id: userId, addressee_id: otherId },
                { requester_id: otherId, addressee_id: userId },
            ] },
            select: { id: true },
        });
        if (blocked) throw new ForbiddenException("Không thể truy cập cuộc trò chuyện do quan hệ tài khoản bị chặn.");
    }

    async listMessages(userId: bigint, conversationId: bigint, before: bigint | undefined, limit: number) {
        const rows = await this.prisma.$transaction(async tx => {
            await this.requireMember(tx, conversationId, userId);
            const messages = await tx.messages.findMany({
                where: { conversation_id: conversationId, deleted_at: null, ...(before !== undefined ? { id: { lt: before } } : {}) },
                orderBy: { id: "desc" },
                take: limit + 1,
                include: messageInclude,
            });
            return messages;
        }, { maxWait: 15000, timeout: 15000 });

        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const messages = await Promise.all(page.reverse().map(row => this.message(row, userId)));
        return { success: true, messages, hasMore, nextCursor: hasMore ? page[0]?.id.toString() ?? null : null };
    }

    private async markMessagesRead(tx: Prisma.TransactionClient, conversationId: bigint, userId: bigint, messageIds: bigint[]) {
        if (messageIds.length === 0) return [];
        const incoming = await tx.messages.findMany({
            where: { conversation_id: conversationId, id: { in: messageIds }, deleted_at: null, sender_id: { not: userId } },
            select: { id: true, sender_id: true },
        });
        if (incoming.length) await tx.message_reads.createMany({
            data: incoming.map(message => ({ message_id: message.id, user_id: userId })),
            skipDuplicates: true,
        });
        return incoming;
    }

    async markConversationRead(userId: bigint, conversationId: bigint, messageIds: bigint[]) {
        if (!this.gateway.isConversationOpen(userId, conversationId)) throw new ForbiddenException("The conversation must be open before messages can be marked read.");
        const messages = await this.prisma.$transaction(async tx => {
            await this.requireMember(tx, conversationId, userId);
            return this.markMessagesRead(tx, conversationId, userId, messageIds);
        }, { maxWait: 15000, timeout: 15000 });
        this.gateway.notifyMessageStatus(userId, {
            conversationId: conversationId.toString(),
            messageIds: messages.map(message => message.id.toString()),
            status: "read",
            readAt: new Date().toISOString(),
        });
        const senders = new Set(messages.map(message => message.sender_id?.toString()).filter((id): id is string => Boolean(id)));
        for (const senderId of senders) this.gateway.notifyMessageStatus(senderId, {
            conversationId: conversationId.toString(),
            messageIds: messages.filter(message => message.sender_id?.toString() === senderId).map(message => message.id.toString()),
            status: "read",
            readAt: new Date().toISOString(),
        });
        return { success: true, readIds: messages.map(message => message.id.toString()) };
    }

    async sendMessage(userId: bigint, conversationId: bigint, content: string, clientMessageId: string) {
        const key = { conversation_id: conversationId, sender_id: userId, client_message_id: clientMessageId };
        let row: MessageRow;
        try {
            row = await this.prisma.$transaction(async tx => {
                await this.requireMember(tx, conversationId, userId);
                const existing = await tx.messages.findUnique({ where: { conversation_id_sender_id_client_message_id: key }, include: messageInclude });
                if (existing) {
                    if (existing.content !== content) throw new ConflictException("Mã gửi lại đã được dùng cho nội dung khác.");
                    return existing;
                }
                const created = await tx.messages.create({
                    data: { conversation_id: conversationId, sender_id: userId, content, message_type: "text", client_message_id: clientMessageId },
                    include: messageInclude,
                });
                await tx.conversations.update({ where: { id: conversationId }, data: { updated_at: new Date() } });
                return created;
            }, { maxWait: 15000, timeout: 15000 });
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
            const existing = await this.prisma.messages.findUnique({ where: { conversation_id_sender_id_client_message_id: key }, include: messageInclude });
            if (!existing) throw error;
            if (existing.content !== content) throw new ConflictException("Mã gửi lại đã được dùng cho nội dung khác.");
            row = existing;
        }

        const message = await this.message(row, userId);
        const members = await this.prisma.conversation_members.findMany({
            where: { conversation_id: conversationId, left_at: null }, select: { user_id: true },
        });
        const payload = { conversationId: conversationId.toString(), message };
        for (const member of members) this.gateway.notifyMessage(member.user_id, payload);
        return { success: true, message };
    }
}
