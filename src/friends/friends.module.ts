import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FriendsController } from "./friends.controller.js";
import { FriendsService } from "./friends.service.js";

@Module({
    imports: [AuthModule],
    controllers: [FriendsController],
    providers: [FriendsService],
})
export class FriendsModule {}
