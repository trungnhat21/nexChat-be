import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { PostsController } from "./posts.controller.js";
import { PostsService } from "./posts.service.js";
import { StorageModule } from "../storage/storage.module.js";

@Module({ imports: [AuthModule, PrismaModule, StorageModule], controllers: [PostsController], providers: [PostsService] })
export class PostsModule {}
