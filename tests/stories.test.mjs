import test from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { StoriesService } from "../dist/stories/stories.service.js";
import { parseStoryId, parseStoryInput, parseStoryReaction, validateStoryMedia } from "../dist/stories/stories.validation.js";

const owner = { id: 2n, first_name: "Story", last_name: "Owner", user_name: "owner", avatar: null, profiles: null };
function storyRow(id, fields = {}) {
    return {
        id: BigInt(id), owner_id: 2n, media_key: `stories/2/${String(id).padStart(8, "0")}-0000-4000-8000-000000000000.png`,
        media_type: "image/png", file_name: "story.png", file_size: 100n, caption: null, visibility: "friends",
        created_at: new Date("2026-10-24T00:00:00Z"), expires_at: new Date(Date.now() + 60_000), deleted_at: null,
        users: owner, story_views: [], _count: { story_views: 0 }, ...fields,
    };
}

test("validates story IDs, captions, visibility, and image bytes", () => {
    assert.equal(parseStoryId("45"), 45n);
    for (const id of ["0", "-1", "abc", "18446744073709551616", 5]) assert.throws(() => parseStoryId(id), BadRequestException);
    assert.deepEqual(parseStoryInput({ caption: " hi ", visibility: "followers" }), { caption: "hi", visibility: "followers" });
    for (const input of [{ visibility: "unknown" }, { caption: "x".repeat(501) }, { extra: true }]) assert.throws(() => parseStoryInput(input), BadRequestException);
    const png = { originalname: "not-trusted.png", mimetype: "image/png", size: 8, buffer: Buffer.from([137,80,78,71,13,10,26,10]) };
    assert.doesNotThrow(() => validateStoryMedia(png));
    assert.throws(() => validateStoryMedia({ ...png, mimetype: "image/jpeg" }), BadRequestException);
    assert.throws(() => validateStoryMedia(undefined), BadRequestException);
    assert.equal(parseStoryReaction({ reaction: "❤️" }), "❤️");
    assert.throws(() => parseStoryReaction({ reaction: "not-an-emoji" }), BadRequestException);
});

test("lists only eligible active stories in pages of five with a cursor", async () => {
    let query;
    const prisma = {
        stories: { findMany: async args => { if (args.select) return []; query = args; return [6, 5, 4, 3, 2, 1].map(id => storyRow(id)); } },
        friendships: { findMany: async () => [{ requester_id: 1n, addressee_id: 2n }] },
        follows: { findMany: async () => [{ following_id: 8n }] },
    };
    const service = new StoriesService(prisma, { url: async key => `signed:${key}`, remove: async () => undefined });
    const page = await service.list(1n);
    assert.equal(query.take, 6);
    assert.equal(page.stories.length, 5);
    assert.equal(page.nextCursor, "2");
    assert.deepEqual(query.where.OR[2].owner_id.in, [2n]);
    assert.deepEqual(query.where.OR[3].owner_id.in, [8n]);
    assert.ok(query.where.expires_at.gt instanceof Date);
});

test("publishes media metadata with a 24-hour expiry and removes upload when database write fails", async () => {
    const file = { originalname: "photo.png", mimetype: "image/png", size: 8, buffer: Buffer.from([137,80,78,71,13,10,26,10]) };
    const uploaded = [];
    const prisma = { stories: { findMany: async () => [], findFirst: async () => null, create: async ({ data }) => { uploaded.push(data); return storyRow(80, { ...data, id: 80n, users: owner, story_views: [], _count: { story_views: 0 } }); } }, friendships: { findMany: async () => [] }, follows: { findMany: async () => [] } };
    const storage = { upload: async () => ({ key: "stories/1/00000000-0000-4000-8000-000000000000.png", type: file.mimetype, name: file.originalname, size: file.size }), url: async key => `signed:${key}`, remove: async () => undefined };
    const service = new StoriesService(prisma, storage);
    const before = Date.now();
    const result = await service.publish(1n, file, "caption", "public");
    assert.equal(result.story.caption, "caption");
    assert.equal(uploaded[0].media_key, "stories/1/00000000-0000-4000-8000-000000000000.png");
    assert.ok(uploaded[0].expires_at.getTime() >= before + 24 * 60 * 60 * 1000 - 100);
    assert.ok(uploaded[0].expires_at.getTime() <= Date.now() + 24 * 60 * 60 * 1000);

    let removed = false;
    const broken = new StoriesService({ ...prisma, stories: { ...prisma.stories, create: async () => { throw new Error("db failure"); } } }, { ...storage, remove: async () => { removed = true; } });
    await assert.rejects(() => broken.publish(1n, file, "", "friends"), /db failure/);
    assert.equal(removed, true);
});

test("records one viewer without counting the owner and restricts viewer lists and deletion", async () => {
    const row = storyRow(55);
    let viewWrites = 0;
    let deleteRows = [];
    const prisma = {
        friendships: { findMany: async () => [{ requester_id: 1n, addressee_id: 2n }] }, follows: { findMany: async () => [] },
        stories: {
            findMany: async args => args.select ? deleteRows : [],
            findFirst: async ({ where }) => !where.owner_id || where.owner_id === 2n ? row : null,
            findUnique: async () => ({ ...row, story_views: [{ viewer_id: 1n }], _count: { story_views: 1 } }),
            updateMany: async ({ where, data }) => { if (where.owner_id !== 2n) return { count: 0 }; deleteRows = [{ id: 55n, media_key: row.media_key }]; return { count: 1 }; },
            deleteMany: async () => ({ count: 1 }),
        },
        story_views: { createMany: async args => { viewWrites += args.data.length; assert.equal(args.skipDuplicates, true); return { count: args.data.length }; }, findMany: async () => [] },
    };
    const service = new StoriesService(prisma, { url: async key => `signed:${key}`, remove: async (_keys, strict) => { if (strict) deleteRows = []; } });
    const viewed = await service.view(1n, 55n);
    assert.equal(viewWrites, 1);
    assert.equal(viewed.story.viewed, true);
    await service.view(2n, 55n);
    assert.equal(viewWrites, 1);
    await assert.rejects(() => service.viewers(3n, 55n), NotFoundException);
    await assert.rejects(() => service.remove(3n, 55n), ForbiddenException);
    assert.deepEqual(await service.remove(2n, 55n), { success: true });
});

test("does not sign or return a private story to an unrelated viewer", async () => {
    let mediaSigned = false;
    let where;
    const prisma = {
        friendships: { findMany: async () => [] }, follows: { findMany: async () => [] },
        stories: { findFirst: async args => { where = args.where; return null; } },
    };
    const service = new StoriesService(prisma, { url: async () => { mediaSigned = true; return "signed"; }, remove: async () => undefined });
    await assert.rejects(() => service.view(9n, 77n), NotFoundException);
    assert.equal(mediaSigned, false);
    assert.ok(where.OR.some(rule => rule.visibility === "public"));
    assert.deepEqual(where.OR[2].owner_id.in, []);
    assert.deepEqual(where.OR[3].owner_id.in, []);
});

test("persists one reaction per visible story and returns its count and current user's reaction", async () => {
    const row = storyRow(91);
    const reactions = [];
    let writes = 0;
    const prisma = {
        friendships: { findMany: async () => [{ requester_id: 1n, addressee_id: 2n }] },
        follows: { findMany: async () => [] },
        stories: {
            findFirst: async () => row,
            findUnique: async () => ({ ...row, story_reactions: reactions }),
        },
        story_reactions: {
            upsert: async ({ create, update }) => {
                writes++;
                const existing = reactions.find(item => item.user_id === create.user_id);
                if (existing) existing.reaction = update.reaction;
                else reactions.push({ user_id: create.user_id, reaction: create.reaction });
            },
            deleteMany: async ({ where }) => {
                const index = reactions.findIndex(item => item.user_id === where.user_id);
                if (index >= 0) reactions.splice(index, 1);
            },
        },
    };
    const service = new StoriesService(prisma, { url: async key => `signed:${key}`, remove: async () => undefined });
    const first = await service.react(1n, 91n, "❤️");
    assert.equal(first.story.myReaction, "❤️");
    assert.equal(first.story.reactionCounts["❤️"], 1);
    await service.react(1n, 91n, "😂");
    assert.equal(writes, 2);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].reaction, "😂");
    const removed = await service.react(1n, 91n, null);
    assert.equal(removed.story.myReaction, null);
    assert.deepEqual(removed.story.reactionCounts, {});
});
