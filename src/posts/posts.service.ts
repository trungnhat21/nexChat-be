import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { PostStorageService } from "./post-storage.service.js";
import { POST_LIMITS, type PostView, type PostMutation, type StoredMedia, type UploadedMedia, type GetPostsDto, type PostSort, type PostPeriod } from "./posts.types.js";
import { validateMedia } from "./posts.validation.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { getPeriodStartDate, type SearchFilterOptions } from "../search/search.validation.js";

const postInclude = {
    users: { select: { id: true, first_name: true, last_name: true, user_name: true, avatar: true, profiles: { select: { display_name: true, avatar_url: true } } } },
    _count: { select: { comments: { where: { deleted_at: null } } } },
} satisfies Prisma.postsInclude;
type PostRow = Prisma.postsGetPayload<{ include: typeof postInclude }>;

@Injectable()
export class PostsService {
    private readonly logger = new Logger(PostsService.name);
    constructor(private readonly prisma: PrismaService, private readonly storage: PostStorageService, private readonly notifications: NotificationsService) {}

    private publishPostNotifications(authorId: bigint, postId: bigint, privacy: PostMutation["privacy"]) {
        void this.notifications.notifyPostPublished(authorId, postId, privacy).catch(error => this.logger.error("Failed to notify post audience", error));
    }

    private calculatePostRelevance(row: PostRow, query: string): number {
        if (!query) return 0;
        const q = query.trim().toLocaleLowerCase("vi");
        if (!q) return 0;
        let score = 0;
        const content = (row.content || "").toLocaleLowerCase("vi");
        const name = [row.users?.first_name, row.users?.last_name, row.users?.profiles?.display_name, row.users?.user_name]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase("vi");

        if (content.includes(q)) {
            score += 40;
            const matches = content.split(q).length - 1;
            score += Math.min(matches * 10, 50);
            if (content.startsWith(q)) score += 20;
        }
        if (name.includes(q)) {
            score += 30;
        }
        const words = q.split(/\s+/).filter(w => w.length > 1);
        if (words.length > 1) {
            for (const word of words) {
                if (content.includes(word)) score += 5;
                if (name.includes(word)) score += 5;
            }
        }
        return score;
    }

    async list(
        userId: bigint,
        dtoOrCursor?: GetPostsDto | bigint,
        legacySearchOrSaved: string | boolean = "",
        legacyAuthorId?: bigint,
        legacySavedOnly = false,
    ) {
        let dto: GetPostsDto;
        if (typeof dtoOrCursor === "object" && dtoOrCursor !== null) {
            dto = dtoOrCursor;
        } else {
            dto = {
                cursor: typeof dtoOrCursor === "bigint" ? dtoOrCursor : undefined,
                search: typeof legacySearchOrSaved === "string" ? legacySearchOrSaved : "",
                authorId: legacyAuthorId,
                savedOnly: typeof legacySearchOrSaved === "boolean" ? legacySearchOrSaved : legacySavedOnly,
                sort: typeof legacySearchOrSaved === "string" && legacySearchOrSaved.trim() ? "relevance" : "latest",
                period: "all",
                mediaOnly: false,
            };
        }

        const cursor = dto.cursor;
        const search = dto.search?.trim() ?? "";
        const authorId = dto.authorId;
        const savedOnly = dto.savedOnly ?? false;
        const sort = dto.sort ?? (search ? "relevance" : "latest");
        const period = dto.period ?? "all";
        const mediaOnly = dto.mediaOnly ?? false;

        const author = authorId === undefined ? null : await this.prisma.users.findFirst({
            where: { id: authorId, deleted: "NO" },
            select: { id: true, first_name: true, last_name: true, user_name: true, avatar: true, created_at: true, profiles: { select: { display_name: true, avatar_url: true, cover_url: true, bio: true } } },
        });
        if (authorId !== undefined && !author) throw new NotFoundException("Account not found.");
        const friends = await this.prisma.friendships.findMany({
            where: { status: "accepted", OR: [{ requester_id: userId }, { addressee_id: userId }] },
            select: { requester_id: true, addressee_id: true },
        });
        const friendIds = friends.map(friend => friend.requester_id === userId ? friend.addressee_id : friend.requester_id);
        const visible: Prisma.postsWhereInput = { OR: [
            { privacy: "public" }, { user_id: userId }, { privacy: "friends", user_id: { in: friendIds } },
        ] };
        const where: Prisma.postsWhereInput = { deleted_at: null, AND: [visible] };
        if (savedOnly) where.saved_posts = { some: { user_id: userId } };
        if (authorId !== undefined) where.user_id = authorId;
        if (search) where.AND = [visible, { OR: [
            { content: { contains: search } },
            { users: { first_name: { contains: search } } }, { users: { last_name: { contains: search } } },
            { users: { user_name: { contains: search } } },
        ] }];

        if (period && period !== "all") {
            const startDate = getPeriodStartDate(period);
            if (startDate) {
                where.created_at = { gte: startDate };
            }
        }

        if (mediaOnly) {
            const postAttachments = await this.prisma.attachments.findMany({
                where: { owner_type: "post" },
                select: { owner_id: true },
                distinct: ["owner_id"],
            });
            const postIdsWithMedia = postAttachments.map(a => a.owner_id);
            where.id = { in: postIdsWithMedia, ...(cursor !== undefined ? { lt: cursor } : {}) };
        } else if (cursor !== undefined) {
            where.id = { lt: cursor };
        }

        const countWhere = { ...where };
        const orderBy: Prisma.postsOrderByWithRelationInput[] = [{ created_at: "desc" }, { id: "desc" }];

        const [rows, total] = await Promise.all([
            this.prisma.posts.findMany({ where, orderBy, take: 21, include: postInclude }),
            authorId === undefined ? Promise.resolve(undefined) : this.prisma.posts.count({ where: countWhere }),
        ]);

        const hasMore = rows.length > 20;
        let pageRows = rows.slice(0, 20);

        if (sort === "relevance" && search) {
            pageRows = [...pageRows].sort((a, b) => {
                const scoreA = this.calculatePostRelevance(a, search);
                const scoreB = this.calculatePostRelevance(b, search);
                if (scoreB !== scoreA) return scoreB - scoreA;
                return b.created_at.getTime() - a.created_at.getTime();
            });
        }

        const posts = await this.serialize(pageRows, userId);
        return {
            success: true,
            posts,
            nextCursor: hasMore ? (rows[19]?.id ? rows[19].id.toString() : null) : null,
            ...(author ? { total, author: { id: author.id.toString(), name: author.profiles?.display_name || [author.last_name, author.first_name].filter(Boolean).join(" ") || author.user_name || "User", handle: author.user_name, avatar: await this.profileImage(author.profiles?.avatar_url || author.avatar), cover: await this.profileImage(author.profiles?.cover_url ?? null), bio: author.profiles?.bio ?? null, createdAt: author.created_at.toISOString() } } : {}),
        };
    }

    async searchVisible(userId: bigint, keyword: string, cursor?: bigint, pageSize = 6, options?: SearchFilterOptions) {
        const { where: scope, friendIds } = await this.searchScope(userId);
        const where: Prisma.postsWhereInput = {
            ...scope,
            AND: [
                { OR: [{ privacy: "public" }, { user_id: userId }, { privacy: "friends", user_id: { in: friendIds } }] },
                { OR: [
                    { content: { contains: keyword } },
                    { users: { first_name: { contains: keyword } } },
                    { users: { last_name: { contains: keyword } } },
                    { users: { user_name: { contains: keyword } } },
                ] },
            ],
        };

        if (options?.period && options.period !== "all") {
            const startDate = getPeriodStartDate(options.period);
            if (startDate) {
                where.created_at = { gte: startDate };
            }
        }

        if (options?.mediaOnly) {
            const postAttachments = await this.prisma.attachments.findMany({
                where: { owner_type: "post" },
                select: { owner_id: true },
                distinct: ["owner_id"],
            });
            const postIdsWithMedia = postAttachments.map(a => a.owner_id);
            where.id = { in: postIdsWithMedia, ...(cursor !== undefined ? { lt: cursor } : {}) };
        } else if (cursor !== undefined) {
            where.id = { lt: cursor };
        }

        const orderBy: Prisma.postsOrderByWithRelationInput[] = [{ created_at: "desc" }, { id: "desc" }];

        const rows = await this.prisma.posts.findMany({ where, orderBy, take: pageSize + 1, include: postInclude });
        const hasMore = rows.length > pageSize;
        let pageRows = rows.slice(0, pageSize);

        if ((!options?.sort || options.sort === "relevance") && keyword) {
            pageRows = [...pageRows].sort((a, b) => {
                const scoreA = this.calculatePostRelevance(a, keyword);
                const scoreB = this.calculatePostRelevance(b, keyword);
                if (scoreB !== scoreA) return scoreB - scoreA;
                return b.created_at.getTime() - a.created_at.getTime();
            });
        }

        const items = await this.serialize(pageRows, userId);
        return { items, nextCursor: hasMore ? (rows[pageSize - 1]?.id?.toString() ?? null) : null };
    }

    async searchHashtagSource(userId: bigint, keyword: string, take = 1000): Promise<Array<{ id: bigint; content: string }>> {
        const { where: scope } = await this.searchScope(userId);
        const rows = await this.prisma.posts.findMany({
            where: { ...scope, content: { contains: keyword }, users: { deleted: "NO", status: "active" } },
            select: { id: true, content: true }, orderBy: { id: "desc" }, take,
        });
        return rows.flatMap(row => row.content === null ? [] : [{ id: row.id, content: row.content }]);
    }

    private async searchScope(userId: bigint): Promise<{ where: Prisma.postsWhereInput; friendIds: bigint[] }> {
        const [friends, blocked] = await Promise.all([
            this.prisma.friendships.findMany({ where: { status: "accepted", OR: [{ requester_id: userId }, { addressee_id: userId }] }, select: { requester_id: true, addressee_id: true } }),
            this.prisma.friendships.findMany({ where: { status: "blocked", OR: [{ requester_id: userId }, { addressee_id: userId }] }, select: { requester_id: true, addressee_id: true } }),
        ]);
        const friendIds = friends.map(row => row.requester_id === userId ? row.addressee_id : row.requester_id);
        const blockedIds = blocked.map(row => row.requester_id === userId ? row.addressee_id : row.requester_id);
        const where: Prisma.postsWhereInput = {
            deleted_at: null,
            users: { deleted: "NO", status: "active" },
            ...(blockedIds.length ? { user_id: { notIn: blockedIds } } : {}),
        };
        return { where, friendIds };
    }
    private async profileImage(value: string | null): Promise<string | null> {
        return value?.startsWith("profiles/") ? this.storage.url(value, null) : value;
    }
    private async serialize(rows: PostRow[], userId: bigint, includeOriginal = true): Promise<PostView[]> {
        if (!rows.length) return [];
        const ids = rows.map(row => row.id);
        const [attachments, reactions, ownLikes, saves] = await Promise.all([
            this.prisma.attachments.findMany({ where: { owner_type: "post", owner_id: { in: ids } }, orderBy: { id: "asc" } }),
            this.prisma.reactions.groupBy({ by: ["target_id"], where: { target_type: "post", target_id: { in: ids }, reaction_type: "like" }, _count: { _all: true } }),
            this.prisma.reactions.findMany({ where: { user_id: userId, target_type: "post", target_id: { in: ids }, reaction_type: "like" }, select: { target_id: true } }),
            this.prisma.saved_posts.findMany({ where: { user_id: userId, post_id: { in: ids } }, select: { post_id: true } }),
        ]);
        const originalIds = includeOriginal ? rows.flatMap(row => row.shared_post_id ? [row.shared_post_id] : []) : [];
        const originalRows = originalIds.length ? await this.prisma.posts.findMany({ where: { id: { in: originalIds }, ...(await this.visibleWhere(userId)) }, include: postInclude }) : [];
        const originals = new Map((await this.serialize(originalRows, userId, false)).map(post => [post.id, post]));
        const savedIds = new Set(saves.map(save => save.post_id));
        const likedIds = new Set(ownLikes.map(like => like.target_id));
        return Promise.all(rows.map(async row => ({
            id: row.id.toString(), content: row.content ?? "", privacy: row.privacy,
            createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
            canEdit: row.user_id === userId,
            author: { id: row.users.id.toString(), name: row.users.profiles?.display_name || [row.users.last_name, row.users.first_name].filter(Boolean).join(" ") || row.users.user_name || "Người dùng", handle: row.users.user_name, avatar: await this.profileImage(row.users.profiles?.avatar_url || row.users.avatar) },
            liked: likedIds.has(row.id), saved: savedIds.has(row.id),
            isRepost: row.is_repost, original: row.shared_post_id ? originals.get(row.shared_post_id.toString()) ?? null : null,
            likes: reactions.find(reaction => reaction.target_id === row.id)?._count._all ?? 0,
            comments: row._count.comments,
            media: await Promise.all(attachments.filter(file => file.owner_id === row.id).map(async file => ({
                id: file.id.toString(), url: await this.storage.url(file.file_url, file.file_type),
                type: file.file_type ?? "application/octet-stream", name: file.file_name ?? "media", size: Number(file.file_size ?? 0),
            }))),
        })));
    }
    private async visibleWhere(userId: bigint): Promise<Prisma.postsWhereInput> {
        const friends = await this.prisma.friendships.findMany({
            where: { status: "accepted", OR: [{ requester_id: userId }, { addressee_id: userId }] },
            select: { requester_id: true, addressee_id: true },
        });
        const ids = friends.map(friend => friend.requester_id === userId ? friend.addressee_id : friend.requester_id);
        return { deleted_at: null, OR: [{ privacy: "public" }, { user_id: userId }, { privacy: "friends", user_id: { in: ids } }] };
    }
    async visiblePost(userId: bigint, id: bigint, tx: Prisma.TransactionClient = this.prisma, lock = false) {
        if (lock) await tx.$queryRaw`SELECT id FROM posts WHERE id = ${id} FOR UPDATE`;
        const post = await tx.posts.findFirst({ where: { id, deleted_at: null } });
        if (!post) throw new NotFoundException("Bài viết không tồn tại.");
        if (post.user_id !== userId && post.privacy !== "public") {
            const friend = post.privacy === "friends" && await tx.friendships.findFirst({ where: { status: "accepted", OR: [
                { requester_id: userId, addressee_id: post.user_id }, { requester_id: post.user_id, addressee_id: userId },
            ] } });
            if (!friend) throw new ForbiddenException("Bạn không có quyền xem bài viết này.");
        }
        return post;
    }
    async get(userId: bigint, id: bigint) {
        const row = await this.prisma.posts.findFirst({ where: { id, ...(await this.visibleWhere(userId)) }, include: postInclude });
        if (!row) throw new NotFoundException("Bài viết không tồn tại hoặc bạn không có quyền xem.");
        return { success: true, post: (await this.serialize([row], userId))[0] };
    }
    async setSaved(userId: bigint, id: bigint, saved: boolean) {
        if (!saved) {
            // Allow removing a bookmark even if its original post is no longer visible.
            await this.prisma.saved_posts.deleteMany({ where: { user_id: userId, post_id: id } });
        } else {
            await this.prisma.$transaction(async tx => {
                await this.visiblePost(userId, id, tx, true);
                await tx.saved_posts.upsert({ where: { user_id_post_id: { user_id: userId, post_id: id } }, create: { user_id: userId, post_id: id }, update: {} });
            }, { maxWait: 15000, timeout: 15000 });
        }
        return { success: true, id: id.toString(), saved };
    }
    async repost(userId: bigint, id: bigint, input: PostMutation) {
        const row = await this.prisma.$transaction(async tx => {
            const source = await this.visiblePost(userId, id, tx, true);
            const originalId = source.is_repost ? source.shared_post_id : source.id;
            if (!originalId) throw new NotFoundException("Bài gốc không còn khả dụng.");
            if (originalId !== source.id) await this.visiblePost(userId, originalId, tx, true);
            return tx.posts.create({ data: { user_id: userId, content: input.content, privacy: input.privacy, shared_post_id: originalId, is_repost: true }, include: postInclude });
        }, { maxWait: 15000, timeout: 15000 });
        this.publishPostNotifications(userId, row.id, input.privacy);
        return { success: true, post: (await this.serialize([row], userId))[0] };
    }
    private async commentView(row: Prisma.commentsGetPayload<{ include: { users: typeof postInclude.users } }>, userId: bigint) {
        return { id: row.id.toString(), postId: row.post_id.toString(), content: row.content,
            createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), canEdit: row.user_id === userId,
            author: { id: row.users.id.toString(), name: row.users.profiles?.display_name || [row.users.last_name, row.users.first_name].filter(Boolean).join(" ") || row.users.user_name || "Người dùng",
                avatar: await this.profileImage(row.users.profiles?.avatar_url || row.users.avatar) },
        };
    }
    async listComments(userId: bigint, id: bigint, cursor?: bigint) {
        await this.visiblePost(userId, id);
        const where = { post_id: id, deleted_at: null, parent_comment_id: null };
        const [rows, total] = await Promise.all([
            this.prisma.comments.findMany({ where: { ...where, ...(cursor ? { id: { lt: cursor } } : {}) }, orderBy: { id: "desc" }, take: 21, include: { users: postInclude.users, other_comments: { where: { deleted_at: null }, orderBy: { id: "asc" }, include: { users: postInclude.users } } } }),
            this.prisma.comments.count({ where: { post_id: id, deleted_at: null } }),
        ]);
        const comments = await Promise.all(rows.slice(0,20).map(async row => ({ ...await this.commentView(row, userId), replies: await Promise.all(row.other_comments.map(reply => this.commentView(reply, userId))) })));
        return { success: true, comments, total,
            nextCursor: rows.length > 20 ? rows[19]!.id.toString() : null };
    }
    async mutateComment(userId: bigint, postId: bigint, content: string | null, commentId?: bigint, parentCommentId?: bigint) {
        const result = await this.prisma.$transaction(async tx => {
            await this.visiblePost(userId, postId, tx, true);
            if (parentCommentId !== undefined) {
                const parent = await tx.comments.findFirst({ where: { id: parentCommentId, post_id: postId, deleted_at: null, parent_comment_id: null }, select: { id: true } });
                if (!parent) throw new NotFoundException("Chỉ có thể trả lời bình luận gốc còn tồn tại.");
            }
            if (commentId) {
                const current = await tx.comments.findFirst({ where: { id: commentId, post_id: postId, deleted_at: null } });
                if (!current) throw new NotFoundException("Bình luận không tồn tại.");
                if (current.user_id !== userId) throw new ForbiddenException("Bạn chỉ được sửa hoặc xóa bình luận của mình.");
                if (parentCommentId !== undefined) throw new BadRequestException("Không thể đổi bình luận thành câu trả lời.");
                if (content === null && current.parent_comment_id === null) await tx.comments.updateMany({ where: { parent_comment_id: current.id, deleted_at: null }, data: { deleted_at: new Date(), updated_at: new Date() } });
            }
            const row = commentId
                ? await tx.comments.update({ where: { id: commentId }, data: content === null ? { deleted_at: new Date(), updated_at: new Date() } : { content, updated_at: new Date() }, include: { users: postInclude.users } })
                : await tx.comments.create({ data: { user_id: userId, post_id: postId, content: content!, parent_comment_id: parentCommentId ?? null }, include: { users: postInclude.users } });
            const total = await tx.comments.count({ where: { post_id: postId, deleted_at: null } });
            return { row, total };
        }, { maxWait: 15000, timeout: 15000 });
        return { success: true, comment: content === null ? null : await this.commentView(result.row, userId), total: result.total };
    }
    async setLike(userId: bigint, id: bigint, liked: boolean) {
        return this.prisma.$transaction(async tx => {
            // Serialize mutations for this post, including concurrent likes and deletion.
            await tx.$queryRaw`SELECT id FROM posts WHERE id = ${id} FOR UPDATE`;
            const post = await tx.posts.findFirst({ where: { id, deleted_at: null } });
            if (!post) throw new NotFoundException("Bài viết không tồn tại.");
            if (post.user_id !== userId && post.privacy !== "public") {
                const friend = post.privacy === "friends" && await tx.friendships.findFirst({
                    where: { status: "accepted", OR: [
                        { requester_id: userId, addressee_id: post.user_id },
                        { requester_id: post.user_id, addressee_id: userId },
                    ] },
                });
                if (!friend) throw new ForbiddenException("Bạn không có quyền xem bài viết này.");
            }
            const target = { user_id: userId, target_type: "post" as const, target_id: id };
            if (liked) {
                await tx.reactions.upsert({
                    where: { user_id_target_type_target_id: target },
                    create: { ...target, reaction_type: "like" },
                    update: { reaction_type: "like" },
                });
            } else {
                await tx.reactions.deleteMany({ where: { ...target, reaction_type: "like" } });
            }
            const likes = await tx.reactions.count({ where: { target_type: "post", target_id: id, reaction_type: "like" } });
            return { success: true, id: id.toString(), liked, likes };
        }, { maxWait: 15000, timeout: 15000 });
    }
    private async owned(userId: bigint, id: bigint) {
        const post = await this.prisma.posts.findFirst({ where: { id, deleted_at: null } });
        if (!post) throw new NotFoundException("Bài viết không tồn tại.");
        if (post.user_id !== userId) throw new ForbiddenException("Bạn chỉ được sửa hoặc xóa bài viết của mình.");
    }
    private async upload(userId: bigint, files: UploadedMedia[]) {
        const uploaded: StoredMedia[] = [];
        try { for (const file of files) uploaded.push(await this.storage.upload(userId, file)); }
        catch (error) { await this.storage.remove(uploaded.map(file => file.key)); throw error; }
        return uploaded;
    }
    async create(userId: bigint, input: PostMutation, files: UploadedMedia[]) {
        validateMedia(files);
        if (input.keepMediaIds.length) throw new BadRequestException("Bài mới không được dùng media của bài khác.");
        if (!input.content && !files.length) throw new BadRequestException("Hãy nhập nội dung hoặc đính kèm media.");
        const uploaded = await this.upload(userId, files);
        let row: PostRow;
        try {
            row = await this.prisma.$transaction(async tx => {
                const post = await tx.posts.create({ data: { user_id: userId, content: input.content, privacy: input.privacy }, include: postInclude });
                if (uploaded.length) await tx.attachments.createMany({ data: uploaded.map(file => ({ owner_type: "post" as const, owner_id: post.id, file_url: file.key, file_type: file.type, file_name: file.name, file_size: BigInt(file.size) })) });
                return post;
            });
        } catch (error) { await this.storage.remove(uploaded.map(file => file.key)); throw error; }
        this.publishPostNotifications(userId, row.id, input.privacy);
        return { success: true, post: (await this.serialize([row], userId))[0] };
    }
    async update(userId: bigint, id: bigint, input: PostMutation, files: UploadedMedia[]) {
        await this.owned(userId, id);
        const existingPost = await this.prisma.posts.findUniqueOrThrow({ where: { id } });
        validateMedia(files);
        if (input.keepMediaIds.length + files.length > POST_LIMITS.files) throw new BadRequestException("Tối đa 5 media mỗi bài.");
        if (!existingPost.is_repost && !input.content && !files.length && !input.keepMediaIds.length) throw new BadRequestException("Bài viết không được để trống.");
        const uploaded = await this.upload(userId, files);
        let result: { row: PostRow; removed: string[] };
        try {
            result = await this.prisma.$transaction(async tx => {
                const changed = await tx.posts.updateMany({ where: { id, user_id: userId, deleted_at: null }, data: { content: input.content, privacy: input.privacy, updated_at: new Date() } });
                if (!changed.count) throw new NotFoundException("Bài viết không còn tồn tại.");
                const current = await tx.attachments.findMany({ where: { owner_type: "post", owner_id: id } });
                const kept = current.filter(file => input.keepMediaIds.includes(file.id));
                if (kept.length !== input.keepMediaIds.length) throw new BadRequestException("Media không thuộc bài viết này hoặc đã bị xóa.");
                if (kept.reduce((sum,file) => sum + Number(file.file_size ?? 0), 0) + files.reduce((sum,file) => sum + file.size,0) > POST_LIMITS.totalBytes) throw new BadRequestException("Tổng media tối đa 50 MB.");
                const removed = current.filter(file => !input.keepMediaIds.includes(file.id));
                await tx.attachments.deleteMany({ where: { id: { in: removed.map(file => file.id) }, owner_type: "post", owner_id: id } });
                if (uploaded.length) await tx.attachments.createMany({ data: uploaded.map(file => ({ owner_type: "post" as const, owner_id: id, file_url: file.key, file_type: file.type, file_name: file.name, file_size: BigInt(file.size) })) });
                const row = await tx.posts.findUniqueOrThrow({ where: { id }, include: postInclude });
                return { row, removed: removed.map(file => file.file_url) };
            });
        } catch (error) { await this.storage.remove(uploaded.map(file => file.key)); throw error; }
        await this.storage.remove(result.removed);
        return { success: true, post: (await this.serialize([result.row], userId))[0] };
    }
    async remove(userId: bigint, id: bigint) {
        await this.owned(userId, id);
        const keys = await this.prisma.$transaction(async tx => {
            const changed = await tx.posts.updateMany({ where: { id, user_id: userId, deleted_at: null }, data: { deleted_at: new Date(), updated_at: new Date() } });
            if (!changed.count) throw new NotFoundException("Bài viết không còn tồn tại.");
            const media = await tx.attachments.findMany({ where: { owner_type: "post", owner_id: id } });
            await tx.attachments.deleteMany({ where: { owner_type: "post", owner_id: id } });
            return media.map(file => file.file_url);
        });
        await this.storage.remove(keys);
        return { success: true };
    }
}
