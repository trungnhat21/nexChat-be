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

export function parseSendMessage(body: unknown): { content: string; clientMessageId: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Tin nhắn không hợp lệ.");
    const data = body as Record<string, unknown>;
    return { content: parseMessageContent(data.content), clientMessageId: parseClientMessageId(data.clientMessageId) };
}
