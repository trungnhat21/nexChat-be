import {
    type CanActivate,
    type ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
} from "@nestjs/common";
import { verifyAccessToken } from "../utils/token.js";
import type { AuthenticatedRequest, JwtPayload } from "./auth.types.js";

@Injectable()
export class AuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const header = request.headers.authorization;

        if (!header) {
            throw this.unauthorized("Unauthorized");
        }

        const token = header.split(" ")[1];

        if (!token) {
            throw this.unauthorized("Unauthorized");
        }

        try {
            const payload = verifyAccessToken(token) as JwtPayload;

            if (payload.type !== "access") {
                throw this.unauthorized("Invalid token");
            }

            request.userId = BigInt(payload.userId);
            return true;
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            throw this.unauthorized("Invalid or expired access token");
        }
    }

    private unauthorized(message: string): HttpException {
        return new HttpException(
            {
                success: false,
                message,
            },
            HttpStatus.UNAUTHORIZED,
        );
    }
}
