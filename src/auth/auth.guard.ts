import {
    type CanActivate,
    type ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
} from "@nestjs/common";
import { verifyAccessToken } from "../utils/token.js";
import { AuthService } from "./auth.service.js";
import type { AuthenticatedRequest, JwtPayload } from "./auth.types.js";
import type { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private readonly authService: AuthService,
        private readonly reflector: Reflector,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(
            IS_PUBLIC_KEY,
            [
                context.getHandler(),
                context.getClass(),
            ],
        );

        if (isPublic) {
            return true;
        }
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

        const header = request.headers.authorization;

        if (!header) {
            throw this.unauthorized("Unauthorized");
        }

        const [scheme, token, extraPart] = header.trim().split(/\s+/);

        if (scheme !== "Bearer" || !token || extraPart) {
            throw this.unauthorized("Unauthorized");
        }

        try {
            const payload = verifyAccessToken(token) as JwtPayload;

            if (payload.type !== "access") {
                throw this.unauthorized("Invalid token");
            }

            if (!payload.sessionId) {
                throw this.unauthorized("Invalid session");
            }

            const userId = BigInt(payload.userId);
            const currentUser = await this.authService.getSessionCurrentUser(
                payload.sessionId,
                userId,
            );

            if (!currentUser) {
                throw this.unauthorized("Session expired");
            }

            request.userId = userId;
            request.sessionId = payload.sessionId;
            request.currentUser = currentUser;
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
