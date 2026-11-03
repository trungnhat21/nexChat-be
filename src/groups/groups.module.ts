import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { GroupsController } from "./groups.controller.js";
import { GroupsService } from "./groups.service.js";

@Module({
    imports: [
        AuthModule, // provides AuthGuard + AuthService (session check)
    ],
    controllers: [GroupsController],
    providers: [GroupsService],
    exports: [GroupsService],
})
export class GroupsModule {}

