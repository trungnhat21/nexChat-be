import type { Request } from "express";

export interface AuthenticatedRequest extends Request {
    userId?: bigint;
}

export interface JwtPayload {
    userId: string;
    type: string;
}
