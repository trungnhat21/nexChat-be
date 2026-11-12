import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator.js";

@Controller()
export class HealthController {
    @Public()
    @Get("health")
    healthCheck() {
        return {
            status: "ok",
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
        };
    }

    @Public()
    @Get("api/health")
    apiHealthCheck() {
        return {
            status: "ok",
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
        };
    }
}
