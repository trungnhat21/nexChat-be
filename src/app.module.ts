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
        RedisModule
    ],
})
export class AppModule {}
