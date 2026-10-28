import { BadRequestException } from "@nestjs/common";

const MAX_ID = 18446744073709551615n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCallId(value: unknown): bigint {
    if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new BadRequestException("Invalid call ID.");
    const id = BigInt(value);
    if (id > MAX_ID) throw new BadRequestException("Invalid call ID.");
    return id;
}

export function parseCallStart(body: unknown): { conversationId: bigint; callType: "audio" | "video"; idempotencyKey: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Invalid call request.");
    const value = body as Record<string, unknown>;
    if (value.callType !== "audio" && value.callType !== "video") throw new BadRequestException("callType must be audio or video.");
    if (typeof value.idempotencyKey !== "string" || !UUID.test(value.idempotencyKey)) throw new BadRequestException("A UUID idempotencyKey is required.");
    return { conversationId: parseCallId(value.conversationId), callType: value.callType, idempotencyKey: value.idempotencyKey.toLowerCase() };
}

export function parseCallHistoryQuery(cursor: unknown, limit: unknown): { cursor?: bigint; limit: number } {
    const parsedLimit = limit === undefined ? 20 : typeof limit === "string" && /^\d{1,2}$/.test(limit) ? Number(limit) : 0;
    if (parsedLimit < 1 || parsedLimit > 50) throw new BadRequestException("limit must be between 1 and 50.");
    return { ...(cursor === undefined ? {} : { cursor: parseCallId(cursor) }), limit: parsedLimit };
}
