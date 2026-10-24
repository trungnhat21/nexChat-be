import { ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { PostStorageService } from "../posts/post-storage.service.js";
import type { UploadedMedia } from "../posts/posts.types.js";
import type { StoryReaction, StoryVisibility } from "./stories.validation.js";

const storyInclude = {
    users: { select: { id: true, first_name: true, last_name: true, user_name: true, avatar: true, profiles: { select: { display_name: true, avatar_url: true } } } },
    story_views: { select: { viewer_id: true } },
    story_reactions: { select: { user_id: true, reaction: true } },
    _count: { select: { story_views: true } },
} satisfies Prisma.storiesInclude;
type StoryRow = Prisma.storiesGetPayload<{ include: typeof storyInclude }>;

@Injectable()
export class StoriesService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(StoriesService.name);
    private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    private cleanupScheduleVersion = 0;
    constructor(private readonly prisma: PrismaService, private readonly storage: PostStorageService) {}

    onModuleInit() { void this.scheduleExpirationCleanup(); }

    onModuleDestroy() {
        this.cleanupScheduleVersion++;
        if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    }

    private async scheduleExpirationCleanup() {
        const version = ++this.cleanupScheduleVersion;
        if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
        this.cleanupTimer = undefined;
        try {
            await this.cleanupPending();
            const now = new Date();
            const pending = await this.prisma.stories.findFirst({
                where: { OR: [{ deleted_at: { not: null } }, { expires_at: { lte: now } }] }, select: { id: true },
            });
            let delay: number;
            if (pending) delay = 60_000;
            else {
                const next = await this.prisma.stories.findFirst({
                    where: { deleted_at: null, expires_at: { gt: now } }, orderBy: { expires_at: "asc" }, select: { expires_at: true },
                });
                if (!next) return;
                delay = Math.max(1, next.expires_at.getTime() - now.getTime());
            }
            if (version !== this.cleanupScheduleVersion) return;
            this.cleanupTimer = setTimeout(() => void this.scheduleExpirationCleanup(), delay);
            this.cleanupTimer.unref?.();
        } catch (error) {
            this.logger.warn(`Story expiration cleanup will retry: ${error instanceof Error ? error.name : "unknown"}`);
            if (version !== this.cleanupScheduleVersion) return;
            this.cleanupTimer = setTimeout(() => void this.scheduleExpirationCleanup(), 60_000);
            this.cleanupTimer.unref?.();
        }
    }

    private async cleanupPending() {
        const pending = await this.prisma.stories.findMany({
            where: { OR: [{ deleted_at: { not: null } }, { expires_at: { lte: new Date() } }] },
            select: { id: true, media_key: true }, orderBy: { id: "asc" }, take: 50,
        });
        for (const story of pending) {
            try {
                await this.storage.remove([story.media_key], true);
                await this.prisma.stories.deleteMany({ where: { id: story.id, OR: [{ deleted_at: { not: null } }, { expires_at: { lte: new Date() } }] } });
            } catch (error) {
                this.logger.warn(`Story cleanup will retry for ${story.id.toString()}: ${error instanceof Error ? error.name : "unknown"}`);
            }
        }
    }

    private async audience(userId: bigint) {
        const [friendships, follows] = await Promise.all([
            this.prisma.friendships.findMany({ where: { status: "accepted", OR: [{ requester_id: userId }, { addressee_id: userId }] }, select: { requester_id: true, addressee_id: true } }),
            this.prisma.follows.findMany({ where: { follower_id: userId }, select: { following_id: true } }),
        ]);
        return {
            friends: friendships.map(edge => edge.requester_id === userId ? edge.addressee_id : edge.requester_id),
            followed: follows.map(edge => edge.following_id),
        };
    }

    private async visibleStory(userId: bigint, storyId: bigint): Promise<StoryRow> {
        const { friends, followed } = await this.audience(userId);
        const story = await this.prisma.stories.findFirst({
            where: {
                id: storyId, deleted_at: null, expires_at: { gt: new Date() },
                OR: [
                    { owner_id: userId }, { visibility: "public" },
                    { visibility: "friends", owner_id: { in: friends } },
                    { visibility: "followers", owner_id: { in: followed } },
                ],
            }, include: storyInclude,
        });
        if (!story) throw new NotFoundException("Story was not found or is no longer available.");
        return story;
    }

    private async serialize(row: StoryRow, viewerId: bigint) {
        const remainingMs = row.expires_at.getTime() - Date.now();
        if (remainingMs <= 0) throw new NotFoundException("Story is no longer available.");
        const profileAvatar = row.users.profiles?.avatar_url || row.users.avatar;
        const avatar = profileAvatar?.startsWith("profiles/") ? await this.storage.url(profileAvatar, null, 300) : profileAvatar;
        const reactions = row.story_reactions ?? [];
        const reactionCounts = reactions.reduce<Record<string, number>>((counts, item) => { counts[item.reaction] = (counts[item.reaction] || 0) + 1; return counts; }, {});
        return {
            id: row.id.toString(), caption: row.caption, mediaType: row.media_type,
            mediaUrl: await this.storage.url(row.media_key, row.media_type, Math.min(300, Math.ceil(remainingMs / 1000))),
            fileName: row.file_name, fileSize: Number(row.file_size),
            createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
            visibility: row.visibility, viewed: row.owner_id === viewerId || row.story_views.some(view => view.viewer_id === viewerId),
            viewCount: row._count.story_views,
            reactionCounts,
            myReaction: reactions.find(item => item.user_id === viewerId)?.reaction ?? null,
            canDelete: row.owner_id === viewerId,
            owner: { id: row.users.id.toString(), name: row.users.profiles?.display_name || [row.users.last_name, row.users.first_name].filter(Boolean).join(" ") || row.users.user_name || "User", avatar },
        };
    }

    async list(userId: bigint, cursor?: bigint) {
        await this.cleanupPending();
        const { friends, followed } = await this.audience(userId);
        const rows = await this.prisma.stories.findMany({
            where: {
                deleted_at: null, expires_at: { gt: new Date() }, ...(cursor ? { id: { lt: cursor } } : {}),
                OR: [
                    { owner_id: userId }, { visibility: "public" },
                    { visibility: "friends", owner_id: { in: friends } },
                    { visibility: "followers", owner_id: { in: followed } },
                ],
            }, orderBy: { id: "desc" }, take: 6, include: storyInclude,
        });
        const hasMore = rows.length > 5;
        const page = rows.slice(0, 5);
        return { success: true, stories: await Promise.all(page.map(row => this.serialize(row, userId))), nextCursor: hasMore ? page.at(-1)?.id.toString() ?? null : null };
    }

    async publish(userId: bigint, file: UploadedMedia, caption: string, visibility: StoryVisibility) {
        await this.cleanupPending();
        const stored = await this.storage.upload(userId, file, "stories");
        let row: StoryRow;
        try {
            row = await this.prisma.stories.create({
                data: {
                    owner_id: userId, media_key: stored.key, media_type: stored.type, file_name: stored.name,
                    file_size: BigInt(stored.size), caption: caption || null, visibility,
                    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                }, include: storyInclude,
            });
        } catch (error) {
            await this.storage.remove([stored.key]);
            throw error;
        }
        void this.scheduleExpirationCleanup();
        return { success: true, story: await this.serialize(row, userId) };
    }

    async view(userId: bigint, storyId: bigint) {
        const row = await this.visibleStory(userId, storyId);
        if (row.owner_id !== userId) {
            await this.prisma.story_views.createMany({ data: [{ story_id: storyId, viewer_id: userId }], skipDuplicates: true });
        }
        const refreshed = await this.prisma.stories.findUnique({ where: { id: storyId }, include: storyInclude });
        if (!refreshed || refreshed.deleted_at || refreshed.expires_at <= new Date()) throw new NotFoundException("Story is no longer available.");
        return { success: true, story: await this.serialize(refreshed, userId) };
    }

    async react(userId: bigint, storyId: bigint, reaction: StoryReaction | null) {
        await this.visibleStory(userId, storyId);
        if (reaction) {
            await this.prisma.story_reactions.upsert({
                where: { story_id_user_id: { story_id: storyId, user_id: userId } },
                create: { story_id: storyId, user_id: userId, reaction },
                update: { reaction, created_at: new Date() },
            });
        } else {
            await this.prisma.story_reactions.deleteMany({ where: { story_id: storyId, user_id: userId } });
        }
        const refreshed = await this.prisma.stories.findUnique({ where: { id: storyId }, include: storyInclude });
        if (!refreshed || refreshed.deleted_at || refreshed.expires_at <= new Date()) throw new NotFoundException("Story is no longer available.");
        return { success: true, story: await this.serialize(refreshed, userId) };
    }

    async viewers(userId: bigint, storyId: bigint) {
        const story = await this.prisma.stories.findFirst({ where: { id: storyId, owner_id: userId, deleted_at: null, expires_at: { gt: new Date() } }, select: { id: true } });
        if (!story) throw new NotFoundException("Story was not found or is no longer available.");
        const views = await this.prisma.story_views.findMany({
            where: { story_id: storyId }, orderBy: { viewed_at: "desc" },
            include: { users: { select: { id: true, first_name: true, last_name: true, user_name: true, avatar: true, profiles: { select: { display_name: true, avatar_url: true } } } } },
        });
        return { success: true, viewers: await Promise.all(views.map(async view => {
            const user = view.users;
            const rawAvatar = user.profiles?.avatar_url || user.avatar;
            return { id: user.id.toString(), name: user.profiles?.display_name || [user.last_name, user.first_name].filter(Boolean).join(" ") || user.user_name || "User", avatar: rawAvatar?.startsWith("profiles/") ? await this.storage.url(rawAvatar, null, 300) : rawAvatar, viewedAt: view.viewed_at.toISOString() };
        })) };
    }

    async remove(userId: bigint, storyId: bigint) {
        const changed = await this.prisma.stories.updateMany({ where: { id: storyId, owner_id: userId, deleted_at: null }, data: { deleted_at: new Date() } });
        if (!changed.count) {
            const exists = await this.prisma.stories.findUnique({ where: { id: storyId }, select: { id: true } });
            if (!exists) throw new NotFoundException("Story was not found.");
            throw new ForbiddenException("You can only delete your own stories.");
        }
        await this.cleanupPending();
        void this.scheduleExpirationCleanup();
        return { success: true };
    }
}
