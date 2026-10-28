import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LiveKitModule } from "../livekit/livekit.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { RecordingsModule } from "../recordings/recordings.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { CallsController } from "./calls.controller.js";
import { CallsService } from "./calls.service.js";

@Module({
    imports: [AuthModule, PrismaModule, LiveKitModule, NotificationsModule, RecordingsModule, StorageModule],
    controllers: [CallsController],
    providers: [CallsService],
})
export class CallsModule {}
