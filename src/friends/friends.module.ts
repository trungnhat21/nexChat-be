import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FriendsController } from "./friends.controller.js";
import { FriendsService } from "./friends.service.js";
import { StorageModule } from "../storage/storage.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";

@Module({
    imports: [AuthModule, StorageModule, NotificationsModule],
    controllers: [FriendsController],
    providers: [FriendsService],
})
export class FriendsModule {}
