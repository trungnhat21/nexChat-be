import { BadRequestException } from "@nestjs/common";
import { basename } from "node:path";
import { POST_LIMITS, type PostMutation, type UploadedMedia } from "./posts.types.js";

export function parseId(value: unknown): bigint {
    if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new BadRequestException("ID không hợp lệ.");
    const id = BigInt(value);
    if (id > 18446744073709551615n) throw new BadRequestException("ID không hợp lệ.");
    return id;
}
export function parseMutation(raw: unknown, requireMediaState = false): PostMutation {
    if (!raw || typeof raw !== "object") throw new BadRequestException("Nội dung không hợp lệ.");
    const body = raw as Record<string, unknown>;
    if (typeof body.content !== "string" || body.content.length > POST_LIMITS.contentLength) throw new BadRequestException("Nội dung tối đa 5.000 ký tự.");
    if (requireMediaState && (body.privacy === undefined || body.keepMediaIds === undefined)) throw new BadRequestException("privacy and keepMediaIds are required when editing a post.");
    const privacy = body.privacy ?? "public";
    if (privacy !== "public" && privacy !== "friends" && privacy !== "private") throw new BadRequestException("Quyền riêng tư không hợp lệ.");
    let ids: unknown = [];
    try { ids = body.keepMediaIds === undefined ? [] : typeof body.keepMediaIds === "string" ? JSON.parse(body.keepMediaIds) : body.keepMediaIds; }
    catch { throw new BadRequestException("Danh sách media không hợp lệ."); }
    if (!Array.isArray(ids) || ids.length > POST_LIMITS.files) throw new BadRequestException("Tối đa 5 media mỗi bài.");
    const keepMediaIds = ids.map(parseId);
    if (new Set(keepMediaIds).size !== keepMediaIds.length) throw new BadRequestException("Media bị trùng lặp.");
    return { content: body.content.trim(), privacy, keepMediaIds };
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
