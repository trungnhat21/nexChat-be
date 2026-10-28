import {
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    type OnModuleDestroy,
    type OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import { LiveKitService } from "../livekit/livekit.service.js";
import { NotificationsGateway } from "../notifications/notifications.gateway.js";
import { RecordingsService } from "../recordings/recordings.service.js";
import { PostStorageService } from "../posts/post-storage.service.js";

const ACTIVE_STATUSES = ["ringing", "accepted"] as const;
const RING_TIMEOUT_MS = 30_000;
const RING_TIMEOUT_RETRY_MS = 3_000;
const callInclude = {
    call_participants: {
        include: {
            users: {
                select: { id: true, user_name: true, first_name: true, last_name: true, avatar: true, profiles: { select: { display_name: true, avatar_url: true } } },
            },
        },
        orderBy: { role: "asc" as const },
    },
};
type CallRow = Prisma.call_sessionsGetPayload<{ include: typeof callInclude }>;

function callDuration(startedAt: Date, endedAt: Date): string {
    const total = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
    const seconds = total % 60;
    const minutesTotal = Math.floor(total / 60);
    const minutes = minutesTotal % 60;
    const hours = Math.floor(minutesTotal / 60);
    if (hours) return `${hours} giờ ${String(minutes).padStart(2, "0")} phút ${String(seconds).padStart(2, "0")} giây`;
    if (minutesTotal) return `${minutesTotal} phút ${String(seconds).padStart(2, "0")} giây`;
    return `${seconds} giây`;
}

async function persistCallActivity(tx: Prisma.TransactionClient, call: {
    id: bigint; conversation_id: bigint; initiated_by: bigint; call_type: "audio" | "video";
    accepted_at: Date | null; ended_at: Date | null; end_reason: string | null;
}) {
    if (!call.ended_at || !call.end_reason) return;
    const label = call.call_type === "video" ? "Cuộc gọi video" : "Cuộc gọi thoại";
    let content: string;
    if (call.end_reason === "declined") content = `${label} bị từ chối`;
    else if (call.end_reason === "cancelled") content = `${label} đã được người gọi hủy`;
    else if (call.end_reason === "timeout") content = `${label} nhỡ · Không được trả lời`;
    else if (call.end_reason === "ended" && call.accepted_at) content = `${label} · ${callDuration(call.accepted_at, call.ended_at)}`;
    else return;

    await tx.messages.createMany({
        data: [{ conversation_id: call.conversation_id, sender_id: call.initiated_by, content, message_type: "system", client_message_id: `call-${call.id}-activity`, created_at: call.ended_at }],
        skipDuplicates: true,
    });
    await tx.conversations.update({ where: { id: call.conversation_id }, data: { updated_at: call.ended_at } });
}

@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
    private readonly ringingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private shuttingDown = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly livekit: LiveKitService,
        private readonly notifications: NotificationsGateway,
        private readonly recordings: RecordingsService,
        private readonly storage: PostStorageService,
    ) {}

    async onModuleInit(): Promise<void> {
        const ringing = await this.prisma.call_sessions.findMany({
            where: { status: "ringing" },
            select: { id: true, created_at: true },
        });
        for (const call of ringing) this.scheduleRingingTimeout(call.id, call.created_at);
    }

    onModuleDestroy(): void {
        this.shuttingDown = true;
        for (const timer of this.ringingTimers.values()) clearTimeout(timer);
        this.ringingTimers.clear();
    }

    private scheduleRingingTimeout(callId: bigint, createdAt: Date): void {
        const key = callId.toString();
        const previous = this.ringingTimers.get(key);
        if (previous) clearTimeout(previous);
        const remaining = Math.max(0, createdAt.getTime() + RING_TIMEOUT_MS - Date.now());
        const timer = setTimeout(() => void this.expireRingingCall(callId), remaining);
        timer.unref?.();
        this.ringingTimers.set(key, timer);
    }

    private retryRingingTimeout(callId: bigint): void {
        if (this.shuttingDown) return;
        const key = callId.toString();
        const previous = this.ringingTimers.get(key);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => void this.expireRingingCall(callId), RING_TIMEOUT_RETRY_MS);
        timer.unref?.();
        this.ringingTimers.set(key, timer);
    }

    private clearRingingTimeout(callId: bigint): void {
        const key = callId.toString();
        const timer = this.ringingTimers.get(key);
        if (timer) clearTimeout(timer);
        this.ringingTimers.delete(key);
    }

    private async expireRingingCall(callId: bigint): Promise<void> {
        const key = callId.toString();
        this.ringingTimers.delete(key);
        if (this.shuttingDown) return;
        try {
            const outcome = await this.prisma.$transaction(async tx => {
                await tx.$queryRaw`SELECT id FROM call_sessions WHERE id = ${callId} FOR UPDATE`;
                const call = await tx.call_sessions.findUnique({
                    where: { id: callId },
                    select: { id: true, status: true, created_at: true, conversation_id: true, initiated_by: true, call_type: true, accepted_at: true },
                });
                if (!call || call.status !== "ringing") return { expired: false, createdAt: null };
                if (call.created_at.getTime() + RING_TIMEOUT_MS > Date.now()) return { expired: false, createdAt: call.created_at };
                const now = new Date();
                await tx.call_participants.updateMany({ where: { call_id: callId, left_at: null }, data: { left_at: now } });
                await tx.call_sessions.update({
                    where: { id: callId },
                    data: { status: "ended", end_reason: "timeout", ended_at: now, updated_at: now },
                });
                await persistCallActivity(tx, { ...call, ended_at: now, end_reason: "timeout" });
                return { expired: true, createdAt: null };
            }, { maxWait: 15000, timeout: 15000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

            if (outcome.expired) await this.notifications.notifyCallTimedOut(callId);
            else if (outcome.createdAt) this.scheduleRingingTimeout(callId, outcome.createdAt);
        } catch {
            // Retry transient database failures. The transaction row lock makes competing
            // timers and accept requests converge on one persisted terminal state.
            this.retryRingingTimeout(callId);
        }
    }

    private async validateConversation(tx: Prisma.TransactionClient, conversationId: bigint, callerId: bigint) {
        const conversation = await tx.conversations.findFirst({
            where: { id: conversationId, type: "direct" },
            select: { id: true, conversation_members: { where: { left_at: null }, select: { user_id: true } } },
        });
        if (!conversation || conversation.conversation_members.length !== 2 || !conversation.conversation_members.some(member => member.user_id === callerId)) {
            throw new NotFoundException("Conversation not found.");
        }
        const recipientId = conversation.conversation_members.find(member => member.user_id !== callerId)?.user_id;
        if (!recipientId) throw new NotFoundException("Conversation not found.");
        const activeUsers = await tx.users.findMany({
            where: { id: { in: [callerId, recipientId] }, status: "active", deleted: "NO" },
            select: { id: true },
        });
        if (activeUsers.length !== 2) throw new ForbiddenException("Both call participants must have active accounts.");

        const pair = { OR: [
            { requester_id: callerId, addressee_id: recipientId },
            { requester_id: recipientId, addressee_id: callerId },
        ] };
        const [friendship, blocked] = await Promise.all([
            tx.friendships.findFirst({ where: { ...pair, status: "accepted" }, select: { id: true } }),
            tx.friendships.findFirst({ where: { ...pair, status: "blocked" }, select: { id: true } }),
        ]);
        if (!friendship || blocked) throw new ForbiddenException("Calls are only available between active friends who are not blocked.");
        return recipientId;
    }

    private async lockUsers(tx: Prisma.TransactionClient, userIds: bigint[]) {
        const ordered = [...userIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        await tx.$queryRaw`SELECT id FROM users WHERE id IN (${Prisma.join(ordered)}) ORDER BY id FOR UPDATE`;
    }

    private async mint(row: CallRow, userId: bigint) {
        const participant = row.call_participants.find(item => item.user_id === userId);
        if (!participant) throw new NotFoundException("Call not found.");
        const profile = participant.users.profiles;
        const name = profile?.display_name || [participant.users.first_name, participant.users.last_name].filter(Boolean).join(" ") || participant.users.user_name || "NexChat user";
        return this.livekit.issueParticipantToken(row.room_name, userId.toString(), name);
    }

    private async view(row: CallRow) {
        return {
            id: row.id.toString(),
            conversationId: row.conversation_id.toString(),
            initiatedBy: row.initiated_by.toString(),
            roomName: row.room_name,
            callType: row.call_type,
            status: row.status,
            createdAt: row.created_at.toISOString(),
            acceptedAt: row.accepted_at?.toISOString() ?? null,
            endedAt: row.ended_at?.toISOString() ?? null,
            endReason: row.end_reason,
            participants: await Promise.all(row.call_participants.map(async item => ({
                id: item.user_id.toString(),
                role: item.role,
                name: item.users.profiles?.display_name || [item.users.last_name, item.users.first_name].filter(Boolean).join(" ") || item.users.user_name || "NexChat user",
                avatar: await this.profileAvatar(item.users.profiles?.avatar_url || item.users.avatar),
                joinedAt: item.joined_at?.toISOString() ?? null,
                leftAt: item.left_at?.toISOString() ?? null,
            }))),
        };
    }

    private async profileAvatar(value: string | null): Promise<string | null> {
        if (!value) return null;
        if (!value.startsWith("profiles/")) return value;
        try { return await this.storage.url(value, null, 300); }
        catch { return null; }
    }

    async start(userId: bigint, input: { conversationId: bigint; callType: "audio" | "video"; idempotencyKey: string }) {
        this.livekit.assertConfigured();
        let row: CallRow;
        let reused = false;
        try {
            row = await this.prisma.$transaction(async tx => {
                const conversation = await tx.conversations.findFirst({
                    where: { id: input.conversationId, type: "direct" },
                    select: { conversation_members: { where: { left_at: null }, select: { user_id: true } } },
                });
                if (!conversation || conversation.conversation_members.length !== 2 || !conversation.conversation_members.some(member => member.user_id === userId)) {
                    throw new NotFoundException("Conversation not found.");
                }
                const recipientId = conversation.conversation_members.find(member => member.user_id !== userId)!.user_id;
                await this.lockUsers(tx, [userId, recipientId]);
                const validatedRecipient = await this.validateConversation(tx, input.conversationId, userId);

                const prior = await tx.call_sessions.findUnique({
                    where: { initiated_by_idempotency_key: { initiated_by: userId, idempotency_key: input.idempotencyKey } },
                    include: callInclude,
                });
                if (prior) {
                    if (prior.conversation_id !== input.conversationId || prior.call_type !== input.callType) throw new ConflictException("Idempotency key was already used for a different call.");
                    if (prior.status !== "ringing" && prior.status !== "accepted") throw new ConflictException("This call request has already completed.");
                    reused = true;
                    return prior;
                }

                const active = await tx.call_sessions.findFirst({
                    where: { status: { in: [...ACTIVE_STATUSES] }, call_participants: { some: { user_id: { in: [userId, validatedRecipient] } } } },
                    select: { id: true },
                });
                if (active) throw new ConflictException("One of the participants already has an active call.");

                const created = await tx.call_sessions.create({
                    data: {
                        conversation_id: input.conversationId,
                        initiated_by: userId,
                        room_name: `nexchat-call-${randomUUID()}`,
                        call_type: input.callType,
                        status: "ringing",
                        idempotency_key: input.idempotencyKey,
                        call_participants: { create: [
                            { user_id: userId, role: "caller" },
                            { user_id: validatedRecipient, role: "callee" },
                        ] },
                    },
                    include: callInclude,
                });
                return created;
            }, { maxWait: 15000, timeout: 15000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
            const prior = await this.prisma.call_sessions.findUnique({
                where: { initiated_by_idempotency_key: { initiated_by: userId, idempotency_key: input.idempotencyKey } },
                include: callInclude,
            });
            if (!prior || prior.conversation_id !== input.conversationId || prior.call_type !== input.callType || !ACTIVE_STATUSES.includes(prior.status as typeof ACTIVE_STATUSES[number])) throw error;
            row = prior;
            reused = true;
        }
        if (row.status === "ringing") this.scheduleRingingTimeout(row.id, row.created_at);
        if (!reused) await this.notifications.notifyCallStarted(row.id, userId);
        const token = await this.mint(row, userId);
        return { success: true, reused, call: await this.view(row), ...token };
    }

    private async transition(userId: bigint, callId: bigint, action: "accept" | "decline" | "cancel" | "end") {
        if (action === "accept") this.livekit.assertConfigured();
        const row = await this.prisma.$transaction(async tx => {
            await tx.$queryRaw`SELECT id FROM call_sessions WHERE id = ${callId} FOR UPDATE`;
            const call = await tx.call_sessions.findFirst({
                where: { id: callId, call_participants: { some: { user_id: userId } } },
                include: callInclude,
            });
            if (!call) throw new NotFoundException("Call not found.");
            const participant = call.call_participants.find(item => item.user_id === userId)!;
            const now = new Date();
            if (call.status === "ringing" && call.created_at.getTime() + RING_TIMEOUT_MS <= now.getTime()) {
                await tx.call_participants.updateMany({ where: { call_id: call.id, left_at: null }, data: { left_at: now } });
                const timedOut = await tx.call_sessions.update({ where: { id: call.id }, data: { status: "ended", end_reason: "timeout", ended_at: now, updated_at: now }, include: callInclude });
                await persistCallActivity(tx, timedOut);
                return timedOut;
            }
            if (action === "accept") {
                if (participant.role !== "callee") throw new ForbiddenException("Only the invited participant can accept this call.");
                if (call.status !== "ringing") throw new ConflictException("This call is no longer ringing.");
                await this.validateConversation(tx, call.conversation_id, userId);
                return tx.call_sessions.update({
                    where: { id: call.id },
                    data: { status: "accepted", accepted_at: now, updated_at: now, call_participants: { update: { where: { call_id_user_id: { call_id: call.id, user_id: userId } }, data: { joined_at: now } } } },
                    include: callInclude,
                });
            }
            if (action === "decline") {
                if (participant.role !== "callee") throw new ForbiddenException("Only the invited participant can decline this call.");
                if (call.status !== "ringing") throw new ConflictException("This call is no longer ringing.");
            } else if (action === "cancel") {
                if (call.initiated_by !== userId) throw new ForbiddenException("Only the caller can cancel this call.");
                if (call.status !== "ringing") throw new ConflictException("Only a ringing call can be cancelled.");
            } else if (call.status !== "accepted") {
                throw new ConflictException("Only an accepted call can be ended.");
            }
            const endReason = action === "decline" ? "declined" : action === "cancel" ? "cancelled" : "ended";
            await tx.call_participants.updateMany({ where: { call_id: call.id, left_at: null }, data: { left_at: now } });
            const completed = await tx.call_sessions.update({ where: { id: call.id }, data: { status: endReason, end_reason: endReason, ended_at: now, updated_at: now }, include: callInclude });
            await persistCallActivity(tx, completed);
            return completed;
        }, { maxWait: 15000, timeout: 15000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

        this.clearRingingTimeout(row.id);
        if (row.status === "ended" && row.end_reason === "timeout") {
            await this.notifications.notifyCallTimedOut(row.id);
            throw new ConflictException("This call ended because it was not answered within 30 seconds.");
        }
        const eventAction = action === "accept" ? "accepted" : action === "decline" ? "declined" : action === "cancel" ? "cancelled" : "ended";
        if (action === "end" || action === "decline" || action === "cancel") await this.recordings?.stopForCall(row.id);
        await this.notifications.notifyCallTransition(row.id, userId, eventAction);
        const token = action === "accept" ? await this.mint(row, userId) : undefined;
        return { success: true, call: await this.view(row), ...(token ?? {}) };
    }

    accept(userId: bigint, callId: bigint) { return this.transition(userId, callId, "accept"); }
    decline(userId: bigint, callId: bigint) { return this.transition(userId, callId, "decline"); }
    cancel(userId: bigint, callId: bigint) { return this.transition(userId, callId, "cancel"); }
    end(userId: bigint, callId: bigint) { return this.transition(userId, callId, "end"); }

    async active(userId: bigint) {
        const rows = await this.prisma.call_sessions.findMany({
            where: { status: { in: [...ACTIVE_STATUSES] }, call_participants: { some: { user_id: userId } } },
            orderBy: { created_at: "desc" },
            include: callInclude,
        });
        const calls = await Promise.all(rows.map(async row => ({
            call: await this.view(row),
            ...(row.status === "accepted" ? await this.mint(row, userId) : {}),
        })));
        return { success: true, calls };
    }

    async history(userId: bigint, input: { cursor?: bigint; limit: number }) {
        const rows = await this.prisma.call_sessions.findMany({
            where: { call_participants: { some: { user_id: userId } }, ...(input.cursor ? { id: { lt: input.cursor } } : {}) },
            orderBy: { id: "desc" },
            take: input.limit + 1,
            include: callInclude,
        });
        const hasMore = rows.length > input.limit;
        const page = rows.slice(0, input.limit);
        return { success: true, calls: await Promise.all(page.map(row => this.view(row))), hasMore, nextCursor: hasMore ? page.at(-1)!.id.toString() : null };
    }
}
