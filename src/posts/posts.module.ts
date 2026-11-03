import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { PostsController, GroupPostsController } from "./posts.controller.js";
import { PostsService } from "./posts.service.js";
import { StorageModule } from "../storage/storage.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";

@Module({
    imports: [AuthModule, PrismaModule, StorageModule, NotificationsModule],
    controllers: [PostsController, GroupPostsController],
    providers: [PostsService],
    exports: [PostsService],
})
export class PostsModule {}
