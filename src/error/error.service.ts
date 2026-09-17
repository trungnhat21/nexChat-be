import { Injectable } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SystemErrorService {
    constructor(private readonly prisma: PrismaService) {}

    addSystemErrorMessage(message: string) {
        return this.prisma.system_error_logs.create({
            data: {
                created_at: new Date(),
                deleted: false,
                logs: message
            },
        });
    }
}