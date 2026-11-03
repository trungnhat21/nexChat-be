// Shared error codes used by GroupsService → GroupsController
export const GroupError = {
    GROUP_NOT_FOUND: "GROUP_NOT_FOUND",
    ALREADY_MEMBER: "ALREADY_MEMBER",
    NOT_A_MEMBER: "NOT_A_MEMBER",
    FORBIDDEN: "FORBIDDEN",
    OWNER_CANNOT_LEAVE: "OWNER_CANNOT_LEAVE",
    MEMBER_NOT_FOUND: "MEMBER_NOT_FOUND",
    MEMBER_BANNED: "MEMBER_BANNED",
} as const;

export type GroupErrorCode = (typeof GroupError)[keyof typeof GroupError];

export class GroupFlowError extends Error {
    constructor(readonly code: GroupErrorCode) {
        super(code);
    }
}

/** Roles that have management privileges over a group. */
export const MANAGE_ROLES = ["OWNER", "ADMIN"] as const;
export type ManageRole = (typeof MANAGE_ROLES)[number];

