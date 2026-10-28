import test from "node:test";
import assert from "node:assert/strict";
import { NotificationsGateway } from "../dist/notifications/notifications.gateway.js";

const makeCall = (overrides = {}) => ({
    id: 70n,
    conversation_id: 22n,
    initiated_by: 4n,
    call_type: "video",
    status: "ringing",
    created_at: new Date("2026-10-26T10:00:00.000Z"),
    accepted_at: null,
    ended_at: null,
    end_reason: null,
    call_participants: [{ user_id: 4n, role: "caller" }, { user_id: 9n, role: "callee" }],
    ...overrides,
});

function setup(initialCall = makeCall(), activity = null) {
    let currentCall = initialCall;
    const events = [];
    let reads = 0;
    const roomSockets = new Map([["user:4", ["caller-tab-a", "caller-phone"]], ["user:9", ["callee-tab-a", "callee-tab-b"]]]);
    const gateway = new NotificationsGateway({}, {
        call_sessions: { findUnique: async () => { reads++; return currentCall; } },
        messages: { findFirst: async () => activity },
    });
    gateway.server = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload, sockets: roomSockets.get(room) ?? [] }) }) };
    return { gateway, events, get reads() { return reads; }, set call(value) { currentCall = value; } };
}

test("outgoing and incoming call events go only to authenticated participants' private user rooms", async () => {
    const { gateway, events } = setup();
    await gateway.notifyCallStarted(70n, 4n);
    assert.deepEqual(events.map(item => [item.room, item.event]), [["user:4", "call:outgoing"], ["user:9", "call:incoming"]]);
    assert.deepEqual(events.map(item => item.sockets.length), [2, 2], "Socket.IO user rooms fan out to each connected tab/device");
    assert.deepEqual(events[0].payload, {
        eventId: "70:outgoing", callId: "70", conversationId: "22", callerId: "4", calleeId: "9",
        callType: "video", status: "ringing", createdAt: "2026-10-26T10:00:00.000Z", acceptedAt: null, endedAt: null, endReason: null,
    });
    assert.equal(JSON.stringify(events).includes("room_name"), false);
    gateway.onModuleDestroy();
});

test("only the authorized caller can emit start events and persisted call state must still be ringing", async () => {
    const ctx = setup();
    await ctx.gateway.notifyCallStarted(70n, 9n);
    assert.equal(ctx.events.length, 0, "callee cannot impersonate caller");
    ctx.call = makeCall({ status: "cancelled" });
    await ctx.gateway.notifyCallStarted(70n, 4n);
    assert.equal(ctx.events.length, 0, "stale ringing event is suppressed after cancellation");
    ctx.gateway.onModuleDestroy();
});

test("transition events validate persisted state and actor role before notifying both participants", async () => {
    const ctx = setup(makeCall({ status: "accepted", accepted_at: new Date("2026-10-26T10:00:05.000Z") }));
    await ctx.gateway.notifyCallTransition(70n, 4n, "accepted");
    assert.equal(ctx.events.length, 0, "caller cannot act as the callee who accepted");
    await ctx.gateway.notifyCallTransition(70n, 9n, "accepted");
    assert.deepEqual(ctx.events.map(item => item.room), ["user:4", "user:9"]);
    assert.ok(ctx.events.every(item => item.event === "call:accepted" && item.payload.status === "accepted"));
    assert.equal(ctx.events[0].payload.acceptedAt, "2026-10-26T10:00:05.000Z");
    ctx.gateway.onModuleDestroy();
});

test("duplicate state events are emitted once per participant room and event is broadcast to every tab in that room", async () => {
    const ctx = setup(makeCall({ status: "ended", ended_at: new Date("2026-10-26T10:01:00.000Z"), end_reason: "ended" }));
    await ctx.gateway.notifyCallTransition(70n, 4n, "ended");
    await ctx.gateway.notifyCallTransition(70n, 4n, "ended");
    assert.equal(ctx.events.length, 2);
    assert.deepEqual(ctx.events.map(item => item.room), ["user:4", "user:9"]);
    assert.ok(ctx.events.every(item => item.event === "call:ended" && item.payload.eventId === "70:ended"));
    ctx.gateway.onModuleDestroy();
});

test("terminal state suppresses stale transitions, and unrelated users never receive call payloads", async () => {
    const ctx = setup(makeCall({ status: "ended", ended_at: new Date(), end_reason: "ended" }));
    await ctx.gateway.notifyCallTransition(70n, 9n, "cancelled");
    await ctx.gateway.notifyCallTransition(70n, 99n, "ended");
    assert.equal(ctx.events.length, 0);
    assert.equal(ctx.reads, 2);
    ctx.gateway.onModuleDestroy();
});

test("timed-out ringing calls notify only the two persisted participants", async () => {
    const ctx = setup(makeCall({ status: "ended", ended_at: new Date("2026-10-26T10:00:30.000Z"), end_reason: "timeout" }));
    await ctx.gateway.notifyCallTimedOut(70n);
    assert.deepEqual(ctx.events.map(item => [item.room, item.event]), [["user:4", "call:ended"], ["user:9", "call:ended"]]);
    assert.ok(ctx.events.every(item => item.payload.status === "ended" && item.payload.endReason === "timeout"));
    await ctx.gateway.notifyCallTimedOut(70n);
    assert.equal(ctx.events.length, 2, "duplicate timeout notifications are deduplicated");
    ctx.gateway.onModuleDestroy();
});

test("persisted call activity is delivered to both participants as a deduplicated chat message", async () => {
    const activity = { id: 901n, content: "Cuộc gọi video · 1 phút 12 giây", created_at: new Date("2026-10-26T10:01:12.000Z"), client_message_id: "call-70-activity" };
    const ctx = setup(makeCall({ status: "ended", ended_at: activity.created_at, accepted_at: new Date("2026-10-26T10:00:00.000Z"), end_reason: "ended" }), activity);
    await ctx.gateway.notifyCallTransition(70n, 4n, "ended");
    const messages = ctx.events.filter(event => event.event === "message:new");
    assert.deepEqual(messages.map(event => event.room), ["user:4", "user:9"]);
    assert.ok(messages.every(event => event.payload.id === "901" && event.payload.messageType === "system" && event.payload.content === activity.content));
    await ctx.gateway.notifyCallTransition(70n, 4n, "ended");
    assert.equal(ctx.events.filter(event => event.event === "message:new").length, 2);
    ctx.gateway.onModuleDestroy();
});
