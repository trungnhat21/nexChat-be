export type GroupRole = "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER";
export type GroupMemberStatus = "JOINED" | "PENDING" | "BANNED";

export interface UpdateMemberDto {
    /** Promote / demote the member to a new role. */
    role?: GroupRole;
    /** Change the membership status (e.g. approve PENDING, BAN a member). */
    status?: GroupMemberStatus;
}

export function parseUpdateMemberDto(body: unknown): UpdateMemberDto {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("INVALID_BODY");
    }
    const b = body as Record<string, unknown>;
    const dto: UpdateMemberDto = {};

    const VALID_ROLES: GroupRole[] = ["OWNER", "ADMIN", "MODERATOR", "MEMBER"];
    const VALID_STATUSES: GroupMemberStatus[] = ["JOINED", "PENDING", "BANNED"];

    if ("role" in b) {
        if (!VALID_ROLES.includes(b.role as GroupRole)) {
            throw new Error("INVALID_ROLE");
        }
        dto.role = b.role as GroupRole;
    }
    if ("status" in b) {
        if (!VALID_STATUSES.includes(b.status as GroupMemberStatus)) {
            throw new Error("INVALID_STATUS");
        }
        dto.status = b.status as GroupMemberStatus;
    }

    if (!dto.role && !dto.status) {
        throw new Error("INVALID_BODY");
    }
    return dto;
}

