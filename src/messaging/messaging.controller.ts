import { Body, Controller, Get, Param, Patch, Post, Query, Req, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { MessagingService } from "./messaging.service.js";
import type { UploadedMedia } from "../posts/posts.types.js";
import { parseDirectRecipient, parseMessageCursor, parseMessageLimit, parseMessagingId, parseSendMessage, parseVisibleMessageIds, validateMessageMedia } from "./messaging.validation.js";

const messageFiles = FilesInterceptor("media", 5, { limits: { files: 5, fileSize: 25 * 1024 * 1024, fields: 4, fieldSize: 8 * 1024, parts: 10 } });

@Controller("api/conversations")
@UseGuards(AuthGuard)
export class MessagingController {
    constructor(private readonly messaging: MessagingService) {}

    @Get()
    list(@Req() request: AuthenticatedRequest) {
        return this.messaging.listConversations(request.userId!);
    }

    @Post("direct")
    direct(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
        return this.messaging.getOrCreateDirect(request.userId!, parseDirectRecipient(body));
    }

    @Get(":id/messages")
    messages(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query("before") before: unknown, @Query("limit") limit: unknown) {
        return this.messaging.listMessages(request.userId!, parseMessagingId(id), parseMessageCursor(before), parseMessageLimit(limit));
    }

    @Patch(":id/read")
    markRead(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
        const messageIds = body && typeof body === "object" && !Array.isArray(body) ? parseVisibleMessageIds((body as Record<string, unknown>).messageIds) : [];
        return this.messaging.markConversationRead(request.userId!, parseMessagingId(id), messageIds);
    }

    @Post(":id/messages")
    @UseInterceptors(messageFiles)
    send(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @UploadedFiles() files: UploadedMedia[] = []) {
        const input = parseSendMessage(body, files.length > 0);
        const media = validateMessageMedia(files, (body as Record<string, unknown>)?.messageType, (body as Record<string, unknown>)?.durationMs);
        return this.messaging.sendMessage(request.userId!, parseMessagingId(id), input.content, input.clientMessageId, files, media.messageType, media.durationMs);
    }
}
