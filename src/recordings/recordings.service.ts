import {
    ConflictException,
    ForbiddenException,
    GoneException,
    Injectable,
    Logger,
    NotFoundException,
    type OnModuleDestroy,
    type OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { EgressStatus, type WebhookEvent } from "livekit-server-sdk";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import { LiveKitService } from "../livekit/livekit.service.js";
import { RecordingStorageService } from "./recording-storage.service.js";

const TERMINAL_RECORDING_STATUSES = ["completed", "failed", "deleted", "delete_failed"] as const;
const PENDING_OR_ACTIVE_STATUSES = ["starting", "active", "stopping", "stop_failed"] as const;
const WEBHOOK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
const STOP_RETRY_MS = 60 * 1000;
const STALE_START_MS = 2 * 60 * 1000;

@Injectable()
export class RecordingsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RecordingsService.name);
    private cleanupTimer: NodeJS.Timeout | undefined;
    private stopRetryTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly prisma: PrismaService,
        private readonly livekit: LiveKitService,
        private readonly storage: RecordingStorageService,
    ) {}

    onModuleInit(): void {
        void this.runRetentionCleanup();
        void this.reconcileStaleEgress();
        void this.runStopRetries();
        this.scheduleRetentionCleanup();
        this.scheduleStopRetries();
    }

    onModuleDestroy(): void {
        if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
        if (this.stopRetryTimer) clearTimeout(this.stopRetryTimer);
    }

    private retentionDays(): number {
        const raw = process.env.RECORDING_RETENTION_DAYS;
        const days = raw === undefined || raw.trim() === "" ? 30 : Number(raw);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("RECORDING_RETENTION_DAYS must be an integer from 1 to 3650.");
        return days;
    }

    private scheduleRetentionCleanup() {
        this.cleanupTimer = setTimeout(() => {
            void this.runRetentionCleanup().finally(() => this.scheduleRetentionCleanup());
        }, STORAGE_TTL_MS);
        this.cleanupTimer.unref?.();
    }

    private scheduleStopRetries() {
        this.stopRetryTimer = setTimeout(() => {
            void this.reconcileStaleEgress().then(() => this.runStopRetries()).finally(() => this.scheduleStopRetries());
        }, STOP_RETRY_MS);
        this.stopRetryTimer.unref?.();
    }

    private async reconcileStaleEgress() {
        const staleBefore = new Date(Date.now() - STALE_START_MS);
        try {
            // A process can die after reserving a row but before persisting an Egress ID.
            // Do not restart blindly: an Egress request may have succeeded before the crash.
            await this.prisma.call_recordings.updateMany({
                where: { status: "starting", egress_id: null, created_at: { lt: staleBefore } },
                data: { status: "failed", last_error: "Egress start outcome is unknown after backend recovery; recording was not restarted to avoid duplicate media.", updated_at: new Date() },
            });
        } catch (error) {
            this.logger.warn(`Recording start reconciliation failed (${this.safeError(error)}).`);
        }
    }

    private async runStopRetries() {
        const staleBefore = new Date(Date.now() - STALE_START_MS);
        try {
            const rows = await this.prisma.call_recordings.findMany({
                where: { egress_id: { not: null }, OR: [{ status: "stop_failed" }, { status: "stopping", updated_at: { lt: staleBefore } }] },
                select: { id: true }, take: 100,
            });
            for (const row of rows) await this.stopRecording(row.id);
        } catch (error) {
            this.logger.warn(`Recording stop retry pass failed (${this.safeError(error)}).`);
        }
    }

    async setConsent(userId: bigint, callId: bigint, consent: boolean) {
        const recordIdsToStop: bigint[] = [];
        let recordingIdToStart: bigint | null = null;
        let ownConsentedAt: Date | null = null;

        await this.prisma.$transaction(async tx => {
            await tx.$queryRaw`SELECT id FROM call_sessions WHERE id = ${callId} FOR UPDATE`;
            const call = await tx.call_sessions.findFirst({
                where: { id: callId, call_participants: { some: { user_id: userId } } },
                select: { id: true, status: true, call_participants: { select: { user_id: true } } },
            });
            if (!call) throw new NotFoundException("Call not found.");
            if (call.call_participants.length !== 2) throw new NotFoundException("Call not found.");
            if (consent) {
                if (call.status !== "accepted") throw new ConflictException("Recording consent is available only during an accepted call.");
                await this.assertCallEligible(tx, callId, call.call_participants.map(item => item.user_id));
            }

            const now = new Date();
            const savedConsent = await tx.call_recording_consents.upsert({
                where: { call_id_user_id: { call_id: callId, user_id: userId } },
                create: { call_id: callId, user_id: userId, consented_at: consent ? now : null, revoked_at: consent ? null : now, updated_at: now },
                update: { ...(consent ? { consented_at: now } : {}), revoked_at: consent ? null : now, updated_at: now },
                select: { consented_at: true, revoked_at: true },
            });
            ownConsentedAt = savedConsent.consented_at && !savedConsent.revoked_at ? savedConsent.consented_at : null;

            const recordings = await tx.call_recordings.findMany({
                where: { call_id: callId, status: { in: [...PENDING_OR_ACTIVE_STATUSES] } },
                select: { id: true, egress_id: true, status: true },
            });

            if (consent) {
                const consents = await tx.call_recording_consents.findMany({
                    where: { call_id: callId, consented_at: { not: null }, revoked_at: null },
                    select: { user_id: true },
                });
                const bothConsented = call.call_participants.every(participant => consents.some(item => item.user_id === participant.user_id));
                if (bothConsented) {
                    if (recordings.length) {
                        for (const record of recordings) if (record.status === "stop_failed") recordIdsToStop.push(record.id);
                    } else {
                        const created = await tx.call_recordings.create({
                            data: {
                                call_id: callId,
                                object_key: `recordings/${callId}/${randomUUID()}.mp4`,
                                status: "starting",
                                content_type: "video/mp4",
                                retention_expires_at: new Date(now.getTime() + this.retentionDays() * 24 * 60 * 60 * 1000),
                            },
                            select: { id: true },
                        });
                        recordingIdToStart = created.id;
                    }
                }
            } else {
                for (const record of recordings) {
                    if (record.status === "starting" && !record.egress_id) {
                        await tx.call_recordings.update({
                            where: { id: record.id },
                            data: { status: "failed", last_error: "Consent was withdrawn before Egress started.", updated_at: now },
                        });
                    } else if (record.egress_id) {
                        await tx.call_recordings.update({ where: { id: record.id }, data: { status: "stopping", updated_at: now } });
                        recordIdsToStop.push(record.id);
                    }
                }
            }
        }, { maxWait: 15000, timeout: 15000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

        for (const recordingId of recordIdsToStop) await this.stopRecording(recordingId);
        if (recordingIdToStart) await this.startReservedRecording(recordingIdToStart);
        const consents = await this.prisma.call_recording_consents.findMany({
            where: { call_id: callId }, select: { user_id: true, consented_at: true, revoked_at: true },
        });
        const recordings = await this.prisma.call_recordings.findMany({ where: { call_id: callId }, orderBy: { id: "desc" }, take: 1 });
        return {
            success: true,
            consented: ownConsentedAt !== null,
            participants: consents.map(item => ({ userId: item.user_id.toString(), consented: Boolean(item.consented_at && !item.revoked_at) })),
            recording: recordings[0] ? this.publicRecording(recordings[0]) : null,
        };
    }

    private async assertCallEligible(tx: Prisma.TransactionClient, callId: bigint, participantIds: bigint[]) {
        if (participantIds.length !== 2 || participantIds[0] === participantIds[1]) throw new ForbiddenException("Recording requires two call participants.");
        const first = participantIds[0]!;
        const second = participantIds[1]!;
        const activeUsers = await tx.users.findMany({ where: { id: { in: [first, second] }, status: "active", deleted: "NO" }, select: { id: true } });
        if (activeUsers.length !== 2) throw new ForbiddenException("Both participants must have active accounts.");
        const [friendship, blocked] = await Promise.all([
            tx.friendships.findFirst({ where: { status: "accepted", OR: [{ requester_id: first, addressee_id: second }, { requester_id: second, addressee_id: first }] }, select: { id: true } }),
            tx.friendships.findFirst({ where: { status: "blocked", OR: [{ requester_id: first, addressee_id: second }, { requester_id: second, addressee_id: first }] }, select: { id: true } }),
        ]);
        if (!friendship || blocked) throw new ForbiddenException("Recording requires an active, unblocked friendship.");
        const call = await tx.call_sessions.findFirst({ where: { id: callId, status: "accepted" }, select: { id: true } });
        if (!call) throw new ConflictException("The call is no longer eligible for recording.");
    }

    private async startReservedRecording(recordingId: bigint) {
        let startedEgressId: string | null = null;
        try {
            await this.prisma.$transaction(async tx => {
                const seed = await tx.call_recordings.findUnique({ where: { id: recordingId }, select: { call_id: true } });
                if (!seed) return;
                await tx.$queryRaw`SELECT id FROM call_sessions WHERE id = ${seed.call_id} FOR UPDATE`;
                const recording = await tx.call_recordings.findUnique({ where: { id: recordingId } });
                const call = await tx.call_sessions.findFirst({
                    where: { id: seed.call_id },
                    select: { id: true, room_name: true, call_type: true, status: true, call_participants: { select: { user_id: true } } },
                });
                if (!recording || recording.status !== "starting" || recording.egress_id || !call) return;
                if (call.status !== "accepted") {
                    await tx.call_recordings.update({ where: { id: recordingId }, data: { status: "failed", last_error: "Call ended before recording start.", updated_at: new Date() } });
                    return;
                }
                const eligible = await tx.call_recording_consents.findMany({
                    where: { call_id: call.id, consented_at: { not: null }, revoked_at: null }, select: { user_id: true },
                });
                if (!call.call_participants.every(participant => eligible.some(item => item.user_id === participant.user_id))) {
                    await tx.call_recordings.update({ where: { id: recordingId }, data: { status: "failed", last_error: "Recording consent was withdrawn before Egress start.", updated_at: new Date() } });
                    return;
                }
                await this.assertCallEligible(tx, call.id, call.call_participants.map(item => item.user_id));
                try {
                    const egress = await this.livekit.startRecording(call.room_name, recording.object_key, call.call_type === "audio");
                    if (!egress.egressId) throw new Error("Egress did not return an ID.");
                    startedEgressId = egress.egressId;
                    const startedAt = egress.startedAt ? this.unixNanosToDate(egress.startedAt) : new Date();
                    await tx.call_recordings.update({
                        where: { id: recordingId },
                        data: { egress_id: egress.egressId, started_at: startedAt, status: "starting", last_error: null, updated_at: new Date() },
                    });
                    await this.applyPendingWebhooks(tx, egress.egressId, recordingId);
                } catch (error) {
                    if (startedEgressId) throw error;
                    await tx.call_recordings.update({
                        where: { id: recordingId },
                        data: { status: "failed", last_error: this.safeError(error), updated_at: new Date() },
                    });
                }
            }, { maxWait: 15000, timeout: 45000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
        } catch (error) {
            if (startedEgressId) {
                let stopFailed = false;
                try { await this.livekit.stopRecording(startedEgressId); } catch { stopFailed = true; }
                await this.prisma.call_recordings.updateMany({
                    where: { id: recordingId, status: "starting" },
                    data: {
                        egress_id: startedEgressId,
                        status: stopFailed ? "stop_failed" : "stopping",
                        last_error: this.safeError(error),
                        updated_at: new Date(),
                    },
                });
            } else {
                await this.prisma.call_recordings.updateMany({
                    where: { id: recordingId, status: "starting", egress_id: null },
                    data: { status: "failed", last_error: this.safeError(error), updated_at: new Date() },
                });
            }
            this.logger.error(`Recording start transaction failed (${this.safeError(error)}).`);
        }
    }

    async stopForCall(callId: bigint): Promise<void> {
        try {
            const records = await this.prisma.call_recordings.findMany({
                where: { call_id: callId, status: { in: [...PENDING_OR_ACTIVE_STATUSES] } }, select: { id: true, egress_id: true, status: true },
            });
            for (const record of records) {
                if (record.status === "starting" && !record.egress_id) {
                    await this.prisma.call_recordings.update({ where: { id: record.id }, data: { status: "failed", last_error: "Call ended before Egress started.", updated_at: new Date() } });
                } else if (record.egress_id && record.status !== "stopping") {
                    await this.prisma.call_recordings.update({ where: { id: record.id }, data: { status: "stopping", updated_at: new Date() } });
                    await this.stopRecording(record.id);
                }
            }
        } catch (error) {
            this.logger.error(`Could not request call recording stop (${this.safeError(error)}).`);
        }
    }

    private async stopRecording(recordingId: bigint) {
        const recording = await this.prisma.call_recordings.findUnique({ where: { id: recordingId }, select: { id: true, egress_id: true, status: true } });
        if (!recording || !recording.egress_id || !["stopping", "stop_failed"].includes(recording.status)) return;
        try {
            await this.livekit.stopRecording(recording.egress_id);
            await this.prisma.call_recordings.updateMany({ where: { id: recordingId, status: { in: ["stopping", "stop_failed"] } }, data: { status: "stopping", updated_at: new Date(), last_error: null } });
        } catch (error) {
            await this.prisma.call_recordings.updateMany({ where: { id: recordingId, status: { in: ["stopping", "stop_failed"] } }, data: { status: "stop_failed", last_error: this.safeError(error), updated_at: new Date() } });
            this.logger.warn(`Egress stop failed for recording ${recordingId} (${this.safeError(error)}).`);
        }
    }

    async retryStop(userId: bigint, callId: bigint, recordingId: bigint) {
        const recording = await this.prisma.call_recordings.findFirst({
            where: { id: recordingId, call_id: callId, status: "stop_failed", calls: { call_participants: { some: { user_id: userId } } } },
            select: { id: true },
        });
        if (!recording) throw new NotFoundException("Recording not found.");
        await this.stopRecording(recording.id);
        return { success: true, recording: await this.getAuthorizedRecording(userId, callId, recordingId) };
    }

    async processWebhook(event: WebhookEvent) {
        if (!WEBHOOK_UUID.test(event.id)) throw new ConflictException("LiveKit webhook event ID is invalid.");
        if (!event.event.startsWith("egress_")) return { success: true, ignored: true };
        const info = event.egressInfo;
        if (!info?.egressId) throw new ConflictException("LiveKit Egress webhook is missing its Egress ID.");
        const file = info.fileResults[0];
        const eventAt = this.unixSecondsToDate(event.createdAt);
        try {
            return await this.prisma.$transaction(async tx => {
                const webhook = await tx.livekit_webhook_events.create({
                    data: {
                        webhook_id: event.id,
                        event_type: event.event,
                        egress_id: info.egressId,
                        egress_status: info.status,
                        event_created_at: eventAt,
                        egress_started_at: info.startedAt ? this.unixNanosToDate(info.startedAt) : null,
                        egress_ended_at: info.endedAt ? this.unixNanosToDate(info.endedAt) : null,
                        file_size: file?.size && file.size > 0n ? file.size : null,
                        duration_ms: file?.duration && file.duration > 0n ? file.duration / 1_000_000n : null,
                        error_code: info.errorCode || null,
                        error_message: info.error ? info.error.slice(0, 500) : info.details ? info.details.slice(0, 500) : null,
                    },
                });
                const recording = await tx.call_recordings.findUnique({ where: { egress_id: info.egressId } });
                if (!recording) return { success: true, pending: true };
                await this.applyWebhookToRecording(tx, recording, webhook);
                return { success: true, pending: false };
            }, { maxWait: 15000, timeout: 15000 });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { success: true, duplicate: true };
            throw error;
        }
    }

    private async applyPendingWebhooks(tx: Prisma.TransactionClient, egressId: string, recordingId: bigint) {
        const events = await tx.livekit_webhook_events.findMany({
            where: { egress_id: egressId, processed_at: null },
            orderBy: [{ event_created_at: "asc" }, { id: "asc" }],
        });
        let recording = await tx.call_recordings.findUnique({ where: { id: recordingId } });
        if (!recording) return;
        for (const event of events) recording = await this.applyWebhookToRecording(tx, recording, event);
    }

    private async applyWebhookToRecording(tx: Prisma.TransactionClient, recording: NonNullable<Awaited<ReturnType<Prisma.TransactionClient["call_recordings"]["findUnique"]>>>, event: {
        id: bigint; event_type: string; egress_status: number | null; event_created_at: Date; egress_started_at: Date | null; egress_ended_at: Date | null;
        file_size: bigint | null; duration_ms: bigint | null; error_message: string | null;
    }) {
        if (recording.status === "deleted" || recording.status === "deleting" || recording.status === "delete_failed") {
            await tx.livekit_webhook_events.update({ where: { id: event.id }, data: { processed_at: new Date() } });
            return recording;
        }
        const isOlder = recording.last_egress_event_at && event.event_created_at < recording.last_egress_event_at;
        if (isOlder) {
            await tx.livekit_webhook_events.update({ where: { id: event.id }, data: { processed_at: new Date() } });
            return recording;
        }
        const now = new Date();
        let data: Prisma.call_recordingsUpdateInput = { last_egress_event_at: event.event_created_at, updated_at: now };
        if (event.event_type === "egress_started" || event.event_type === "egress_updated") {
            data = {
                ...data,
                ...(recording.file_size === null && event.file_size ? { file_size: event.file_size } : {}),
                ...(recording.duration_ms === null && event.duration_ms ? { duration_ms: event.duration_ms } : {}),
                ...(recording.started_at === null && event.egress_started_at ? { started_at: event.egress_started_at } : {}),
                ...(recording.status === "starting" && event.egress_status === EgressStatus.EGRESS_ACTIVE ? { status: "active" } : {}),
            };
        } else if (event.event_type === "egress_ended") {
            if (event.egress_status === EgressStatus.EGRESS_COMPLETE) {
                const completedAt = event.egress_ended_at ?? event.event_created_at;
                data = {
                    ...data,
                    status: "completed",
                    file_size: event.file_size ?? recording.file_size,
                    duration_ms: event.duration_ms ?? recording.duration_ms,
                    started_at: recording.started_at ?? event.egress_started_at,
                    completed_at: completedAt,
                    retention_expires_at: new Date(completedAt.getTime() + this.retentionDays() * 24 * 60 * 60 * 1000),
                    last_error: null,
                };
            } else if ([EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED].includes(event.egress_status as EgressStatus)) {
                data = { ...data, status: "failed", file_size: event.file_size ?? recording.file_size, duration_ms: event.duration_ms ?? recording.duration_ms, last_error: event.error_message || `Egress ended with status ${event.egress_status}.` };
            }
        }
        const updated = await tx.call_recordings.update({ where: { id: recording.id }, data });
        await tx.livekit_webhook_events.update({ where: { id: event.id }, data: { processed_at: now } });
        if (event.event_type === "egress_ended") {
            await tx.livekit_webhook_events.updateMany({
                where: { egress_id: recording.egress_id!, processed_at: null, event_created_at: { lte: event.event_created_at } },
                data: { processed_at: now },
            });
        }
        return updated;
    }

    async list(userId: bigint, callId: bigint) {
        await this.requireParticipant(userId, callId);
        const rows = await this.prisma.call_recordings.findMany({ where: { call_id: callId }, orderBy: { created_at: "desc" } });
        return { success: true, recordings: rows.map(row => this.publicRecording(row)) };
    }

    async playbackUrl(userId: bigint, callId: bigint, recordingId: bigint) {
        const recording = await this.getAuthorizedRecording(userId, callId, recordingId);
        if (recording.status === "deleted" || recording.status === "deleting" || recording.status === "delete_failed") throw new GoneException("Recording media is no longer available.");
        if (recording.status !== "completed") throw new ConflictException("Recording is not ready for playback.");
        if (!recording.retention_expires_at || recording.retention_expires_at <= new Date()) throw new GoneException("Recording media has expired.");
        const url = await this.storage.playbackUrl(recording.object_key, recording.content_type, 300);
        return { success: true, url, expiresIn: 300 };
    }

    async delete(userId: bigint, callId: bigint, recordingId: bigint) {
        const recording = await this.getAuthorizedRecording(userId, callId, recordingId);
        if (PENDING_OR_ACTIVE_STATUSES.includes(recording.status as typeof PENDING_OR_ACTIVE_STATUSES[number])) throw new ConflictException("Stop the recording before deleting it.");
        await this.deleteMedia(recording.id);
        return { success: true, recording: await this.getAuthorizedRecording(userId, callId, recordingId) };
    }

    private async deleteMedia(recordingId: bigint) {
        const record = await this.prisma.call_recordings.findUnique({ where: { id: recordingId } });
        if (!record || record.status === "deleted") return;
        await this.prisma.call_recordings.update({ where: { id: recordingId }, data: { status: "deleting", updated_at: new Date() } });
        try {
            await this.storage.remove(record.object_key);
            await this.prisma.call_recordings.update({ where: { id: recordingId }, data: { status: "deleted", deleted_at: new Date(), updated_at: new Date(), last_error: null } });
        } catch (error) {
            await this.prisma.call_recordings.update({ where: { id: recordingId }, data: { status: "delete_failed", last_error: this.safeError(error), updated_at: new Date() } });
            throw error;
        }
    }

    private async runRetentionCleanup() {
        try {
            const expired = await this.prisma.call_recordings.findMany({
                where: { status: { in: ["completed", "failed", "delete_failed", "deleting"] }, retention_expires_at: { lte: new Date() } },
                select: { id: true },
                take: 100,
            });
            for (const row of expired) {
                try { await this.deleteMedia(row.id); }
                catch { /* The row remains delete_failed for the next scheduled pass. */ }
            }
        } catch (error) {
            this.logger.warn(`Recording retention pass failed (${this.safeError(error)}).`);
        }
    }

    private async requireParticipant(userId: bigint, callId: bigint) {
        const call = await this.prisma.call_sessions.findFirst({ where: { id: callId, call_participants: { some: { user_id: userId } } }, select: { id: true } });
        if (!call) throw new NotFoundException("Call not found.");
        return call;
    }

    private async getAuthorizedRecording(userId: bigint, callId: bigint, recordingId: bigint) {
        const recording = await this.prisma.call_recordings.findFirst({
            where: { id: recordingId, call_id: callId, calls: { call_participants: { some: { user_id: userId } } } },
        });
        if (!recording) throw new NotFoundException("Recording not found.");
        return recording;
    }

    private publicRecording(recording: {
        id: bigint; call_id: bigint; status: string; content_type: string; file_size: bigint | null; duration_ms: bigint | null;
        created_at: Date; started_at: Date | null; completed_at: Date | null; retention_expires_at: Date | null; deleted_at: Date | null;
    }) {
        return {
            id: recording.id.toString(), callId: recording.call_id.toString(), status: recording.status,
            contentType: recording.content_type, size: recording.file_size?.toString() ?? null,
            durationMs: recording.duration_ms?.toString() ?? null, createdAt: recording.created_at.toISOString(),
            startedAt: recording.started_at?.toISOString() ?? null, completedAt: recording.completed_at?.toISOString() ?? null,
            retentionExpiresAt: recording.retention_expires_at?.toISOString() ?? null, deletedAt: recording.deleted_at?.toISOString() ?? null,
        };
    }

    private safeError(error: unknown) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
        return message.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 500);
    }

    private unixSecondsToDate(seconds: bigint) { return new Date(Number(seconds) * 1000); }
    private unixNanosToDate(nanos: bigint) { return new Date(Number(nanos / 1_000_000n)); }
}
