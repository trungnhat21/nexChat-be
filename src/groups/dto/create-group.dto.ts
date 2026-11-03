// ──────────────────────────────────────────────────────────────
// create-group.dto.ts
// Manual validation (no class-validator dep) to stay consistent
// with the rest of the project (friends / messaging use plain
// interface + runtime checks).
// ──────────────────────────────────────────────────────────────

export interface CreateGroupDto {
    name: string;
    description?: string | null;
    cover_image?: string | null;
    avatar?: string | null;
    privacy?: "PUBLIC" | "PRIVATE";
    requires_approval?: boolean;
}

/**
 * Parse and validate the raw request body for creating a group.
 * Returns a clean DTO or throws with a human-readable message.
 */
export function parseCreateGroupDto(body: unknown): CreateGroupDto {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("INVALID_BODY");
    }
    const b = body as Record<string, unknown>;

    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 255) {
        throw new Error("INVALID_NAME");
    }

    const description =
        typeof b.description === "string" ? b.description.trim() : null;
    const cover_image =
        typeof b.cover_image === "string" ? b.cover_image.trim() || null : null;
    const avatar =
        typeof b.avatar === "string" ? b.avatar.trim() || null : null;

    const privacy =
        b.privacy === "PRIVATE" ? ("PRIVATE" as const) : ("PUBLIC" as const);
    const requires_approval =
        b.requires_approval === true || b.requires_approval === "true";

    return { name, description, cover_image, avatar, privacy, requires_approval };
}

