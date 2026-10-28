import { Module } from "@nestjs/common";
import { LiveKitService } from "./livekit.service.js";

@Module({ providers: [LiveKitService], exports: [LiveKitService] })
export class LiveKitModule {}
