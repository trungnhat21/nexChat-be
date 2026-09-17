import type { Request } from "express";

export interface AuthenticatedRequest extends Request {
    userId?: bigint;
    sessionId?: string;
    currentUser?: CurrentUser;
}

export interface CurrentUser {
    id: string;
    email: string;
    status: string;
    userName: string | null;
    firstName: string | null;
    lastName: string | null;
    avatar: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface JwtPayload {
    userId: string;
    sessionId?: string;
    type: string;
}
