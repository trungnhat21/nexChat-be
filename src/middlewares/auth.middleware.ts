import type {
    Request,
    Response,
    NextFunction
} from "express";
import { verifyAccessToken } from "../utils/token";

export interface AuthRequest extends Request {
    userId?: bigint;
}

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const header = req.headers.authorization;

        if (!header) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized",
            });
        }

        const token = header.split(" ")[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized",
            });
        }

        const payload = verifyAccessToken(token) as {
            userId: string;
            type: string;
        };

        if (payload.type !== "access") {
            return res.status(401).json({
                success: false,
                message: "Invalid token",
            });
        }

        req.userId = BigInt(payload.userId);

        next();
    } catch {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired access token",
        });
    }
};