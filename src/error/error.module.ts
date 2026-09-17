import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SystemErrorController } from "./error.controller";
import { SystemErrorService } from "./error.service";

@Module({
    imports: [AuthModule],
    controllers: [SystemErrorController],
    providers: [SystemErrorService],
})

export class SystemErrorModule {}