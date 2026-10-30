import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { PostStorageService } from "../posts/post-storage.service.js";
import { PostsService } from "../posts/posts.service.js";
import { extractMatchingHashtags, type SearchCategory, type SearchFilterOptions } from "./search.validation.js";

const SUGGESTION_LIMIT = 5;
const PAGE_LIMIT = 20;

@Injectable()
export class SearchService {
    constructor(private readonly prisma: PrismaService, private readonly posts: PostsService, private readonly storage: PostStorageService) {}

    async search(userId: bigint, query: string, category: SearchCategory, cursor?: bigint, limit = SUGGESTION_LIMIT, options?: SearchFilterOptions) {
        if (category === "people") return { success: true, category, ...(await this.searchPeople(userId, query, cursor, limit > 0 ? limit : PAGE_LIMIT)) };
        if (category === "posts") return { success: true, category, ...(await this.posts.searchVisible(userId, query, cursor, limit > 0 ? limit : PAGE_LIMIT, options)) };
        if (category === "hashtags") return { success: true, category, items: await this.searchHashtags(userId, query), nextCursor: null };

        const [people, posts, hashtags] = await Promise.all([
            this.searchPeople(userId, query, undefined, limit),
            this.posts.searchVisible(userId, query, undefined, limit, options),
            this.searchHashtags(userId, query),
        ]);
        return { success: true, query, people, posts, hashtags: { items: hashtags, nextCursor: null } };
    }

    private async searchPeople(userId: bigint, query: string, cursor: bigint | undefined, take: number) {
        const blockedRows = await this.prisma.friendships.findMany({
            where: { status: "blocked", OR: [{ requester_id: userId }, { addressee_id: userId }] },
            select: { requester_id: true, addressee_id: true },
        });
        const blockedIds = blockedRows.map(row => row.requester_id === userId ? row.addressee_id : row.requester_id);
        const where = {
            id: { not: userId, ...(cursor === undefined ? {} : { lt: cursor }), ...(blockedIds.length ? { notIn: blockedIds } : {}) },
            deleted: "NO" as const,
            status: "active" as const,
            OR: [
                { user_name: { contains: query } }, { first_name: { contains: query } }, { last_name: { contains: query } },
                { profiles: { is: { display_name: { contains: query } } } },
            ],
        };
        const rows = await this.prisma.users.findMany({
            where, orderBy: { id: "desc" }, take: take + 1,
            select: { id: true, user_name: true, first_name: true, last_name: true, avatar: true, profiles: { select: { display_name: true, avatar_url: true, bio: true } } },
        });
        const hasMore = rows.length > take;
        const page = rows.slice(0, take);
        if (!page.length) return { items: [], nextCursor: null };
        const ids = page.map(row => row.id);
        const [relationships, follows] = await Promise.all([
            this.prisma.friendships.findMany({ where: { OR: ids.flatMap(id => [{ requester_id: userId, addressee_id: id }, { requester_id: id, addressee_id: userId }]) }, select: { id: true, requester_id: true, addressee_id: true, status: true } }),
            this.prisma.follows.findMany({ where: { follower_id: userId, following_id: { in: ids } }, select: { following_id: true } }),
        ]);
        const following = new Set(follows.map(row => row.following_id.toString()));
        const relationshipById = new Map<string, typeof relationships[number]>();
        for (const row of relationships) relationshipById.set((row.requester_id === userId ? row.addressee_id : row.requester_id).toString(), row);
        const items = await Promise.all(page.map(async row => {
            const id = row.id.toString();
            const relationship = relationshipById.get(id);
            const friendStatus = !relationship ? "none" : relationship.status === "accepted" ? "friends" : relationship.status === "pending" ? relationship.requester_id === userId ? "outgoing" : "incoming" : "blocked";
            const avatar = row.profiles?.avatar_url || row.avatar;
            return {
                id,
                name: row.profiles?.display_name || [row.last_name, row.first_name].filter(Boolean).join(" ") || row.user_name || "Người dùng",
                firstName: row.first_name,
                lastName: row.last_name,
                username: row.user_name,
                avatar: avatar?.startsWith("profiles/") ? await this.storage.url(avatar, null) : avatar,
                bio: row.profiles?.bio ?? null,
                friendStatus,
                requestId: relationship ? relationship.id.toString() : null,
                following: following.has(id),
            };
        }));
        return { items, nextCursor: hasMore ? page.at(-1)?.id.toString() ?? null : null };
    }

    private async searchHashtags(userId: bigint, query: string) {
        const term = query.replace(/^#+/u, "");
        if (!term) return [];
        const source = await this.posts.searchHashtagSource(userId, term, 1000);
        return extractMatchingHashtags(source.map(row => row.content), term);
    }
}
