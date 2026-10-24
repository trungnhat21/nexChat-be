import { Module } from "@nestjs/common";
import { PostStorageService } from "../posts/post-storage.service.js";

@Module({ providers: [PostStorageService], exports: [PostStorageService] })
export class StorageModule {}
