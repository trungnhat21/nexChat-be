import { Injectable } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service.js";
import type { JwtPayload } from "../auth/auth.types.js";
import { verifyAccessToken } from "../utils/token.js";

@WebSocketGateway({ cors: { origin: true, credentials: true } })
@Injectable()
export class NotificationsGateway implements OnGatewayConnection {
    @WebSocketServer() private server!: Server;

    constructor(private readonly auth: AuthService) {}

    async handleConnection(client: Socket) {
        const token: unknown = client.handshake.auth?.token;
        if (typeof token !== "string" || !token) return client.disconnect(true);
        try {
            const payload = verifyAccessToken(token) as JwtPayload;
            if (payload.type !== "access" || !payload.sessionId || !/^\d{1,20}$/.test(payload.userId)) return client.disconnect(true);
            const userId = BigInt(payload.userId);
            if (userId <= 0n || !(await this.auth.getSessionCurrentUser(payload.sessionId, userId))) return client.disconnect(true);
            client.data.userId = userId.toString();
            await client.join(this.userRoom(userId));
        } catch {
            client.disconnect(true);
        }
    }

    notifyUser(userId: bigint | string) {
        this.server?.to(this.userRoom(userId)).emit("notification:new");
    }

    private userRoom(userId: bigint | string) {
        return `user:${userId.toString()}`;
    }
}
