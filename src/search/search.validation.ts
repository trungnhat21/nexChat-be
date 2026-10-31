import { BadRequestException } from "@nestjs/common";

export type SearchCategory = "all" | "people" | "posts" | "hashtags";

export function parseSearchQuery(value: unknown): string {
    if (typeof value !== "string") throw new BadRequestException("Từ khóa tìm kiếm không hợp lệ.");
    const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/gu, " ");
    if (!normalized || normalized.length > 200) throw new BadRequestException("Từ khóa cần từ 1 đến 200 ký tự.");
    return normalized;
}

export function parseSearchCursor(value: unknown): bigint | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new BadRequestException("Cursor tìm kiếm không hợp lệ.");
    const id = BigInt(value);
    if (id > 18446744073709551615n) throw new BadRequestException("Cursor tìm kiếm không hợp lệ.");
    return id;
}

export function parseSearchCategory(value: unknown): SearchCategory {
    if (value === undefined || value === "all") return "all";
    if (value === "people" || value === "posts" || value === "hashtags") return value;
    throw new BadRequestException("Loại kết quả tìm kiếm không hợp lệ.");
}

export function parseSearchLimit(value: unknown, defaultLimit = 5, maxLimit = 20): number {
    if (value === undefined || value === null || value === "") return defaultLimit;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return defaultLimit;
    return Math.min(parsed, maxLimit);
}

export type SearchSort = "relevance" | "latest";
export type SearchPeriod = "all" | "24h" | "week" | "month";

export interface SearchFilterOptions {
    sort?: SearchSort | undefined;
    period?: SearchPeriod | undefined;
    mediaOnly?: boolean | undefined;
}

export function parseSearchSort(value: unknown): SearchSort {
    if (value === "latest" || value === "newest") return "latest";
    return "relevance";
}

export function parseSearchPeriod(value: unknown): SearchPeriod {
    if (value === "24h" || value === "day") return "24h";
    if (value === "week") return "week";
    if (value === "month") return "month";
    return "all";
}

export function parseSearchMediaOnly(value: unknown): boolean {
    if (value === true || value === "true" || value === "1" || value === 1) return true;
    return false;
}

export function getPeriodStartDate(period: SearchPeriod): Date | undefined {
    const now = Date.now();
    if (period === "24h") return new Date(now - 24 * 60 * 60 * 1000);
    if (period === "week") return new Date(now - 7 * 24 * 60 * 60 * 1000);
    if (period === "month") return new Date(now - 30 * 24 * 60 * 60 * 1000);
    return undefined;
}

export function extractMatchingHashtags(contents: string[], query: string): Array<{ tag: string; postsCount: number }> {
    const normalizedQuery = query.replace(/^#+/u, "").toLocaleLowerCase("vi");
    if (!normalizedQuery) return [];
    const counts = new Map<string, { tag: string; postsCount: number }>();
    for (const content of contents) {
        const foundInPost = new Set<string>();
        for (const match of content.matchAll(/#[\p{L}\p{N}_]+/gu)) {
            const tag = match[0];
            if (!tag.slice(1).toLocaleLowerCase("vi").includes(normalizedQuery)) continue;
            foundInPost.add(tag.toLocaleLowerCase("vi"));
            const existing = counts.get(tag.toLocaleLowerCase("vi"));
            if (!existing) counts.set(tag.toLocaleLowerCase("vi"), { tag, postsCount: 0 });
        }
        for (const key of foundInPost) {
            const item = counts.get(key);
            if (item) item.postsCount++;
        }
    }
    return [...counts.values()].sort((a, b) => b.postsCount - a.postsCount || a.tag.localeCompare(b.tag, "vi")).slice(0, 10);
}
