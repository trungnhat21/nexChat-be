import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
    constructor() {
        const adapter = new PrismaMariaDb({
            host: process.env.DB_HOST!,
            port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER!,
            password: process.env.DB_PASSWORD!,
            database: process.env.DB_NAME!,
            connectionLimit: 5,
            connectTimeout: 10000,
            acquireTimeout: 15000,
        });

        super({ adapter });
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }
}
