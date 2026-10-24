import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { MessagingController } from "./messaging.controller.js";
import { MessagingService } from "./messaging.service.js";

@Module({
    imports: [AuthModule, PrismaModule, StorageModule, NotificationsModule],
    controllers: [MessagingController],
    providers: [MessagingService],
})
export class MessagingModule {}
