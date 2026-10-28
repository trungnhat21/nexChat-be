import test from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MessagingService } from "../dist/messaging/messaging.service.js";
import { NotificationsGateway } from "../dist/notifications/notifications.gateway.js";
import { createAccessToken } from "../dist/utils/token.js";
import { parseClientMessageId, parseDirectRecipient, parseMessageContent, parseMessageCursor, parseMessageLimit, parseMessagingId, parseSendMessage, parseVisibleMessageIds } from "../dist/messaging/messaging.validation.js";

const uuid = "d4d8c9f1-3d4d-4a17-8f62-5784fc9520d1";

test("validates recipient IDs, cursors, limits, message bodies, and idempotency keys", () => {
    assert.equal(parseMessagingId("42"), 42n);
    assert.equal(parseDirectRecipient({ recipientId: "9" }), 9n);
    assert.equal(parseMessageCursor(undefined), undefined);
    assert.equal(parseMessageCursor("18"), 18n);
    assert.equal(parseMessageLimit(undefined), 30);
    assert.equal(parseMessageLimit("50"), 50);
    assert.deepEqual(parseVisibleMessageIds(["3", "3", "4"]), [3n, 4n]);
    assert.equal(parseMessageContent("  hello  "), "hello");
    assert.deepEqual(parseSendMessage({ content: "Hi", clientMessageId: uuid }), { content: "Hi", clientMessageId: uuid });
    for (const value of ["0", "-1", "1 OR 1=1", "18446744073709551616", 1, null]) assert.throws(() => parseMessagingId(value), BadRequestException);
    for (const body of [null, {}, { recipientId: 2 }, { recipientId: "0" }]) assert.throws(() => parseDirectRecipient(body), BadRequestException);
    for (const value of ["", "  ", "x".repeat(4001), null]) assert.throws(() => parseMessageContent(value), BadRequestException);
    for (const value of ["nope", "00000000-0000-0000-0000-000000000000", null]) assert.throws(() => parseClientMessageId(value), BadRequestException);
    for (const value of ["0", "51", "1;drop", 2]) assert.throws(() => parseMessageLimit(value), BadRequestException);
});

test("creates one canonical direct conversation and reuses it on later requests", async () => {
    let createCount = 0;
    let createdData;
    const tx = {
        users: { findFirst: async () => ({ id: 1n }) },
        friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 99n } : null },
        conversations: {
            findUnique: async () => createCount ? { id: 25n } : null,
            create: async ({ data }) => { createCount++; createdData = data; return { id: 25n }; },
        },
    };
    const service = new MessagingService({ $transaction: callback => callback(tx) }, {}, {});
    const created = await service.getOrCreateDirect(9n, 2n);
    const reused = await service.getOrCreateDirect(2n, 9n);
    assert.deepEqual(created, { success: true, conversationId: "25", reused: false });
    assert.deepEqual(reused, { success: true, conversationId: "25", reused: true });
    assert.equal(createCount, 1);
    assert.equal(createdData.direct_user_low_id, 2n);
    assert.equal(createdData.direct_user_high_id, 9n);
    assert.equal(createdData.conversation_members.create.length, 2);
});

test("blocks self messaging and denies message access to non-members", async () => {
    const service = new MessagingService({}, {}, {});
    await assert.rejects(service.getOrCreateDirect(4n, 4n), ForbiddenException);
    const tx = {
        conversations: { findFirst: async () => ({ id: 30n }) },
        conversation_members: { findMany: async () => [{ user_id: 2n }, { user_id: 3n }] },
    };
    const guarded = new MessagingService({ $transaction: callback => callback(tx) }, {}, {});
    await assert.rejects(guarded.listMessages(1n, 30n, undefined, 30), NotFoundException);
});

test("requires an accepted friendship before creating a direct conversation", async () => {
    const tx = {
        users: { findFirst: async () => ({ id: 1n }) },
        friendships: { findFirst: async () => null },
        conversations: { findUnique: async () => null, create: async () => assert.fail("must not create a conversation") },
    };
    const service = new MessagingService({ $transaction: callback => callback(tx) }, {}, {});
    await assert.rejects(service.getOrCreateDirect(1n, 2n), ForbiddenException);
});

test("loads a descending cursor page as chronological messages and returns the next cursor", async () => {
    const sender = { id: 2n, user_name: "other", first_name: "Other", last_name: "User", avatar: null, status: "active", deleted: "NO", profiles: null };
    const rows = [3n, 2n, 1n].map(id => ({
        id, conversation_id: 12n, sender_id: 2n, client_message_id: null,
        content: `Message ${id}`, created_at: new Date(Number(id) * 1000), delivered_at: null, message_reads: [], users: sender,
    }));
    let messageQueries = 0;
    const tx = {
        conversations: { findFirst: async () => ({ id: 12n }) },
        conversation_members: { findMany: async () => [{ user_id: 1n }, { user_id: 2n }] },
        users: { findFirst: async () => ({ id: 2n }) },
        friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 99n } : null },
        messages: { findMany: async () => messageQueries++ === 0 ? rows : [] },
        message_reads: { createMany: async () => ({ count: 0 }) },
    };
    const service = new MessagingService({ $transaction: callback => callback(tx) }, {}, {});
    const page = await service.listMessages(1n, 12n, undefined, 2);
    assert.deepEqual(page.messages.map(message => message.id), ["2", "3"]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor, "2");
    assert.equal(page.messages[0].sender.name, "User Other");
});

test("message retries with the same key return the saved message without inserting duplicates", async () => {
    const stored = new Map();
    let creates = 0;
    const sender = { id: 1n, user_name: "sender", first_name: "Test", last_name: "Sender", avatar: null, profiles: null };
    const tx = {
        conversations: { findFirst: async () => ({ id: 12n }), update: async () => ({}) },
        users: { findFirst: async () => ({ id: 2n }) },
        conversation_members: { findMany: async () => [{ user_id: 1n }, { user_id: 2n }] },
        friendships: { findFirst: async ({ where }) => where.status === "accepted" ? { id: 99n } : null },
        messages: {
            findUnique: async () => stored.get(uuid) ?? null,
            create: async ({ data }) => {
                creates++;
                const row = { id: 55n, conversation_id: 12n, sender_id: 1n, client_message_id: data.client_message_id, content: data.content, created_at: new Date("2026-10-23T10:00:00.000Z"), delivered_at: null, message_reads: [], users: sender };
                stored.set(uuid, row);
                return row;
            },
        },
    };
    const delivered = [];
    const prisma = { $transaction: callback => callback(tx), conversation_members: { findMany: async () => [{ user_id: 1n }, { user_id: 2n }] } };
    const service = new MessagingService(prisma, { url: async value => value }, { notifyMessage: (userId, payload) => delivered.push({ userId, payload }) });
    const first = await service.sendMessage(1n, 12n, "Hello", uuid);
    const retry = await service.sendMessage(1n, 12n, "Hello", uuid);
    assert.equal(first.message.id, "55");
    assert.equal(first.message.status, "sent");
    assert.equal(retry.message.id, "55");
    assert.equal(creates, 1);
    assert.equal(delivered.length, 4);
    assert.equal(delivered[0].payload.message.sender.name, "Sender Test");
});

test("presence tracks multiple tabs and expires stale heartbeat sessions", () => {
    const gateway = new NotificationsGateway({}, {});
    gateway.sessions.set("9", new Map([["tab-a", Date.now()], ["tab-b", Date.now()]]));
    assert.equal(gateway.isOnline(9n), true);
    gateway.sessions.get("9").delete("tab-a");
    assert.equal(gateway.isOnline("9"), true);
    gateway.sessions.get("9").set("tab-b", Date.now() - 80_000);
    assert.equal(gateway.isOnline("9"), false);
    gateway.onModuleDestroy();
});

test("authenticated socket receives a friend presence snapshot without waiting for presence:watch", async () => {
    const emitted = [];
    const handlers = new Map();
    const client = {
        id: "fresh-tab",
        handshake: { auth: { token: createAccessToken(1n, "presence-snapshot-test") } },
        data: {},
        conn: { on() {} },
        join: async () => {},
        on: (event, handler) => handlers.set(event, handler),
        emit: (event, payload) => emitted.push({ event, payload }),
        disconnect() { assert.fail("valid session should stay connected"); },
    };
    const gateway = new NotificationsGateway(
        { getSessionCurrentUser: async (sessionId, userId) => sessionId === "presence-snapshot-test" && userId === 1n ? { id: "1" } : null },
        { friendships: { findMany: async () => [{ requester_id: 1n, addressee_id: 2n }] } },
    );
    gateway.sessions.set("2", new Map([["friend-tab", Date.now()]]));
    gateway.server = { to: () => ({ emit() {} }) };

    await gateway.handleConnection(client);

    const snapshot = emitted.find(item => item.event === "presence:snapshot");
    assert.deepEqual(snapshot?.payload, { "2": true });
    assert.equal(handlers.has("presence:watch"), true, "manual/reconnect resync remains available");
    gateway.onModuleDestroy();
});

test("delivered receipts require an accepted conversation member and persist only once", async () => {
    let deliveredAt = null;
    let updates = 0;
    const events = [];
    const prisma = {
        conversations: { findFirst: async () => ({ conversation_members: [{ user_id: 1n }, { user_id: 2n }] }) },
        friendships: { findFirst: async () => ({ id: 8n }) },
        messages: {
            findFirst: async () => ({ id: 42n, delivered_at: deliveredAt }),
            updateMany: async () => { if (deliveredAt) return { count: 0 }; updates++; deliveredAt = new Date(); return { count: 1 }; },
        },
    };
    const gateway = new NotificationsGateway({}, prisma);
    gateway.server = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
    const client = { id: "recipient-tab", data: { userId: "2" } };
    await gateway.markDelivered(client, { conversationId: "7", messageId: "42" });
    await gateway.markDelivered(client, { conversationId: "7", messageId: "42" });
    assert.equal(updates, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].room, "user:1");
    assert.equal(events[0].payload.status, "delivered");
    gateway.onModuleDestroy();
});

test("read receipts require the authorized conversation to be open and ignore the reader's own messages", async () => {
    const writes = [];
    const events = [];
    const prisma = {
        conversations: { findFirst: async () => ({ conversation_members: [{ user_id: 1n }, { user_id: 2n }] }) },
        friendships: { findFirst: async () => ({ id: 8n }) },
        messages: { findMany: async ({ where }) => {
            assert.equal(where.sender_id, 1n);
            return [{ id: 42n }];
        } },
        message_reads: { createMany: async ({ data }) => { writes.push(...data); return { count: data.length }; } },
    };
    const gateway = new NotificationsGateway({}, prisma);
    gateway.server = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
    const client = { id: "reader-tab", data: { userId: "2" } };
    let denied;
    await gateway.markRead(client, { conversationId: "7", messageIds: ["42"] }, result => { denied = result; });
    assert.equal(denied.success, false);
    assert.equal(writes.length, 0);
    await gateway.openConversation(client, { conversationId: "7" });
    let accepted;
    await gateway.markRead(client, { conversationId: "7", messageIds: ["42", "43"] }, result => { accepted = result; });
    assert.deepEqual(writes, [{ message_id: 42n, user_id: 2n }]);
    assert.deepEqual(accepted.readIds, ["42"]);
    assert.equal(events[0].room, "user:1");
    assert.equal(events[0].payload.status, "read");
    gateway.onModuleDestroy();
});

test("typing events are sent only to an accepted conversation peer and stop cleanly", async () => {
    const events = [];
    const prisma = {
        conversations: { findFirst: async () => ({ conversation_members: [{ user_id: 1n }, { user_id: 2n }] }) },
        friendships: { findFirst: async () => ({ id: 8n }) },
    };
    const gateway = new NotificationsGateway({}, prisma);
    gateway.server = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
    const client = { id: "typing-tab", data: { userId: "2" } };
    await gateway.handleTyping(client, { conversationId: "7" }, true);
    await gateway.handleTyping(client, { conversationId: "7" }, true);
    await gateway.handleTyping(client, { conversationId: "7" }, false);
    assert.deepEqual(events.map(event => event.room), ["user:1", "user:1"]);
    assert.deepEqual(events.map(event => event.payload.isTyping), [true, false]);
    gateway.onModuleDestroy();
});
