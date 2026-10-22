import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { PostStorageService } from "./post-storage.service.js";
import { POST_LIMITS, type PostMutation, type StoredMedia, type UploadedMedia } from "./posts.types.js";
import { validateMedia } from "./posts.validation.js";

const postInclude = {
    users: { select: { id: true, first_name: true, last_name: true, user_name: true, avatar: true, profiles: { select: { display_name: true, avatar_url: true } } } },
    _count: { select: { comments: { where: { deleted_at: null } } } },
} satisfies Prisma.postsInclude;
type PostRow = Prisma.postsGetPayload<{ include: typeof postInclude }>;

@Injectable()
export class PostsService {
    constructor(private readonly prisma: PrismaService, private readonly storage: PostStorageService) {}

    async list(userId: bigint, cursor?: bigint, search = "", authorId?: bigint) {
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
        if (authorId !== undefined) where.user_id = authorId;
        if (search) where.AND = [visible, { OR: [
            { content: { contains: search } },
            { users: { first_name: { contains: search } } }, { users: { last_name: { contains: search } } },
            { users: { user_name: { contains: search } } },
        ] }];
        const countWhere = { ...where };
        if (cursor !== undefined) where.id = { lt: cursor };
        const [rows, total] = await Promise.all([
            this.prisma.posts.findMany({ where, orderBy: { id: "desc" }, take: 21, include: postInclude }),
            authorId === undefined ? Promise.resolve(undefined) : this.prisma.posts.count({ where: countWhere }),
        ]);
        const hasMore = rows.length > 20;
        const posts = await this.serialize(rows.slice(0,20), userId);
        return { success: true, posts, nextCursor: hasMore ? posts.at(-1)?.id ?? null : null,
            ...(author ? { total, author: { id: author.id.toString(), name: author.profiles?.display_name || [author.last_name, author.first_name].filter(Boolean).join(" ") || author.user_name || "User", handle: author.user_name, avatar: await this.profileImage(author.profiles?.avatar_url || author.avatar), cover: await this.profileImage(author.profiles?.cover_url ?? null), bio: author.profiles?.bio ?? null, createdAt: author.created_at.toISOString() } } : {}),
        };
    }
    private async profileImage(value: string | null): Promise<string | null> {
        return value?.startsWith("profiles/") ? this.storage.url(value, null) : value;
    }
    private async serialize(rows: PostRow[], userId: bigint) {
        const ids = rows.map(row => row.id);
        const [attachments, reactions] = await Promise.all([
            this.prisma.attachments.findMany({ where: { owner_type: "post", owner_id: { in: ids } }, orderBy: { id: "asc" } }),
            this.prisma.reactions.groupBy({ by: ["target_id"], where: { target_type: "post", target_id: { in: ids } }, _count: { _all: true } }),
        ]);
        return Promise.all(rows.map(async row => ({
            id: row.id.toString(), content: row.content ?? "", privacy: row.privacy,
            createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
            canEdit: row.user_id === userId,
            author: { id: row.users.id.toString(), name: row.users.profiles?.display_name || [row.users.last_name, row.users.first_name].filter(Boolean).join(" ") || row.users.user_name || "Người dùng", handle: row.users.user_name, avatar: await this.profileImage(row.users.profiles?.avatar_url || row.users.avatar) },
            likes: reactions.find(reaction => reaction.target_id === row.id)?._count._all ?? 0,
            comments: row._count.comments,
            media: await Promise.all(attachments.filter(file => file.owner_id === row.id).map(async file => ({
                id: file.id.toString(), url: await this.storage.url(file.file_url, file.file_type),
                type: file.file_type ?? "application/octet-stream", name: file.file_name ?? "media", size: Number(file.file_size ?? 0),
            }))),
        })));
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
        return { success: true, post: (await this.serialize([row], userId))[0] };
    }
    async update(userId: bigint, id: bigint, input: PostMutation, files: UploadedMedia[]) {
        await this.owned(userId, id);
        validateMedia(files);
        if (input.keepMediaIds.length + files.length > POST_LIMITS.files) throw new BadRequestException("Tối đa 5 media mỗi bài.");
        if (!input.content && !files.length && !input.keepMediaIds.length) throw new BadRequestException("Bài viết không được để trống.");
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
