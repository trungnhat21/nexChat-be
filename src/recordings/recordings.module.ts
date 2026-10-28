import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LiveKitModule } from "../livekit/livekit.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RecordingsController, LiveKitWebhookController } from "./recordings.controller.js";
import { RecordingStorageService } from "./recording-storage.service.js";
import { RecordingsService } from "./recordings.service.js";

@Module({
  imports: [AuthModule, LiveKitModule, PrismaModule],
  controllers: [RecordingsController, LiveKitWebhookController],
  providers: [RecordingsService, RecordingStorageService],
  exports: [RecordingsService],
})
export class RecordingsModule {}
