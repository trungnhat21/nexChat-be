import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { installRequestBodyParsers } from "./utils/http-body-parser.js";
import { validateProductionEnv } from "./utils/env-validation.js";
import { isOriginAllowed } from "./utils/cors.js";

async function bootstrap(): Promise<void> {
    validateProductionEnv();

    const app = await NestFactory.create(AppModule, {
        bodyParser: false,
    });

    // Configure CORS for REST API using shared validator
    app.enableCors({
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
            if (isOriginAllowed(origin)) {
                return callback(null, true);
            }
            return callback(new Error(`Origin ${origin} not allowed by CORS`));
        },
        credentials: true,
        methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
        exposedHeaders: ["Set-Cookie"],
    });

    installRequestBodyParsers(app.getHttpAdapter().getInstance());
    app.enableShutdownHooks();

    const port = Number(process.env.PORT) || 3000;
    const host = "0.0.0.0";
    await app.listen(port, host);

    console.log(`Server is running on ${host}:${port} (NODE_ENV=${process.env.NODE_ENV || "development"})`);
}

void bootstrap();
