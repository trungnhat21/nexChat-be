import "dotenv/config";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Module, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthGuard } from "../dist/auth/auth.guard.js";
import { AuthService } from "../dist/auth/auth.service.js";
import { createAccessToken } from "../dist/utils/token.js";
import { PostsController } from "../dist/posts/posts.controller.js";
import { PostsService } from "../dist/posts/posts.service.js";
import { PrismaService } from "../dist/prisma/prisma.service.js";
import { parseComment, parseRepost } from "../dist/posts/posts.validation.js";

test("comment/repost validation rejects empty content, replies, injected owners and invalid privacy", () => {
    for (const body of [null, [], {}, { content: "  " }, { content: 3 }, { content: "x".repeat(2001) }, { content: "x", userId: "2" }, { content: "x", parentCommentId: "2" }]) assert.throws(() => parseComment(body), BadRequestException);
    assert.equal(parseComment({ content: " hello " }), "hello");
    for (const body of [[], "x", { privacy: "unknown" }, { content: "x", originalId: "2" }, { content: "x".repeat(5001) }]) assert.throws(() => parseRepost(body), BadRequestException);
    assert.equal(parseRepost({}).content, "");
});

test("HTTP comments, saves, links and reposts require session ownership and validate IDs", async () => {
    const calls = [];
    const service = Object.fromEntries(["list", "get", "listComments", "mutateComment", "setSaved", "repost"].map(name => [name, async (...args) => { calls.push({ name, args }); return { success: true }; }]));
    class TestModule {}
    Module({ controllers: [PostsController], providers: [AuthGuard,
        { provide: AuthService, useValue: { getSessionCurrentUser: async (sid, id) => sid === "interactions-test" && id === 1n ? { id: "1" } : null } },
        { provide: PostsService, useValue: service },
    ] })(TestModule);
    const app = await NestFactory.create(TestModule, { logger: false }); await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const headers = { Authorization: "Bearer " + createAccessToken(1n, "interactions-test"), "Content-Type": "application/json" };
    const routes = [["GET", "/saved?authorId=999"], ["GET", "/12"], ["GET", "/12/comments"], ["POST", "/12/comments", { content: "Hi" }], ["PATCH", "/12/comments/3", { content: "Edited" }], ["DELETE", "/12/comments/3"], ["PUT", "/12/save"], ["DELETE", "/12/save"], ["POST", "/12/repost", { content: "Quote", privacy: "friends" }]];
    try {
        for (const [method, path, body] of routes) {
            assert.equal((await fetch(base + "/api/posts" + path, { method })).status, 401);
            const response = await fetch(base + "/api/posts" + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
            assert.equal(response.status, method === "POST" ? 201 : 200);
            assert.equal(calls.at(-1).args[0], 1n);
        }
        assert.equal(calls[0].name, "list"); assert.equal(calls[0].args[3], undefined); assert.equal(calls[0].args[4], true, "saved list ignores another account id");
        for (const path of ["/invalid/comments", "/12/comments?cursor=0", "/0", "/saved?cursor=bad"]) assert.equal((await fetch(base + "/api/posts" + path, { headers })).status, 400);
        assert.equal((await fetch(base + "/api/posts/12/comments", { method: "POST", headers, body: JSON.stringify({ content: "Hi", user_id: "99" }) })).status, 400);
    } finally { await app.close(); }
});

test("MySQL: own comment CRUD, paging, private saves, referenced reposts and revoked original access; fixtures roll back", { skip: process.env.INTERACTIONS_DB_TESTS !== "1" }, async () => {
    const prisma = new PrismaService(), marker = "interactions-" + crypto.randomUUID(), rollback = Error("ROLLBACK_INTERACTIONS");
    try {
        await assert.rejects(prisma.$transaction(async tx => {
            const owner = await tx.users.create({ data: { email: marker + "1@example.invalid", password_hash: "test-only" } });
            const actor = await tx.users.create({ data: { email: marker + "2@example.invalid", password_hash: "test-only" } });
            const stranger = await tx.users.create({ data: { email: marker + "3@example.invalid", password_hash: "test-only" } });
            const adapter = new Proxy(tx, { get: (target, key) => key === "$transaction" ? callback => callback(tx) : target[key] });
            const service = new PostsService(adapter, { url: async key => "https://example.invalid/" + key, remove: async () => {} });
            const original = await tx.posts.create({ data: { user_id: owner.id, content: marker, privacy: "public" } });
            await tx.attachments.create({ data: { owner_type: "post", owner_id: original.id, file_url: "fixture-image", file_type: "image/png" } });

            const added = await service.mutateComment(actor.id, original.id, "First comment");
            const commentId = BigInt(added.comment.id);
            assert.equal(added.total, 1);
            assert.equal((await service.listComments(actor.id, original.id)).comments[0].canEdit, true);
            assert.equal((await service.listComments(owner.id, original.id)).comments[0].canEdit, false);
            await assert.rejects(service.mutateComment(owner.id, original.id, "Attack", commentId), ForbiddenException);
            await assert.rejects(service.mutateComment(stranger.id, original.id, null, commentId), ForbiddenException);
            assert.equal((await service.mutateComment(actor.id, original.id, "Changed", commentId)).comment.content, "Changed");
            const another = await tx.posts.create({ data: { user_id: owner.id, content: "other" } });
            await assert.rejects(service.mutateComment(actor.id, another.id, "Wrong post", commentId), NotFoundException);
            await tx.comments.createMany({ data: Array.from({ length: 22 }, (_, i) => ({ user_id: actor.id, post_id: original.id, content: "Comment " + i })) });
            const c1 = await service.listComments(actor.id, original.id), c2 = await service.listComments(actor.id, original.id, BigInt(c1.nextCursor));
            assert.equal(c1.comments.length, 20); assert.equal(c2.comments.length, 3); assert.equal(c1.total, 23);
            assert.ok(!c2.comments.some(comment => c1.comments.some(other => other.id === comment.id)));
            const deleted = await service.mutateComment(actor.id, original.id, null, commentId);
            assert.equal(deleted.total, 22); assert.equal(deleted.comment, null);
            await assert.rejects(service.mutateComment(actor.id, original.id, "Undelete", commentId), NotFoundException);

            await service.setSaved(actor.id, original.id, true); await service.setSaved(actor.id, original.id, true);
            assert.equal(await tx.saved_posts.count({ where: { user_id: actor.id, post_id: original.id } }), 1);
            assert.equal((await service.list(actor.id, undefined, marker, undefined, true)).posts[0].saved, true);
            assert.equal((await service.list(stranger.id, undefined, marker, undefined, true)).posts.length, 0);
            await service.setSaved(actor.id, original.id, false); await service.setSaved(actor.id, original.id, false);
            assert.equal((await service.list(actor.id, undefined, marker, undefined, true)).posts.length, 0);

            const shared = await service.repost(actor.id, original.id, parseRepost({ content: "My quote" }));
            assert.equal(shared.post.content, "My quote"); assert.equal(shared.post.media.length, 0); assert.equal(shared.post.isRepost, true);
            assert.equal(shared.post.original.id, original.id.toString()); assert.equal(shared.post.original.media.length, 1);
            const sharedId = BigInt(shared.post.id);
            assert.equal((await tx.posts.findUnique({ where: { id: sharedId } })).shared_post_id, original.id);
            const reshare = await service.repost(stranger.id, sharedId, parseRepost({}));
            assert.equal(reshare.post.original.id, original.id.toString(), "reposts reference root, not copied content");
            await tx.posts.update({ where: { id: original.id }, data: { content: "Updated original", privacy: "friends" } });
            assert.equal((await service.get(stranger.id, sharedId)).post.original, null, "no original content or signed media leaks");
            await assert.rejects(service.repost(stranger.id, sharedId, parseRepost({})), ForbiddenException);
            await assert.rejects(service.setSaved(stranger.id, original.id, true), ForbiddenException);
            await assert.rejects(service.listComments(stranger.id, original.id), ForbiddenException);
            await assert.rejects(service.mutateComment(stranger.id, original.id, "Private"), ForbiddenException);
            await tx.friendships.create({ data: { requester_id: owner.id, addressee_id: actor.id, status: "accepted" } });
            assert.equal((await service.get(actor.id, sharedId)).post.original.content, "Updated original");
            await service.setSaved(actor.id, original.id, true);
            await tx.posts.update({ where: { id: original.id }, data: { privacy: "private" } });
            assert.equal((await service.list(actor.id, undefined, "", undefined, true)).posts.length, 0);
            await service.setSaved(actor.id, original.id, false);
            assert.equal(await tx.saved_posts.count({ where: { user_id: actor.id } }), 0, "can unsave after access revoked");
            await tx.posts.update({ where: { id: original.id }, data: { deleted_at: new Date() } });
            assert.equal((await service.get(owner.id, sharedId)).post.original, null);
            await assert.rejects(service.listComments(owner.id, original.id), NotFoundException);
            throw rollback;
        }, { timeout: 300000 }), error => error === rollback);
        assert.equal(await prisma.users.count({ where: { email: { startsWith: marker } } }), 0);
    } finally { await prisma.$disconnect(); }
});
