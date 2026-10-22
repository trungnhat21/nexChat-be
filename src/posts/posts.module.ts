import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { PostsController } from "./posts.controller.js";
import { PostsService } from "./posts.service.js";
import { PostStorageService } from "./post-storage.service.js";

@Module({ imports: [AuthModule, PrismaModule], controllers: [PostsController], providers: [PostsService, PostStorageService] })
export class PostsModule {}
