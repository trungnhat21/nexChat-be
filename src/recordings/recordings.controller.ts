import { BadRequestException, Body, Controller, Delete, Get, HttpException, Param, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { parseCallId } from "../calls/calls.validation.js";
import { LiveKitService } from "../livekit/livekit.service.js";
import { RecordingsService } from "./recordings.service.js";

@Controller("api/calls/:callId")
@UseGuards(AuthGuard)
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Post("recording-consent")
  consent(@Req() req: AuthenticatedRequest, @Param("callId") rawCallId: string, @Body() body: unknown) {
    if (!body || typeof body !== "object" || typeof (body as any).consent !== "boolean") throw new BadRequestException("consent must be a boolean.");
    return this.recordings.setConsent(req.userId!, parseCallId(rawCallId), (body as any).consent);
  }

  @Get("recordings")
  list(@Req() req: AuthenticatedRequest, @Param("callId") rawCallId: string) {
    return this.recordings.list(req.userId!, parseCallId(rawCallId));
  }

  @Get("recordings/:recordingId/playback")
  playback(@Req() req: AuthenticatedRequest, @Param("callId") rawCallId: string, @Param("recordingId") rawRecordingId: string) {
    return this.recordings.playbackUrl(req.userId!, parseCallId(rawCallId), parseCallId(rawRecordingId));
  }

  @Delete("recordings/:recordingId")
  delete(@Req() req: AuthenticatedRequest, @Param("callId") rawCallId: string, @Param("recordingId") rawRecordingId: string) {
    return this.recordings.delete(req.userId!, parseCallId(rawCallId), parseCallId(rawRecordingId));
  }

  @Post("recordings/:recordingId/retry-stop")
  retryStop(@Req() req: AuthenticatedRequest, @Param("callId") rawCallId: string, @Param("recordingId") rawRecordingId: string) {
    return this.recordings.retryStop(req.userId!, parseCallId(rawCallId), parseCallId(rawRecordingId));
  }
}

@Controller("api/webhooks/livekit")
export class LiveKitWebhookController {
  constructor(private readonly recordings: RecordingsService, private readonly livekit: LiveKitService) {}

  @Post()
  async receive(@Req() req: Request) {
    if (!req.is("application/webhook+json")) throw new BadRequestException("LiveKit webhook content type is required.");
    if (!Buffer.isBuffer(req.body)) throw new BadRequestException("LiveKit webhook raw body is unavailable.");
    let event;
    try {
      event = await this.livekit.verifyWebhook(req.body.toString("utf8"), req.header("authorization"));
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() >= 500) throw error;
      throw new UnauthorizedException("Invalid LiveKit webhook signature.");
    }
    return this.recordings.processWebhook(event);
  }
}
