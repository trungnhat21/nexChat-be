import { BadRequestException } from "@nestjs/common";

const MAX_ID = 18446744073709551615n;
const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMessagingId(value: unknown): bigint {
    if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new BadRequestException("ID không hợp lệ.");
    const id = BigInt(value);
    if (id > MAX_ID) throw new BadRequestException("ID không hợp lệ.");
    return id;
}

export function parseMessageContent(value: unknown): string {
    if (typeof value !== "string") throw new BadRequestException("Nội dung tin nhắn không hợp lệ.");
    const content = value.trim();
    if (!content) throw new BadRequestException("Tin nhắn không được để trống.");
    if (content.length > 4000) throw new BadRequestException("Tin nhắn tối đa 4.000 ký tự.");
    return content;
}

export function parseClientMessageId(value: unknown): string {
    if (typeof value !== "string" || !MESSAGE_ID_PATTERN.test(value)) throw new BadRequestException("Mã tin nhắn không hợp lệ.");
    return value.toLowerCase();
}

export function parseMessageCursor(value: unknown): bigint | undefined {
    if (value === undefined) return undefined;
    return parseMessagingId(value);
}

export function parseVisibleMessageIds(value: unknown): bigint[] {
    if (!Array.isArray(value) || value.length > 50) throw new BadRequestException("Danh sÃ¡ch tin Ä‘Ã£ xem khÃ´ng há»£p lá»‡.");
    const ids = value.map(parseMessagingId);
    return [...new Set(ids.map(id => id.toString()))].map(id => BigInt(id));
}

export function parseMessageLimit(value: unknown): number {
    if (value === undefined) return 30;
    if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) throw new BadRequestException("Số lượng tin nhắn không hợp lệ.");
    const limit = Number(value);
    if (limit < 1 || limit > 50) throw new BadRequestException("Mỗi lần tải từ 1 đến 50 tin nhắn.");
    return limit;
}

export function parseDirectRecipient(body: unknown): bigint {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Người nhận không hợp lệ.");
    return parseMessagingId((body as Record<string, unknown>).recipientId);
}

export function parseSendMessage(body: unknown, allowEmpty = false): { content: string; clientMessageId: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Tin nhắn không hợp lệ.");
    const data = body as Record<string, unknown>;
    const content = allowEmpty && data.content === "" ? "" : parseMessageContent(data.content);
    return { content, clientMessageId: parseClientMessageId(data.clientMessageId) };
}

export function validateMessageMedia(files: import("../posts/posts.types.js").UploadedMedia[], messageType: unknown, durationValue: unknown) {
    const MAX_FILE = 25 * 1024 * 1024;
    const MAX_TOTAL = 50 * 1024 * 1024;
    if (files.length > 5 || files.some(file => !file.buffer?.length || file.size !== file.buffer.length || file.size > MAX_FILE) || files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL) {
        throw new BadRequestException("Tệp đính kèm tối đa 25 MB mỗi tệp và 50 MB tổng cộng.");
    }
    let durationMs: number | null = null;
    if (durationValue !== undefined && durationValue !== "") {
        const value = typeof durationValue === "number" ? durationValue : typeof durationValue === "string" && /^\d{1,8}$/.test(durationValue) ? Number(durationValue) : NaN;
        if (!Number.isSafeInteger(value) || value < 0 || value > 60 * 60 * 1000) throw new BadRequestException("Thời lượng ghi âm không hợp lệ.");
        durationMs = value;
    }
    if (!files.length) {
        if (messageType !== undefined && messageType !== "text") throw new BadRequestException("Loại tin nhắn không khớp với tệp đính kèm.");
        return { messageType: "text" as const, durationMs: null };
    }
    const isAudio = messageType === "audio";
    if (isAudio && (files.length !== 1 || !files[0]?.mimetype.startsWith("audio/"))) throw new BadRequestException("Tin nhắn thoại cần đúng một tệp âm thanh.");
    if (!isAudio && messageType !== undefined && messageType !== "image") throw new BadRequestException("Loại tin nhắn không hợp lệ.");
    if (!isAudio && files.some(file => !file.mimetype.startsWith("image/"))) throw new BadRequestException("Chỉ có thể đính kèm ảnh trong một tin nhắn ảnh.");
    for (const file of files) {
        const bytes = file.buffer;
        const validImage = file.mimetype === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
            : file.mimetype === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : file.mimetype === "image/gif" ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
            : file.mimetype === "image/webp" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
            : false;
        const validAudio = file.mimetype === "audio/webm" ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
            : file.mimetype === "audio/ogg" ? bytes.subarray(0, 4).toString() === "OggS"
            : file.mimetype === "audio/mp4" ? bytes.length >= 12 && bytes.subarray(4, 8).toString() === "ftyp"
            : file.mimetype === "audio/mpeg" ? bytes.subarray(0, 3).toString() === "ID3" || (bytes.length > 1 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
            : file.mimetype === "audio/wav" || file.mimetype === "audio/x-wav" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE"
            : false;
        if (!(isAudio ? validAudio : validImage)) throw new BadRequestException("Định dạng tệp không hợp lệ hoặc chưa được hỗ trợ.");
    }
    if (isAudio && durationMs === null) throw new BadRequestException("Thiếu thời lượng tin nhắn thoại.");
    if (!isAudio && durationMs !== null) throw new BadRequestException("Ảnh không có thời lượng.");
    return { messageType: (isAudio ? "audio" : "image") as "audio" | "image", durationMs };
}
