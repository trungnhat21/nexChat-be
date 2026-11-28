import { BadRequestException } from "@nestjs/common";
import { basename } from "node:path";
import { POST_LIMITS, type FeedRandomizationCursor, type FeedRandomizationSession, type PostMutation, type UploadedMedia } from "./posts.types.js";

export function parseId(value: unknown): bigint {
    const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
    if (!text || !/^[1-9]\d{0,19}$/.test(text)) throw new BadRequestException("ID không hợp lệ.");
    const id = BigInt(text);
    if (id > 18446744073709551615n) throw new BadRequestException("ID không hợp lệ.");
    return id;
}

export function parseMutation(raw: unknown, requireMediaState = false): PostMutation {
    if (!raw || typeof raw !== "object") throw new BadRequestException("Nội dung không hợp lệ.");
    const body = raw as Record<string, unknown>;
    if (typeof body.content !== "string" || body.content.length > POST_LIMITS.contentLength) throw new BadRequestException("Nội dung tối đa 5.000 ký tự.");
    if (requireMediaState && (body.privacy === undefined || body.keepMediaIds === undefined)) throw new BadRequestException("privacy and keepMediaIds are required when editing a post.");
    const privacy = body.privacy ?? "public";
    if (body.postType !== undefined && body.postType !== "post" && body.postType !== "video") throw new BadRequestException("Invalid post type.");
    if (privacy !== "public" && privacy !== "friends" && privacy !== "private") throw new BadRequestException("Quyền riêng tư không hợp lệ.");
    let ids: unknown = [];
    try { ids = body.keepMediaIds === undefined ? [] : typeof body.keepMediaIds === "string" ? JSON.parse(body.keepMediaIds) : body.keepMediaIds; }
    catch { throw new BadRequestException("Danh sách media không hợp lệ."); }
    if (!Array.isArray(ids) || ids.length > POST_LIMITS.files) throw new BadRequestException("Tối đa 5 media mỗi bài.");
    const keepMediaIds = ids.map(parseId);
    if (new Set(keepMediaIds).size !== keepMediaIds.length) throw new BadRequestException("Media bị trùng lặp.");

    let groupId: bigint | undefined = undefined;
    if (body.groupId !== undefined && body.groupId !== null && body.groupId !== "") {
        groupId = parseId(body.groupId);
    }

    return {
        content: body.content.trim(),
        privacy,
        keepMediaIds,
        ...(body.postType === undefined ? {} : { postType: body.postType as "post" | "video" }),
        ...(groupId !== undefined ? { groupId } : {}),
    };
}

export function parsePostType(value: unknown): "post" | "video" | undefined {
    if (value === undefined || value === "") return undefined;
    if (value === "post" || value === "video") return value;
    throw new BadRequestException("Invalid post type.");
}

export function validateMedia(files: UploadedMedia[]): void {
    if (files.length > POST_LIMITS.files) throw new BadRequestException("Tối đa 5 media mỗi bài.");
    if (files.reduce((sum, file) => sum + file.size, 0) > POST_LIMITS.totalBytes) throw new BadRequestException("Tổng media tối đa 50 MB.");
    for (const file of files) {
        if (!file.buffer?.length || file.size !== file.buffer.length || file.size > POST_LIMITS.fileBytes) throw new BadRequestException("Mỗi file cần có dữ liệu và tối đa 25 MB.");
        const b = file.buffer;
        const valid = file.mimetype === "image/jpeg" ? b.subarray(0, 3).equals(Buffer.from([255,216,255]))
            : file.mimetype === "image/png" ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
            : file.mimetype === "image/gif" ? ["GIF87a", "GIF89a"].includes(b.subarray(0,6).toString("ascii"))
            : file.mimetype === "image/webp" ? b.subarray(0,4).toString() === "RIFF" && b.subarray(8,12).toString() === "WEBP"
            : file.mimetype === "video/mp4" ? b.length >= 12 && b.subarray(4,8).toString() === "ftyp"
            : file.mimetype === "video/webm" && b.subarray(0,4).equals(Buffer.from([26,69,223,163]));
        if (!valid) throw new BadRequestException("Chỉ nhận ảnh JPEG, PNG, GIF, WebP và video MP4, WebM đúng định dạng.");
    }
}

export function safeFilename(name: string): string {
    return basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || "media";
}

export function parseComment(raw: unknown): { content: string; parentCommentId?: bigint } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("Bình luận không hợp lệ.");
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== "content" && key !== "parentCommentId") || typeof body.content !== "string" || !body.content.trim() || body.content.length > 2000) throw new BadRequestException("Bình luận cần từ 1 đến 2.000 ký tự.");
    if (body.parentCommentId !== undefined && typeof body.parentCommentId !== "string") throw new BadRequestException("ID bình luận trả lời không hợp lệ.");
    return { content: body.content.trim(), ...(body.parentCommentId !== undefined ? { parentCommentId: parseId(body.parentCommentId) } : {}) };
}

export function parseRepost(raw: unknown) {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "content" && key !== "privacy")) throw new BadRequestException("Nội dung đăng lại không hợp lệ.");
    return parseMutation({ content: body.content ?? "", privacy: body.privacy ?? "public" });
}

export function parsePostSort(value: unknown, hasSearch = false): "relevance" | "latest" {
    if (value === "latest" || value === "newest") return "latest";
    if (value === "relevance") return "relevance";
    return hasSearch ? "relevance" : "latest";
}

export function parsePostPeriod(value: unknown): "all" | "24h" | "week" | "month" {
    if (value === "24h" || value === "day") return "24h";
    if (value === "week") return "week";
    if (value === "month") return "month";
    return "all";
}

export function parsePostMediaOnly(value: unknown): boolean {
    if (value === true || value === "true" || value === "1" || value === 1) return true;
    return false;
}

function decodeFeedToken(value: unknown): Record<string, unknown> {
    if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new BadRequestException("Phiên bảng tin không hợp lệ.");
    try {
        const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid token body");
        return decoded as Record<string, unknown>;
    } catch { throw new BadRequestException("Phiên bảng tin không hợp lệ."); }
}

export function encodeFeedRandomizationSession(session: FeedRandomizationSession): string {
    return Buffer.from(JSON.stringify(session)).toString("base64url");
}

export function parseFeedRandomizationSession(value: unknown): FeedRandomizationSession {
    const token = decodeFeedToken(value);
    if (token.version !== 1 || typeof token.seed !== "string" || !/^[a-f0-9]{32}$/.test(token.seed)
        || typeof token.snapshotId !== "string" || !/^(0|[1-9]\d{0,19})$/.test(token.snapshotId)) {
        throw new BadRequestException("Phiên bảng tin không hợp lệ.");
    }
    const snapshotId = BigInt(token.snapshotId);
    if (snapshotId > 18446744073709551615n) throw new BadRequestException("Phiên bảng tin không hợp lệ.");
    return { version: 1, seed: token.seed, snapshotId: snapshotId.toString() };
}

export function encodeFeedRandomizationCursor(cursor: FeedRandomizationCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function parseFeedRandomizationCursor(value: unknown): FeedRandomizationCursor {
    const token = decodeFeedToken(value);
    if (token.version !== 1 || typeof token.seed !== "string" || !/^[a-f0-9]{32}$/.test(token.seed)
        || !Number.isInteger(token.segment) || Number(token.segment) < 0 || Number(token.segment) >= 8
        || typeof token.lastId !== "string" || !/^[1-9]\d{0,19}$/.test(token.lastId)) {
        throw new BadRequestException("Con trỏ bảng tin không hợp lệ.");
    }
    if (BigInt(token.lastId) > 18446744073709551615n) throw new BadRequestException("Con trỏ bảng tin không hợp lệ.");
    return { version: 1, seed: token.seed, segment: Number(token.segment), lastId: BigInt(token.lastId).toString() };
}

export function parsePostRandomize(value: unknown): boolean {
    if (value === undefined || value === false || value === "false" || value === "0") return false;
    if (value === true || value === "true" || value === "1") return true;
    throw new BadRequestException("Tham số randomize không hợp lệ.");
}

export function buildFeedRandomizationPlan(seed: string): { segments: number[]; directions: Array<"asc" | "desc"> } {
    if (!/^[a-f0-9]{32}$/.test(seed)) throw new BadRequestException("Seed bảng tin không hợp lệ.");
    const mask = (1n << 64n) - 1n;
    const seedValue = BigInt(`0x${seed}`);
    let state = ((seedValue >> 64n) ^ (seedValue & mask)) & mask;
    if (state === 0n) state = 0x9e3779b97f4a7c15n;
    const next = () => {
        state ^= state >> 12n;
        state ^= (state << 25n) & mask;
        state ^= state >> 27n;
        state = (state * 0x2545f4914f6cdd1dn) & mask;
        return state;
    };
    const segments = Array.from({ length: 8 }, (_, index) => index);
    for (let index = segments.length - 1; index > 0; index -= 1) {
        const swapIndex = Number(next() % BigInt(index + 1));
        const current = segments[index]!;
        const swapped = segments[swapIndex]!;
        segments[index] = swapped;
        segments[swapIndex] = current;
    }
    const directions = segments.map(() => next() & 1n ? "desc" : "asc");
    return { segments, directions };
}

export function parseApproveAction(raw: unknown): "approve" | "reject" {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("Dữ liệu không hợp lệ.");
    const body = raw as Record<string, unknown>;
    if (body.action !== "approve" && body.action !== "reject") {
        throw new BadRequestException("Hành động phải là 'approve' hoặc 'reject'.");
    }
    return body.action;
}
