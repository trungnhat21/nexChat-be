import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { StoriesController } from "./stories.controller.js";
import { StoriesService } from "./stories.service.js";

@Module({ imports: [AuthModule, PrismaModule, StorageModule], controllers: [StoriesController], providers: [StoriesService] })
export class StoriesModule {}
