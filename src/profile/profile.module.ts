import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { UsersModule } from "../users/users.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ProfileImagesController } from "./profile-images.controller.js";
import { ProfileImagesService } from "./profile-images.service.js";

@Module({ imports: [AuthModule, UsersModule, PrismaModule, StorageModule], controllers: [ProfileImagesController], providers: [ProfileImagesService] })
export class ProfileModule {}
