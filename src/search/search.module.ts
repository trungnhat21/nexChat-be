import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PostsModule } from "../posts/posts.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { SearchController } from "./search.controller.js";
import { SearchService } from "./search.service.js";

@Module({ imports: [AuthModule, PostsModule, StorageModule], controllers: [SearchController], providers: [SearchService] })
export class SearchModule {}
