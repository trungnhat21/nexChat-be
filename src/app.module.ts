import { ProfileModule } from "./profile/profile.module.js";
import { PostsModule } from "./posts/posts.module.js";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module.js";
import { FriendsModule } from "./friends/friends.module.js";
import { Neo4jModule } from "./neo4j/neo4j.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { UsersModule } from "./users/users.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { MessagingModule } from "./messaging/messaging.module.js";
import { StoriesModule } from "./stories/stories.module.js";
import { CallsModule } from "./calls/calls.module.js";
import { SearchModule } from "./search/search.module.js";

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        PrismaModule,
        Neo4jModule,
        UsersModule,
        AuthModule,
        FriendsModule,
        NotificationsModule,
        PostsModule,
        ProfileModule,
        RedisModule,
        MessagingModule,
        StoriesModule,
        CallsModule,
        SearchModule,
    ],
})
export class AppModule {}
