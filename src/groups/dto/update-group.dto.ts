export interface UpdateGroupDto {
    name?: string;
    description?: string | null;
    cover_image?: string | null;
    avatar?: string | null;
    privacy?: "PUBLIC" | "PRIVATE";
    requires_approval?: boolean;
}

export function parseUpdateGroupDto(body: unknown): UpdateGroupDto {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("INVALID_BODY");
    }
    const b = body as Record<string, unknown>;
    const dto: UpdateGroupDto = {};

    if ("name" in b) {
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (!name || name.length > 255) throw new Error("INVALID_NAME");
        dto.name = name;
    }
    if ("description" in b) {
        dto.description =
            typeof b.description === "string" ? b.description.trim() : null;
    }
    if ("cover_image" in b) {
        dto.cover_image =
            typeof b.cover_image === "string" ? b.cover_image.trim() || null : null;
    }
    if ("avatar" in b) {
        dto.avatar =
            typeof b.avatar === "string" ? b.avatar.trim() || null : null;
    }
    if ("privacy" in b) {
        dto.privacy =
            b.privacy === "PRIVATE" ? "PRIVATE" : "PUBLIC";
    }
    if ("requires_approval" in b) {
        dto.requires_approval =
            b.requires_approval === true || b.requires_approval === "true";
    }

    return dto;
}

