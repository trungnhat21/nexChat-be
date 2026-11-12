import { validateCorsConfig } from "./cors.js";

/**
 * Production environment validation helper.
 * Enforces fail-fast startup if critical variables are missing.
 * Strictly NEVER outputs secret values to logs or console.
 */
export function validateProductionEnv(): void {
    const isProduction = process.env.NODE_ENV === "production";

    // Validate CORS first
    validateCorsConfig();

    if (isProduction) {
        // Required runtime variables in production
        const requiredInProduction = [
            "DATABASE_URL",
            "DB_HOST",
            "DB_USER",
            "DB_PASSWORD",
            "DB_NAME",
            "JWT_ACCESS_SECRET",
            "JWT_REFRESH_SECRET",
            "JWT_2FA_SECRET",
            "REDIS_URL",
            "S3_ENDPOINT",
            "S3_BUCKET",
            "S3_ACCESS_KEY_ID",
            "S3_SECRET_ACCESS_KEY",
            "LIVEKIT_URL",
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
        ];

        const missing = requiredInProduction.filter(name => !process.env[name]?.trim());

        if (missing.length > 0) {
            const message = `[FATAL STARTUP ERROR] Missing required environment variables in production: ${missing.join(", ")}`;
            console.error(message);
            throw new Error(message);
        }
    }
}
