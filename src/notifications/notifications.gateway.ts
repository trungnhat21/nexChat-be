import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection, type OnGatewayDisconnect } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service.js";
import type { JwtPayload } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { verifyAccessToken } from "../utils/token.js";

const HEARTBEAT_TTL_MS = 75_000;
const TYPING_TTL_MS = 5_000;

@WebSocketGateway({ cors: { origin: true, credentials: true } })
@Injectable()
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
    @WebSocketServer() private server!: Server;
    private readonly sessions = new Map<string, Map<string, number>>();
    private readonly typing = new Map<string, Map<string, Map<string, number>>>();
    private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly auth: AuthService, private readonly prisma: PrismaService) {
    }

    onModuleDestroy() {
        for (const timer of this.typingTimers.values()) clearTimeout(timer);
        this.typingTimers.clear();
    }

    async handleConnection(client: Socket) {
        const token: unknown = client.handshake.auth?.token;
        if (typeof token !== "string" || !token) return client.disconnect(true);
        try {
            const payload = verifyAccessToken(token) as JwtPayload;
            if (payload.type !== "access" || !payload.sessionId || !/^\d{1,20}$/.test(payload.userId)) return client.disconnect(true);
            const userId = BigInt(payload.userId);
            if (userId <= 0n || !(await this.auth.getSessionCurrentUser(payload.sessionId, userId))) return client.disconnect(true);
            const key = userId.toString();
            client.data.userId = key;
            client.data.sessionId = payload.sessionId;
            await client.join(this.userRoom(key));
            const sessions = this.sessions.get(key) ?? new Map<string, number>();
            const wasOnline = this.hasActiveSessions(key);
            sessions.set(client.id, Date.now());
            this.sessions.set(key, sessions);
            client.conn.on("heartbeat", () => void this.heartbeat(client));
            client.on("presence:watch", () => void this.sendPresenceSnapshot(client));
            client.on("conversation:open", (data: unknown) => void this.openConversation(client, data));
            client.on("conversation:close", () => this.closeConversation(client));
            client.on("typing:start", (data: unknown) => void this.handleTyping(client, data, true).catch(() => undefined));
            client.on("typing:stop", (data: unknown) => void this.handleTyping(client, data, false).catch(() => undefined));
            client.on("message:delivered", (data: unknown) => void this.markDelivered(client, data).catch(() => undefined));
            client.on("message:read", (data: unknown, acknowledge?: (result: unknown) => void) => {
                void this.markRead(client, data, acknowledge).catch(() => acknowledge?.({ success: false, readIds: [] }));
            });
            if (!wasOnline) await this.emitPresence(key, true);
        } catch {
            client.disconnect(true);
        }
    }

    async handleDisconnect(client: Socket) {
        const userId = this.socketUserId(client);
        if (!userId) return;
        const wasOnline = this.hasActiveSessions(userId);
        const sessions = this.sessions.get(userId);
        sessions?.delete(client.id);
        if (sessions?.size === 0) this.sessions.delete(userId);
        await this.removeSocketTyping(client, userId);
        if (wasOnline && !this.hasActiveSessions(userId)) await this.emitPresence(userId, false);
    }

    isOnline(userId: bigint | string): boolean {
        return this.hasActiveSessions(userId.toString());
    }

    isConversationOpen(userId: bigint | string, conversationId: bigint | string): boolean {
        const sessions = this.sessions.get(userId.toString());
        if (!sessions || !this.server) return false;
        for (const [socketId, lastSeen] of sessions) {
            if (lastSeen <= Date.now() - HEARTBEAT_TTL_MS) continue;
            const socket = this.server.sockets.sockets.get(socketId);
            if (socket?.data.userId === userId.toString() && socket.data.openConversationId === conversationId.toString()) return true;
        }
        return false;
    }

    notifyUser(userId: bigint | string) {
        this.server?.to(this.userRoom(userId)).emit("notification:new");
    }

    notifyMessage(userId: bigint | string, payload: unknown) {
        this.server?.to(this.userRoom(userId)).emit("message:new", payload);
    }

    notifyMessageStatus(userId: bigint | string, payload: unknown) {
        this.server?.to(this.userRoom(userId)).emit("message:status", payload);
    }

    notifyFriendshipAccepted(userA: bigint | string, userB: bigint | string) {
        const idA = userA.toString();
        const idB = userB.toString();
        this.server?.to(this.userRoom(idA)).emit("presence:update", { userId: idB, isOnline: this.hasActiveSessions(idB) });
        this.server?.to(this.userRoom(idB)).emit("presence:update", { userId: idA, isOnline: this.hasActiveSessions(idA) });
    }

    private socketUserId(client: Socket): string | null {
        return typeof client.data.userId === "string" ? client.data.userId : null;
    }

    private hasActiveSessions(userId: string): boolean {
        const sessions = this.sessions.get(userId);
        if (!sessions) return false;
        const cutoff = Date.now() - HEARTBEAT_TTL_MS;
        for (const [socketId, lastSeen] of sessions) {
            if (lastSeen > cutoff) return true;
            sessions.delete(socketId);
        }
        if (sessions.size === 0) this.sessions.delete(userId);
        return false;
    }

    private async heartbeat(client: Socket) {
        const userId = this.socketUserId(client);
        const sessionId = client.data.sessionId;
        if (!userId || typeof sessionId !== "string") return client.disconnect(true);
        try {
            if (!(await this.auth.getSessionCurrentUser(sessionId, BigInt(userId)))) return client.disconnect(true);
            const sessions = this.sessions.get(userId);
            if (!sessions?.has(client.id)) return client.disconnect(true);
            sessions.set(client.id, Date.now());
        } catch {
            client.disconnect(true);
        }
    }

    private async acceptedFriendIds(userId: bigint) {
        const rows = await this.prisma.friendships.findMany({
            where: { status: "accepted", OR: [{ requester_id: userId }, { addressee_id: userId }] },
            select: { requester_id: true, addressee_id: true },
        });
        return rows.map(row => row.requester_id === userId ? row.addressee_id.toString() : row.requester_id.toString());
    }

    private async sendPresenceSnapshot(client: Socket) {
        const userId = this.socketUserId(client);
        if (!userId) return;
        try {
            const friendIds = await this.acceptedFriendIds(BigInt(userId));
            client.emit("presence:snapshot", Object.fromEntries(friendIds.map(id => [id, this.hasActiveSessions(id)])));
        } catch { /* Presence is best-effort and does not interrupt messaging. */ }
    }

    private async emitPresence(userId: string, isOnline: boolean) {
        if (!this.server) return;
        try {
            const friendIds = await this.acceptedFriendIds(BigInt(userId));
            for (const friendId of friendIds) {
                this.server.to(this.userRoom(friendId)).emit("presence:update", { userId, isOnline });
            }
        } catch { /* Presence is best-effort and does not interrupt messaging. */ }
    }

    private async authorizedPeer(userId: bigint, conversationId: bigint): Promise<bigint | null> {
        const conversation = await this.prisma.conversations.findFirst({
            where: { id: conversationId, type: "direct", conversation_members: { some: { user_id: userId, left_at: null } } },
            select: { conversation_members: { where: { left_at: null }, select: { user_id: true } } },
        });
        const members = conversation?.conversation_members ?? [];
        if (members.length !== 2 || !members.some(member => member.user_id === userId)) return null;
        const peer = members.find(member => member.user_id !== userId)?.user_id;
        if (!peer) return null;
        const friendship = await this.prisma.friendships.findFirst({
            where: { status: "accepted", OR: [{ requester_id: userId, addressee_id: peer }, { requester_id: peer, addressee_id: userId }] },
            select: { id: true },
        });
        return friendship ? peer : null;
    }

    private async handleTyping(client: Socket, data: unknown, isTyping: boolean) {
        const userId = this.socketUserId(client);
        const conversationId = this.parseConversationId(data);
        if (!userId || !conversationId) return;
        const peer = await this.authorizedPeer(BigInt(userId), conversationId);
        if (!peer) return;
        const key = conversationId.toString();
        const timerKey = `${key}:${userId}:${client.id}`;
        let users = this.typing.get(key);
        if (!users) { users = new Map(); this.typing.set(key, users); }
        let sockets = users.get(userId);
        if (isTyping) {
            const wasTyping = Boolean(sockets?.size);
            if (!sockets) { sockets = new Map(); users.set(userId, sockets); }
            sockets.set(client.id, Date.now() + TYPING_TTL_MS);
            const previousTimer = this.typingTimers.get(timerKey);
            if (previousTimer) clearTimeout(previousTimer);
            const timer = setTimeout(() => {
                this.typingTimers.delete(timerKey);
                void this.handleTyping(client, { conversationId: key }, false).catch(() => undefined);
            }, TYPING_TTL_MS);
            timer.unref?.();
            this.typingTimers.set(timerKey, timer);
            if (!wasTyping) this.server.to(this.userRoom(peer)).emit("typing:update", { conversationId: key, userId, isTyping: true });
            return;
        }
        const timer = this.typingTimers.get(timerKey);
        if (timer) clearTimeout(timer);
        this.typingTimers.delete(timerKey);
        sockets?.delete(client.id);
        if (sockets?.size === 0) {
            users.delete(userId);
            await this.emitTyping(key, userId, false, peer.toString());
        }
        if (users.size === 0) this.typing.delete(key);
    }

    private closeConversation(client: Socket) {
        client.data.openConversationGeneration = Number(client.data.openConversationGeneration ?? 0) + 1;
        client.data.openConversationId = null;
        client.data.openConversationPromise = null;
    }

    private async openConversation(client: Socket, data: unknown) {
        const userId = this.socketUserId(client);
        const conversationId = this.parseConversationId(data);
        if (!userId || !conversationId) return this.closeConversation(client);
        const generation = Number(client.data.openConversationGeneration ?? 0) + 1;
        client.data.openConversationGeneration = generation;
        client.data.openConversationId = null;
        const result = this.authorizedPeer(BigInt(userId), conversationId).then(peer => {
            if (Number(client.data.openConversationGeneration) === generation && peer) client.data.openConversationId = conversationId.toString();
        }).catch(() => undefined);
        client.data.openConversationPromise = result;
        await result;
    }

    private async markRead(client: Socket, data: unknown, acknowledge?: (result: unknown) => void) {
        const fail = () => acknowledge?.({ success: false, readIds: [] });
        const userIdText = this.socketUserId(client);
        const conversationId = this.parseConversationId(data);
        if (!userIdText || !conversationId || !data || typeof data !== "object" || Array.isArray(data)) return fail();
        const messageIdsValue = (data as Record<string, unknown>).messageIds;
        if (!Array.isArray(messageIdsValue) || messageIdsValue.length > 50 || messageIdsValue.some(id => typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id))) return fail();
        const messageIds = [...new Set(messageIdsValue as string[])].map(id => BigInt(id));
        if (messageIds.some(id => id > 18446744073709551615n)) return fail();
        await client.data.openConversationPromise;
        if (client.data.openConversationId !== conversationId.toString()) return fail();
        const userId = BigInt(userIdText);
        const peer = await this.authorizedPeer(userId, conversationId);
        if (!peer) return fail();
        const visibleMessages = await this.prisma.messages.findMany({
            where: { id: { in: messageIds }, conversation_id: conversationId, sender_id: peer, deleted_at: null },
            select: { id: true },
        });
        if (visibleMessages.length) {
            await this.prisma.message_reads.createMany({
                data: visibleMessages.map(message => ({ message_id: message.id, user_id: userId })),
                skipDuplicates: true,
            });
        }
        const readIds = visibleMessages.map(message => message.id.toString());
        if (readIds.length) {
            const event = { conversationId: conversationId.toString(), messageIds: readIds, status: "read", readAt: new Date().toISOString() };
            this.notifyMessageStatus(peer, event);
            this.notifyMessageStatus(userId, event);
        }
        acknowledge?.({ success: true, readIds });
    }

    private async removeSocketTyping(client: Socket, userId: string) {
        for (const [conversationId, users] of this.typing) {
            const sockets = users.get(userId);
            const timerKey = `${conversationId}:${userId}:${client.id}`;
            const timer = this.typingTimers.get(timerKey);
            if (timer) clearTimeout(timer);
            this.typingTimers.delete(timerKey);
            if (!sockets?.delete(client.id) || sockets.size > 0) continue;
            users.delete(userId);
            const parsedId = BigInt(conversationId);
            const members = await this.prisma.conversation_members.findMany({ where: { conversation_id: parsedId, left_at: null }, select: { user_id: true } });
            const peer = members.find(member => member.user_id.toString() !== userId)?.user_id.toString();
            await this.emitTyping(conversationId, userId, false, peer);
            if (users.size === 0) this.typing.delete(conversationId);
        }
    }

    private async emitTyping(conversationId: string, userId: string, isTyping: boolean, peerId?: string) {
        let target = peerId;
        if (!target) {
            const members = await this.prisma.conversation_members.findMany({ where: { conversation_id: BigInt(conversationId), left_at: null }, select: { user_id: true } });
            target = members.find(member => member.user_id.toString() !== userId)?.user_id.toString();
        }
        if (target) this.server?.to(this.userRoom(target)).emit("typing:update", { conversationId, userId, isTyping });
    }

    private parseConversationId(data: unknown): bigint | null {
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;
        const value = (data as Record<string, unknown>).conversationId;
        if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) return null;
        const id = BigInt(value);
        return id <= 18446744073709551615n ? id : null;
    }

    private async markDelivered(client: Socket, data: unknown) {
        const userIdText = this.socketUserId(client);
        const conversationId = this.parseConversationId(data);
        if (!userIdText || !conversationId || !data || typeof data !== "object") return;
        const messageIdValue = (data as Record<string, unknown>).messageId;
        if (typeof messageIdValue !== "string" || !/^[1-9]\d{0,19}$/.test(messageIdValue)) return;
        const messageId = BigInt(messageIdValue);
        if (messageId > 18446744073709551615n) return;
        const userId = BigInt(userIdText);
        const peer = await this.authorizedPeer(userId, conversationId);
        if (!peer) return;
        const message = await this.prisma.messages.findFirst({
            where: { id: messageId, conversation_id: conversationId, sender_id: peer, deleted_at: null },
            select: { id: true, delivered_at: true },
        });
        if (!message || message.delivered_at) return;
        const deliveredAt = new Date();
        const updated = await this.prisma.messages.updateMany({
            where: { id: messageId, conversation_id: conversationId, sender_id: peer, delivered_at: null },
            data: { delivered_at: deliveredAt },
        });
        if (updated.count) this.notifyMessageStatus(peer, { conversationId: conversationId.toString(), messageId: messageId.toString(), status: "delivered", deliveredAt: deliveredAt.toISOString() });
    }

    private userRoom(userId: bigint | string) {
        return `user:${userId.toString()}`;
    }
}
