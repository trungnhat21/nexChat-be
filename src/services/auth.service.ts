import prisma from "../configs/prisma";
import bcrypt from "bcrypt";
import crypto from "crypto";

export const hashPassword = async (password: string) => {
    return await bcrypt.hash(password, 10);
};

export const comparePassword = async (password: string, passwordHash: string) => {
    return await bcrypt.compare(password, passwordHash);
};

export const hashToken = (token: string) => {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
};

export const saveRefreshToken = async (userId: bigint, token: string) => {
    const tokenHash = hashToken(token);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    return prisma.refresh_tokens.create({
        data: {
            user_id: userId,
            token_hash: tokenHash,
            expires_at: expiresAt,
        },
    });
};

export const findRefreshToken = async (token: string) => {
    const tokenHash = hashToken(token);

    return prisma.refresh_tokens.findFirst({
        where: {
            token_hash: tokenHash,
            revoked_at: null,
            expires_at: {
                gt: new Date(),
            },
        },
    });
};

export const revokeRefreshToken = async (token: string) => {
    const tokenHash = hashToken(token);

    return prisma.refresh_tokens.updateMany({
        where: {
            token_hash: tokenHash,
            revoked_at: null,
        },
        data: {
            revoked_at: new Date(),
        },
    });
};

export const getTwoFactor = async (userId: bigint) => {
    return prisma.user_two_factor_auth.findUnique({
        where: {
            user_id: userId,
        },
    });
};