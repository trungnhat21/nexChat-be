import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AccessToken, EncodedFileType, EgressStatus, WebhookReceiver } from "livekit-server-sdk";
import { Prisma } from "@prisma/client";
import { Module, NotFoundException } from "@nestjs/common";
import { RecordingsService } from "../dist/recordings/recordings.service.js";
import { LiveKitWebhookController } from "../dist/recordings/recordings.controller.js";
import { LiveKitService } from "../dist/livekit/livekit.service.js";
import { makeRecordingOutput } from "../dist/livekit/livekit.recording.js";
import { installRequestBodyParsers } from "../dist/utils/http-body-parser.js";
import { NestFactory } from "@nestjs/core";

const now = new Date("2026-10-26T12:00:00Z");
const recording = (overrides = {}) => ({
  id: 8n, call_id: 3n, egress_id: "egress-1", object_key: "recordings/3/123e4567-e89b-42d3-a456-426614174000.mp4",
  status: "active", content_type: "video/mp4", file_size: null, duration_ms: null, started_at: now,
  completed_at: null, retention_expires_at: new Date("2026-11-25T12:00:00Z"), deleted_at: null,
  last_egress_event_at: null, last_error: null, created_at: now, updated_at: now, ...overrides,
});

test("Egress output writes MP4 directly to configured private S3 using path style and rejects unsafe object keys", () => {
  const output = makeRecordingOutput("recordings/3/123e4567-e89b-42d3-a456-426614174000.mp4", {
    endpoint: "http://minio.internal:9000", bucket: "private-recordings", accessKey: "egress-writer", secret: "secret", region: "us-east-1",
  });
  assert.equal(output.filepath, "recordings/3/123e4567-e89b-42d3-a456-426614174000.mp4");
  assert.equal(output.fileType, EncodedFileType.MP4);
  assert.equal(output.output.case, "s3");
  assert.equal(output.output.value.forcePathStyle, true);
  assert.equal(output.output.value.bucket, "private-recordings");
  assert.throws(() => makeRecordingOutput("../public/leak.mp4", {}), /Invalid recording object key/);
});

test("recording requires both persisted consents; a single participant's consent does not start Egress", async () => {
  let startCalls = 0;
  const tx = {
    $queryRaw: async () => [],
    call_sessions: { findFirst: async () => ({ id: 3n, status: "accepted", call_participants: [{ user_id: 1n }, { user_id: 2n }] }), findUnique: async () => null },
    users: { findMany: async () => [{ id: 1n }, { id: 2n }] },
    friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 2n } : null },
    call_recording_consents: { upsert: async () => ({ consented_at: now, revoked_at: null }), findMany: async () => [{ user_id: 1n, consented_at: now, revoked_at: null }] },
    call_recordings: { findMany: async () => [], findUnique: async () => null, create: async () => { throw new Error("should not create recording"); } },
  };
  const prisma = { $transaction: async callback => callback(tx), call_recording_consents: tx.call_recording_consents, call_recordings: { findMany: async () => [] } };
  const service = new RecordingsService(prisma, { startRecording: async () => { startCalls++; } }, {});
  const result = await service.setConsent(1n, 3n, true);
  assert.equal(result.recording, null);
  assert.equal(startCalls, 0);
});

test("Egress start failure persists a failed recording lifecycle state", async () => {
  const row = recording({ status: "starting", egress_id: null });
  const tx = {
    $queryRaw: async () => [],
    call_recordings: { findUnique: async ({ where }) => where.id === row.id ? row : { call_id: 3n }, update: async ({ data }) => Object.assign(row, data) },
    call_sessions: { findFirst: async () => ({ id: 3n, room_name: "room-3", call_type: "video", status: "accepted", call_participants: [{ user_id: 1n }, { user_id: 2n }] }) },
    call_recording_consents: { findMany: async () => [{ user_id: 1n }, { user_id: 2n }] },
    users: { findMany: async () => [{ id: 1n }, { id: 2n }] },
    friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 4n } : null },
  };
  const service = new RecordingsService({ $transaction: callback => callback(tx), call_recordings: { updateMany: async () => ({ count: 1 }) } }, { startRecording: async () => { throw new Error("egress unavailable"); } }, {});
  await service.startReservedRecording(row.id);
  assert.equal(row.status, "failed");
  assert.match(row.last_error, /egress unavailable/);
});

test("second participant's consent starts exactly one Egress recording for the accepted call", async () => {
  const consentRows = [{ call_id: 3n, user_id: 1n, consented_at: now, revoked_at: null }];
  let recordingRow = null;
  let egressStarts = 0;
  const tx = {
    $queryRaw: async () => [],
    call_sessions: {
      findFirst: async () => ({ id: 3n, status: "accepted", room_name: "room-3", call_type: "video", call_participants: [{ user_id: 1n }, { user_id: 2n }] }),
      findUnique: async () => ({ id: 3n }),
    },
    users: { findMany: async () => [{ id: 1n }, { id: 2n }] },
    friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 1n } : null },
    call_recording_consents: {
      upsert: async ({ where, create }) => {
        const existing = consentRows.find(item => item.user_id === where.call_id_user_id.user_id);
        if (existing) return existing;
        const created = { ...create };
        consentRows.push(created);
        return created;
      },
      findMany: async () => consentRows,
    },
    call_recordings: {
      findMany: async () => recordingRow ? [recordingRow] : [],
      create: async ({ data }) => { recordingRow = { id: 8n, ...data, egress_id: null, file_size: null, duration_ms: null, started_at: null, completed_at: null, deleted_at: null, created_at: now, retention_expires_at: new Date("2026-11-25T12:00:00Z") }; return recordingRow; },
      findUnique: async () => recordingRow,
      update: async ({ data }) => Object.assign(recordingRow, data),
    },
    livekit_webhook_events: { findMany: async () => [] },
  };
  const prisma = {
    $transaction: async callback => callback(tx),
    call_recording_consents: { findMany: async () => consentRows },
    call_recordings: { findMany: async () => recordingRow ? [recordingRow] : [] },
  };
  const livekit = { startRecording: async () => { egressStarts++; return { egressId: "egress-1", startedAt: 1_000_000n }; } };
  const service = new RecordingsService(prisma, livekit, {});
  const result = await service.setConsent(2n, 3n, true);
  assert.equal(egressStarts, 1);
  assert.equal(recordingRow.status, "starting");
  assert.equal(recordingRow.egress_id, "egress-1");
  assert.equal(result.recording.status, "starting");
});

test("Egress stop failure is persisted so retry logic can recover it", async () => {
  const row = recording({ status: "stopping" });
  const prisma = {
    call_recordings: {
      findUnique: async () => row,
      updateMany: async ({ data }) => { Object.assign(row, data); return { count: 1 }; },
    },
  };
  const service = new RecordingsService(prisma, { stopRecording: async () => { throw new Error("stop endpoint unavailable"); } }, {});
  await service.stopRecording(row.id);
  assert.equal(row.status, "stop_failed");
  assert.match(row.last_error, /stop endpoint unavailable/);
});

test("participant-only listing and playback deny unrelated users", async () => {
  const prisma = {
    call_sessions: { findFirst: async () => null },
    call_recordings: { findFirst: async () => null },
  };
  const service = new RecordingsService(prisma, {}, {});
  await assert.rejects(service.list(99n, 3n), NotFoundException);
  await assert.rejects(service.playbackUrl(99n, 3n, 8n), NotFoundException);
});

test("verified webhook processing is idempotent and ignores older events after completion", async () => {
  const seen = new Map();
  let current = recording();
  let eventRowId = 0n;
  const tx = {
    livekit_webhook_events: {
      create: async ({ data }) => {
        if (seen.has(data.webhook_id)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
        const row = { id: ++eventRowId, ...data, processed_at: null };
        seen.set(data.webhook_id, row);
        return row;
      },
      update: async ({ where, data }) => Object.assign([...seen.values()].find(item => item.id === where.id), data),
      updateMany: async () => ({ count: 0 }),
    },
    call_recordings: {
      findUnique: async ({ where }) => where.egress_id ? current : current.id === where.id ? current : null,
      update: async ({ data }) => Object.assign(current, data),
    },
  };
  const service = new RecordingsService({ $transaction: callback => callback(tx) }, {}, {});
  const ended = {
    id: "123e4567-e89b-42d3-a456-426614174000", event: "egress_ended", createdAt: 1000n,
    egressInfo: { egressId: "egress-1", status: EgressStatus.EGRESS_COMPLETE, startedAt: 900_000_000_000n, endedAt: 1_000_000_000_000n, fileResults: [{ size: 1024n, duration: 5_000_000_000n }] },
  };
  assert.deepEqual(await service.processWebhook(ended), { success: true, pending: false });
  assert.equal(current.status, "completed");
  assert.equal(current.file_size, 1024n);
  assert.equal(current.duration_ms, 5000n);
  assert.deepEqual(await service.processWebhook(ended), { success: true, duplicate: true });
  const oldStarted = { ...ended, id: "223e4567-e89b-42d3-a456-426614174000", event: "egress_started", createdAt: 900n, egressInfo: { ...ended.egressInfo, status: EgressStatus.EGRESS_ACTIVE } };
  await service.processWebhook(oldStarted);
  assert.equal(current.status, "completed");
});

test("raw webhook parser preserves signed bytes and invalid signature is rejected before processing", async () => {
  const previous = { LIVEKIT_URL: process.env.LIVEKIT_URL, LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET };
  process.env.LIVEKIT_URL = "ws://livekit.test";
  process.env.LIVEKIT_API_KEY = "recording-test-key";
  process.env.LIVEKIT_API_SECRET = "recording-test-secret";
  const receiver = new WebhookReceiver(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  const livekit = { verifyWebhook: (raw, authorization) => receiver.receive(raw, authorization) };
  const received = [];
  const recordings = { processWebhook: async event => { received.push(event); return { success: true, ignored: true }; } };
  class TestModule {}
  Module({ controllers: [LiveKitWebhookController], providers: [
    { provide: LiveKitService, useValue: livekit },
    { provide: (await import("../dist/recordings/recordings.service.js")).RecordingsService, useValue: recordings },
  ] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false, bodyParser: false });
  installRequestBodyParsers(app.getHttpAdapter().getInstance());
  await app.listen(0, "127.0.0.1");
  const url = `${await app.getUrl()}/api/webhooks/livekit`;
  try {
    const raw = '{ "event" : "room_started", "id" : "123e4567-e89b-42d3-a456-426614174000", "createdAt" : "1" }';
    const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: "webhook", ttl: 300 });
    token.sha256 = createHash("sha256").update(raw).digest("base64");
    const authorization = await token.toJwt();
    const good = await fetch(url, { method: "POST", headers: { "content-type": "application/webhook+json", authorization }, body: raw });
    assert.equal(good.status, 201);
    assert.equal(received.length, 1);
    const bad = await fetch(url, { method: "POST", headers: { "content-type": "application/webhook+json", authorization }, body: raw.replace("room_started", "room_finished") });
    assert.equal(bad.status, 401);
    assert.equal(received.length, 1, "invalid signature must not reach processing");
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("recording removal keeps metadata and marks deletion failure for retry", async () => {
  let row = recording({ status: "completed" });
  const prisma = {
    call_recordings: {
      findFirst: async () => row,
      findUnique: async () => row,
      update: async ({ data }) => Object.assign(row, data),
    },
  };
  const service = new RecordingsService(prisma, {}, { remove: async () => { throw new Error("offline"); } });
  await assert.rejects(service.delete(1n, 3n, 8n));
  assert.equal(row.status, "delete_failed");
  assert.equal(row.id, 8n, "audit metadata remains after media deletion failure");
});

test("retention deletion removes only the media object and retains its audit row", async () => {
  const row = recording({ status: "completed", retention_expires_at: new Date(Date.now() - 1000) });
  const removed = [];
  const prisma = {
    call_recordings: {
      findMany: async () => [{ id: row.id }],
      findUnique: async () => row,
      update: async ({ data }) => Object.assign(row, data),
    },
  };
  const service = new RecordingsService(prisma, {}, { remove: async key => removed.push(key) });
  await service.runRetentionCleanup();
  assert.deepEqual(removed, [row.object_key]);
  assert.equal(row.status, "deleted");
  assert.ok(row.deleted_at instanceof Date);
  assert.equal(row.id, 8n, "recording metadata is retained for audit");
});
