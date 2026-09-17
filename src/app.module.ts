import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { FriendsModule } from "./friends/friends.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { UsersModule } from "./users/users.module.js";

@Module({
    imports: [
        PrismaModule,
        UsersModule,
        AuthModule,
        FriendsModule,
        NotificationsModule,
    ],
})
export class AppModule {}
