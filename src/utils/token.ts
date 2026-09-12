import jwt from "jsonwebtoken";
import "dotenv/config";



const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const TWO_FA_SECRET = process.env.JWT_2FA_SECRET;

if (!ACCESS_SECRET) {
    throw new Error("JWT_ACCESS_SECRET is missing");
}

if (!REFRESH_SECRET) {
    throw new Error("JWT_REFRESH_SECRET is missing");
}

if (!TWO_FA_SECRET) {
    throw new Error("JWT_2FA_SECRET is missing");
}

export const createAccessToken = (userId: bigint) => {
    return jwt.sign (
        {
            userId: userId.toString(),
            type: "access",
        },
        ACCESS_SECRET,
        {
            expiresIn: "15m",
        }
    )
};

export const createRefreshToken = (userId: bigint) => {
    return jwt.sign(
        {
            userId: userId.toString(),
            type: "refresh",
        },
        REFRESH_SECRET,
        {
            expiresIn: "7d",
        }
    )
};

export const createTwoFactorToken = (userId: bigint) => {
    return jwt.sign(
        {
            userId: userId.toString(),
            type: "two_factor",
        },
        TWO_FA_SECRET,
        {
            expiresIn: "5m",
        }
    )
};

export const verifyAccessToken = (token: string) => {
    return jwt.verify(token, ACCESS_SECRET);
};

export const verifyRefreshToken = (token: string) => {
    return jwt.verify(token, REFRESH_SECRET);
};

export const verifyTwoFactorToken = (token: string) => {
    return jwt.verify(token, TWO_FA_SECRET);
};