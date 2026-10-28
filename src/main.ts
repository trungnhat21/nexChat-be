import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { installRequestBodyParsers } from "./utils/http-body-parser.js";

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, {
        bodyParser: false,
    });

    installRequestBodyParsers(app.getHttpAdapter().getInstance());
    app.enableShutdownHooks();

    const port = process.env.PORT || 3000;
    await app.listen(port);

    console.log(`Server is running on port ${port}`);
}

void bootstrap();
