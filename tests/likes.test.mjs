import "dotenv/config";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Module, ForbiddenException, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthGuard } from "../dist/auth/auth.guard.js";
import { AuthService } from "../dist/auth/auth.service.js";
import { createAccessToken } from "../dist/utils/token.js";
import { PostsController } from "../dist/posts/posts.controller.js";
import { PostsService } from "../dist/posts/posts.service.js";
import { PrismaService } from "../dist/prisma/prisma.service.js";

test("like routes require authentication and use the session account with validated IDs", async () => {
    const calls = [];
    const service = { setLike: async (userId, id, liked) => { calls.push({ userId, id, liked }); return { success: true, id: id.toString(), liked, likes: liked ? 1 : 0 }; } };
    class TestModule {}
    Module({ controllers: [PostsController], providers: [AuthGuard,
        { provide: AuthService, useValue: { getSessionCurrentUser: async (session, id) => session === "likes-test" && id === 1n ? { id: "1" } : null } },
        { provide: PostsService, useValue: service },
    ] })(TestModule);
    const app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const headers = { Authorization: "Bearer " + createAccessToken(1n, "likes-test"), "Content-Type": "application/json" };
    try {
        for (const method of ["PUT", "DELETE"]) {
            assert.equal((await fetch(base + "/api/posts/12/like", { method })).status, 401);
            assert.equal((await fetch(base + "/api/posts/invalid/like", { method, headers })).status, 400);
            assert.equal((await fetch(base + "/api/posts/0/like", { method, headers })).status, 400);
            const response = await fetch(base + "/api/posts/12/like", { method, headers, body: JSON.stringify({ userId: "999" }) });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).liked, method === "PUT");
        }
        assert.deepEqual(calls, [{ userId: 1n, id: 12n, liked: true }, { userId: 1n, id: 12n, liked: false }]);
    } finally { await app.close(); }
});

test("denies reactions to missing, deleted and inaccessible posts before writing reactions", async () => {
    let post = null, friend = null, writes = 0;
    const tx = {
        $queryRaw: async () => [],
        posts: { findFirst: async () => post },
        friendships: { findFirst: async () => friend },
        reactions: { upsert: async () => { writes++; }, deleteMany: async () => { writes++; }, count: async () => 1 },
    };
    const service = new PostsService({ $transaction: callback => callback(tx) }, {});
    for (const liked of [true, false]) {
        await assert.rejects(service.setLike(1n, 2n, liked), NotFoundException);
        post = { user_id: 2n, privacy: "private" };
        await assert.rejects(service.setLike(1n, 2n, liked), ForbiddenException);
        post = { user_id: 2n, privacy: "friends" };
        await assert.rejects(service.setLike(1n, 2n, liked), ForbiddenException);
        post = null;
    }
    assert.equal(writes, 0);
    post = { user_id: 2n, privacy: "friends" }; friend = { id: 1n };
    assert.equal((await service.setLike(1n, 2n, true)).liked, true);
    post = { user_id: 1n, privacy: "private" };
    assert.equal((await service.setLike(1n, 2n, false)).liked, false);
});

test("real database: concurrent likes are unique, unlike is idempotent and feed state belongs to current account", { skip: process.env.LIKES_DB_TESTS !== "1" }, async () => {
    const prisma = new PrismaService();
    const marker = "likes-test-" + crypto.randomUUID();
    const users = [];
    const service = new PostsService(prisma, { url: async key => key });
    try {
        for (let i = 0; i < 3; i++) users.push(await prisma.users.create({ data: { email: marker + i + "@example.invalid", password_hash: "test-only" } }));
        const [owner, actor, stranger] = users;
        const post = await prisma.posts.create({ data: { user_id: owner.id, content: marker, privacy: "public" } });
        const where = { target_type: "post", target_id: post.id, reaction_type: "like" };
        const settled = await Promise.allSettled(Array.from({ length: 8 }, () => service.setLike(actor.id, post.id, true)));
        for (const result of settled) if (result.status === "rejected") throw result.reason;
        const repeated = settled.map(result => result.value);
        assert.ok(repeated.every(result => result.liked && result.likes === 1));
        assert.equal(await prisma.reactions.count({ where }), 1);
        // The database constraint also rejects a duplicate inserted outside this service.
        await assert.rejects(prisma.reactions.create({ data: { user_id: actor.id, ...where } }), error => error.code === "P2002");
        await service.setLike(owner.id, post.id, true);
        await prisma.reactions.create({ data: { user_id: stranger.id, target_type: "post", target_id: post.id, reaction_type: "love" } });
        await prisma.reactions.create({ data: { user_id: actor.id, target_type: "comment", target_id: post.id, reaction_type: "like" } });
        for (const [account, expected] of [[actor, true], [owner, true], [stranger, false]]) {
            const feed = await service.list(account.id, undefined, marker, owner.id);
            assert.equal(feed.posts[0].liked, expected);
            assert.equal(feed.posts[0].likes, 2, "counts only post likes");
        }
        const unlikeResults = await Promise.allSettled(Array.from({ length: 8 }, () => service.setLike(actor.id, post.id, false)));
        for (const result of unlikeResults) if (result.status === "rejected") throw result.reason;
        const unlikes = unlikeResults.map(result => result.value);
        assert.ok(unlikes.every(result => !result.liked && result.likes === 1));
        assert.equal((await service.list(actor.id, undefined, marker)).posts[0].liked, false);
        assert.equal((await service.setLike(actor.id, post.id, true)).likes, 2);

        await prisma.posts.update({ where: { id: post.id }, data: { privacy: "friends" } });
        await assert.rejects(service.setLike(actor.id, post.id, true), ForbiddenException);
        await prisma.friendships.create({ data: { requester_id: actor.id, addressee_id: owner.id, status: "pending" } });
        await assert.rejects(service.setLike(actor.id, post.id, false), ForbiddenException);
        await prisma.friendships.updateMany({ where: { requester_id: actor.id, addressee_id: owner.id }, data: { status: "accepted" } });
        assert.equal((await service.setLike(actor.id, post.id, false)).liked, false);
        await prisma.posts.update({ where: { id: post.id }, data: { privacy: "private" } });
        await assert.rejects(service.setLike(actor.id, post.id, true), ForbiddenException);
        assert.equal((await service.setLike(owner.id, post.id, false)).likes, 0);
        await prisma.posts.update({ where: { id: post.id }, data: { deleted_at: new Date() } });
        await assert.rejects(service.setLike(owner.id, post.id, true), NotFoundException);
        await assert.rejects(service.setLike(owner.id, 18446744073709551615n, false), NotFoundException);
    } finally {
        // Only isolated test accounts and their cascaded fixture rows are removed.
        try { await prisma.users.deleteMany({ where: { id: { in: users.map(user => user.id) }, email: { startsWith: marker } } });
        assert.equal(await prisma.users.count({ where: { email: { startsWith: marker } } }), 0);
        } finally { await prisma.$disconnect(); }
    }
});
