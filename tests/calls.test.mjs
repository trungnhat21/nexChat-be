import test from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthGuard } from "../dist/auth/auth.guard.js";
import { AuthService } from "../dist/auth/auth.service.js";
import { createAccessToken } from "../dist/utils/token.js";
import { CallsController } from "../dist/calls/calls.controller.js";
import { CallsService } from "../dist/calls/calls.service.js";
import { LiveKitService } from "../dist/livekit/livekit.service.js";
import { parseCallHistoryQuery, parseCallId, parseCallStart } from "../dist/calls/calls.validation.js";
import { PrismaService } from "../dist/prisma/prisma.service.js";

const startInput = { conversationId: 15n, callType: "video", idempotencyKey: "d4d8c9f1-3d4d-4a17-8f62-5784fc9520d1" };
const users = [
    { id: 1n, user_name: "caller", first_name: "Call", last_name: "Er", profiles: null },
    { id: 2n, user_name: "callee", first_name: "Call", last_name: "Ee", profiles: null },
];
const callRow = (overrides = {}) => ({
    id: 55n, conversation_id: 15n, initiated_by: 1n, room_name: "nexchat-call-test", call_type: "video", status: "ringing",
    created_at: new Date(), accepted_at: null, ended_at: null, end_reason: null,
    call_participants: [
        { user_id: 1n, role: "caller", joined_at: null, left_at: null, users: users[0] },
        { user_id: 2n, role: "callee", joined_at: null, left_at: null, users: users[1] },
    ], ...overrides,
});
const livekit = { assertConfigured() {}, issueParticipantToken: async (room, identity) => ({ room, identity, token: "signed-token", expiresIn: 600, url: "wss://livekit.example.test" }) };
const realtime = { notifyCallStarted: async () => {}, notifyCallTransition: async () => {} };

test("validates call IDs, type, UUID idempotency, and history pagination", () => {
    assert.equal(parseCallId("12"), 12n);
    assert.deepEqual(parseCallStart({ conversationId: "12", callType: "audio", idempotencyKey: startInput.idempotencyKey }), { conversationId: 12n, callType: "audio", idempotencyKey: startInput.idempotencyKey });
    assert.deepEqual(parseCallHistoryQuery("9", "50"), { cursor: 9n, limit: 50 });
    for (const id of ["0", "-1", "18446744073709551616", 1]) assert.throws(() => parseCallId(id), BadRequestException);
    for (const body of [null, {}, { conversationId: "1", callType: "screen", idempotencyKey: startInput.idempotencyKey }, { conversationId: "1", callType: "audio", idempotencyKey: "duplicate" }]) assert.throws(() => parseCallStart(body), BadRequestException);
    for (const limit of ["0", "51", "x"]) assert.throws(() => parseCallHistoryQuery(undefined, limit), BadRequestException);
});

test("HTTP call history requires a valid application session and ignores client-supplied owner IDs", async () => {
    const observed = [];
    const calls = {
        history: async (...args) => { observed.push(args); return { success: true, calls: [] }; },
        active: async (...args) => { observed.push(args); return { success: true, calls: [] }; },
    };
    class TestModule {}
    Module({ controllers: [CallsController], providers: [AuthGuard,
        { provide: AuthService, useValue: { getSessionCurrentUser: async (sessionId, userId) => sessionId === "calls-http-test" && userId === 4n ? { id: "4" } : null } },
        { provide: CallsService, useValue: calls },
    ] })(TestModule);
    const app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    try {
        assert.equal((await fetch(base + "/api/calls/history")).status, 401);
        assert.equal((await fetch(base + "/api/calls/active")).status, 401);
        const response = await fetch(base + "/api/calls/history?userId=999&limit=10", { headers: { Authorization: `Bearer ${createAccessToken(4n, "calls-http-test")}` } });
        assert.equal(response.status, 200);
        assert.deepEqual(observed[0], [4n, { limit: 10 }]);
        const activeResponse = await fetch(base + "/api/calls/active?userId=999", { headers: { Authorization: `Bearer ${createAccessToken(4n, "calls-http-test")}` } });
        assert.equal(activeResponse.status, 200);
        assert.deepEqual(observed[1], [4n]);
    } finally { await app.close(); }
});

test("start creates a ringing call after validating direct friendship and returns a scoped caller token", async () => {
    let inserted;
    let activeCheckedAfterLock = false;
    const tx = {
        $queryRaw: async () => { activeCheckedAfterLock = true; },
        conversations: { findFirst: async () => ({ id: 15n, conversation_members: [{ user_id: 1n }, { user_id: 2n }] }) },
        users: { findMany: async () => [{ id: 1n }, { id: 2n }] },
        friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 7n } : null },
        call_sessions: {
            findUnique: async () => null,
            findFirst: async () => { assert.equal(activeCheckedAfterLock, true); return null; },
            create: async ({ data }) => { inserted = data; return callRow({ room_name: data.room_name }); },
        },
    };
    const service = new CallsService({ $transaction: callback => callback(tx) }, livekit, realtime);
    const result = await service.start(1n, startInput);
    assert.equal(result.call.status, "ringing");
    assert.equal(result.identity, "1");
    assert.equal(result.token, "signed-token");
    assert.equal(inserted.call_participants.create.length, 2);
    assert.deepEqual(inserted.call_participants.create.map(participant => participant.role), ["caller", "callee"]);
});

test("duplicate idempotency retries reuse the existing call; conflicting active calls are rejected", async () => {
    const prior = callRow();
    const tx = {
        $queryRaw: async () => {},
        conversations: { findFirst: async () => ({ id: 15n, conversation_members: [{ user_id: 1n }, { user_id: 2n }] }) },
        users: { findMany: async () => [{ id: 1n }, { id: 2n }] },
        friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 7n } : null },
        call_sessions: { findUnique: async () => prior, findFirst: async () => assert.fail("idempotent retry must return before active-call query") },
    };
    const service = new CallsService({ $transaction: callback => callback(tx) }, livekit, realtime);
    assert.equal((await service.start(1n, startInput)).reused, true);

    tx.call_sessions.findUnique = async () => null;
    tx.call_sessions.findFirst = async () => ({ id: 100n });
    await assert.rejects(service.start(1n, { ...startInput, idempotencyKey: "e5552e56-72ca-4bbc-8be6-190cbb561234" }), ConflictException);
});

test("only the invited callee can accept, and terminal transitions cannot be repeated", async () => {
    let stored = callRow();
    const tx = {
        $queryRaw: async () => {},
        conversations: { findFirst: async () => ({ id: 15n, conversation_members: [{ user_id: 1n }, { user_id: 2n }] }) },
        users: { findMany: async () => [{ id: 1n }, { id: 2n }] },
        friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 7n } : null },
        call_sessions: {
            findFirst: async () => stored,
            update: async ({ data }) => { stored = { ...stored, ...data, status: data.status, accepted_at: data.accepted_at ?? stored.accepted_at, call_participants: stored.call_participants.map(item => item.user_id === 2n ? { ...item, joined_at: data.call_participants.update.data.joined_at } : item) }; return stored; },
        },
        call_participants: { updateMany: async () => ({ count: 2 }) },
    };
    const service = new CallsService({ $transaction: callback => callback(tx) }, livekit, realtime);
    await assert.rejects(service.accept(1n, 55n), ForbiddenException);
    const accepted = await service.accept(2n, 55n);
    assert.equal(accepted.call.status, "accepted");
    assert.equal(accepted.identity, "2");
    await assert.rejects(service.decline(2n, 55n), ConflictException);
});

test("callee can decline a ringing call, caller can cancel it, and either participant can end an accepted call", async () => {
    for (const [action, actor, initialStatus, expected] of [
        ["decline", 2n, "ringing", "declined"],
        ["cancel", 1n, "ringing", "cancelled"],
        ["end", 2n, "accepted", "ended"],
    ]) {
        let stored = callRow({ status: initialStatus, accepted_at: initialStatus === "accepted" ? new Date(Date.now() - 72_900) : null });
        const activities = [];
        const tx = {
            $queryRaw: async () => {},
            messages: { createMany: async ({ data }) => { activities.push(...data); return { count: data.length }; } },
            conversations: { update: async () => ({}) },
            call_sessions: {
                findFirst: async () => stored,
                update: async ({ data }) => { stored = { ...stored, ...data }; return stored; },
            },
            call_participants: { updateMany: async () => ({ count: 2 }) },
        };
        const service = new CallsService({ $transaction: callback => callback(tx) }, livekit, realtime);
        assert.equal((await service[action](actor, 55n)).call.status, expected);
        assert.equal(stored.end_reason, expected);
        assert.equal(activities.length, 1);
        assert.equal(activities[0].message_type, "system");
        assert.equal(activities[0].client_message_id, "call-55-activity");
        if (action === "decline") assert.equal(activities[0].content, "Cuộc gọi video bị từ chối");
        if (action === "cancel") assert.match(activities[0].content, /người gọi hủy/);
        if (action === "end") assert.match(activities[0].content, /Cuộc gọi video · 1 phút 12 giây/);
    }
});

test("unanswered ringing calls are ended after 30 seconds and notify both participants", async () => {
    let stored = callRow({ created_at: new Date(Date.now() - 31_000) });
    let leftParticipants = false;
    let timeoutNotifications = 0;
    const tx = {
        $queryRaw: async () => {},
        messages: { createMany: async () => ({ count: 1 }) },
        conversations: { update: async () => ({}) },
        call_sessions: {
            findUnique: async () => stored,
            update: async ({ data }) => { stored = { ...stored, ...data }; return stored; },
        },
        call_participants: { updateMany: async () => { leftParticipants = true; return { count: 2 }; } },
    };
    const prisma = {
        $transaction: async callback => callback(tx),
    };
    const notifications = { ...realtime, notifyCallTimedOut: async id => { assert.equal(id, 55n); timeoutNotifications++; } };
    const service = new CallsService(prisma, livekit, notifications, {}, {});

    await service.expireRingingCall(55n);

    assert.equal(stored.status, "ended");
    assert.equal(stored.end_reason, "timeout");
    assert.ok(stored.ended_at instanceof Date);
    assert.equal(leftParticipants, true);
    assert.equal(timeoutNotifications, 1);
});

test("an accept racing after the 30-second deadline cannot revive a timed-out call", async () => {
    let stored = callRow({ created_at: new Date(Date.now() - 31_000) });
    let timeoutNotifications = 0;
    const tx = {
        $queryRaw: async () => {},
        messages: { createMany: async () => ({ count: 1 }) },
        conversations: { update: async () => ({}) },
        call_sessions: {
            findFirst: async () => stored,
            update: async ({ data }) => { stored = { ...stored, ...data }; return stored; },
        },
        call_participants: { updateMany: async () => ({ count: 2 }) },
    };
    const notifications = { ...realtime, notifyCallTimedOut: async () => { timeoutNotifications++; } };
    const service = new CallsService({ $transaction: async callback => callback(tx) }, livekit, notifications, {}, {});

    await assert.rejects(service.accept(2n, 55n), ConflictException);
    assert.equal(stored.status, "ended");
    assert.equal(stored.end_reason, "timeout");
    assert.equal(timeoutNotifications, 1);
});

test("non-participants cannot mutate calls and history is filtered to the requesting participant", async () => {
    const call = callRow({ status: "ended", end_reason: "ended" });
    const service = new CallsService({
        $transaction: callback => callback({ $queryRaw: async () => {}, call_sessions: { findFirst: async () => null } }),
        call_sessions: { findMany: async args => { assert.equal(args.where.call_participants.some.user_id, 2n); return [call]; } },
    }, livekit, realtime);
    await assert.rejects(service.cancel(9n, 55n), NotFoundException);
    const history = await service.history(2n, { limit: 20 });
    assert.deepEqual(history.calls.map(item => item.id), ["55"]);
});

test("active call reconciliation is participant-filtered and remints only accepted-call tokens", async () => {
    const ringing = callRow({ id: 55n, status: "ringing" });
    const accepted = callRow({ id: 56n, status: "accepted", accepted_at: new Date("2026-10-26T10:00:00Z") });
    let query;
    const service = new CallsService({ call_sessions: { findMany: async args => { query = args; return [ringing, accepted]; } } }, livekit, realtime, {});
    const result = await service.active(2n);
    assert.equal(query.where.status.in.includes("ringing"), true);
    assert.equal(query.where.call_participants.some.user_id, 2n);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0].token, undefined);
    assert.equal(result.calls[1].token, "signed-token");
    assert.equal(result.calls[1].identity, "2");
});

test("call participants receive signed profile avatar URLs instead of private MinIO object keys", async () => {
    const call = callRow({ call_participants: callRow().call_participants.map((item, index) => ({
        ...item,
        users: { ...item.users, avatar: null, profiles: { display_name: item.users.user_name, avatar_url: index === 0 ? "profiles/1/avatar.jpg" : null } },
    })) });
    const requestedKeys = [];
    const storage = { url: async key => { requestedKeys.push(key); return `https://media.example/${key}?signature=short-lived`; } };
    const service = new CallsService({}, livekit, realtime, {}, storage);

    const result = await service.view(call);

    assert.deepEqual(requestedKeys, ["profiles/1/avatar.jpg"]);
    assert.match(result.participants[0].avatar, /^https:\/\/media\.example\/profiles\/1\/avatar\.jpg\?/);
    assert.equal(result.participants[1].avatar, null);
});

test("LiveKit token grants join/publish/subscribe only for its assigned room", async () => {
    const previous = { url: process.env.LIVEKIT_URL, key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET };
    process.env.LIVEKIT_URL = "wss://livekit.example.test";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-with-enough-entropy";
    try {
        const service = new LiveKitService();
        const result = await service.issueParticipantToken("room-authorized", "42", "Test User");
        const payload = JSON.parse(Buffer.from(result.token.split(".")[1], "base64url").toString("utf8"));
        assert.equal(payload.sub, "42");
        assert.equal(payload.video.room, "room-authorized");
        assert.equal(payload.video.roomJoin, true);
        assert.equal(payload.video.canPublish, true);
        assert.equal(payload.video.canSubscribe, true);
        assert.equal(result.expiresIn, 600);
    } finally {
        for (const [key, value] of [["LIVEKIT_URL", previous.url], ["LIVEKIT_API_KEY", previous.key], ["LIVEKIT_API_SECRET", previous.secret]]) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
});

test("LiveKit configuration rejects partial credentials rather than issuing unsigned tokens", () => {
    const previous = { url: process.env.LIVEKIT_URL, key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET };
    delete process.env.LIVEKIT_URL;
    process.env.LIVEKIT_API_KEY = "partial-key";
    delete process.env.LIVEKIT_API_SECRET;
    try { assert.throws(() => new LiveKitService(), /must be configured together/); }
    finally {
        for (const [key, value] of [["LIVEKIT_URL", previous.url], ["LIVEKIT_API_KEY", previous.key], ["LIVEKIT_API_SECRET", previous.secret]]) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
});

test("MySQL serializes overlapping active calls by locking both participant rows", { skip: process.env.CALLS_DB_TESTS !== "1" }, async () => {
    const prisma = new PrismaService();
    const marker = `calls-${crypto.randomUUID()}`;
    const emails = [1, 2, 3].map(index => `${marker}-${index}@example.invalid`);
    try {
        const result = await prisma.$transaction(async tx => {
            const [caller, firstPeer, secondPeer] = await Promise.all(emails.map(email => tx.users.create({ data: { email, password_hash: "test-only" } })));
            for (const peer of [firstPeer, secondPeer]) {
                const low = caller.id < peer.id ? caller.id : peer.id;
                const high = caller.id < peer.id ? peer.id : caller.id;
                await tx.friendships.create({ data: { requester_id: caller.id, addressee_id: peer.id, user_low_id: low, user_high_id: high, status: "accepted" } });
            }
            const conversations = await Promise.all([firstPeer, secondPeer].map(peer => tx.conversations.create({
                data: {
                    type: "direct", created_by: caller.id,
                    direct_user_low_id: caller.id < peer.id ? caller.id : peer.id,
                    direct_user_high_id: caller.id < peer.id ? peer.id : caller.id,
                    conversation_members: { create: [{ user_id: caller.id }, { user_id: peer.id }] },
                },
            })));
            return { caller, firstPeer, secondPeer, conversations };
        });
        const service = new CallsService(prisma, livekit, realtime);
        const started = await Promise.allSettled(result.conversations.map((conversation, index) => service.start(result.caller.id, {
            conversationId: conversation.id,
            callType: "audio",
            idempotencyKey: index === 0 ? "a9733de2-fcb4-4e91-b96e-90ac8d400001" : "a9733de2-fcb4-4e91-b96e-90ac8d400002",
        })));
        assert.equal(started.filter(item => item.status === "fulfilled").length, 1);
        assert.equal(started.filter(item => item.status === "rejected" && item.reason instanceof ConflictException).length, 1);
    } finally {
        await prisma.users.deleteMany({ where: { email: { in: emails } } });
        await prisma.$disconnect();
    }
});
