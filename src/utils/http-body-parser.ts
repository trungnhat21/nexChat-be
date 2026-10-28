import cookieParser from "cookie-parser";
import express, { type Express } from "express";

export function installRequestBodyParsers(app: Express): void {
    app.use("/api/webhooks/livekit", express.raw({ type: "application/webhook+json", limit: "1mb" }));
    app.use(express.json());
    app.use(cookieParser());
}
