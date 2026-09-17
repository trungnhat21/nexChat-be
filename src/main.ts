import "dotenv/config";
import "reflect-metadata";
import cookieParser from "cookie-parser";
import express from "express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, {
        bodyParser: false,
    });

    app.use(express.json());
    app.use(cookieParser());
    app.enableShutdownHooks();

    const port = process.env.PORT || 3000;
    await app.listen(port);

    console.log(`Server is running on port ${port}`);
}

void bootstrap();
