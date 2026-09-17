import { Controller, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import type { SystemErrorService } from "./error.service";

@Controller("api/error")
@UseGuards(AuthGuard)
export class SystemErrorController {

    constructor(private readonly systemErrorService: SystemErrorService) {}

    @Post()
    async addSystemErrorMessage(message: string) {
        await this.systemErrorService.addSystemErrorMessage(message);
        return { success: true, message: "Error logged successfully" };
    }
}