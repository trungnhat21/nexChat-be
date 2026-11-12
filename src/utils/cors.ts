/**
 * Shared CORS Origin Whitelist and Resolver for REST and WebSockets.
 */

export function getAllowedOrigins(): string[] {
    const rawOrigins = [
        ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",") : []),
        ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : []),
    ]
        .map(url => url.trim().replace(/\/+$/, ""))
        .filter(Boolean);

    return Array.from(new Set(rawOrigins));
}

/**
 * Validates CORS configuration on startup.
 * In production:
 * - Fails startup if no origins are configured.
 * - Fails startup if wildcard '*' is used (insecure when credentials: true).
 */
export function validateCorsConfig(): void {
    const isProduction = process.env.NODE_ENV === "production";
    if (isProduction) {
        const origins = getAllowedOrigins();
        if (origins.length === 0) {
            const message =
                "[FATAL SECURITY ERROR] Missing FRONTEND_URL or CORS_ORIGIN in production! " +
                "Production requires an explicit, non-empty origin whitelist.";
            console.error(message);
            throw new Error(message);
        }

        if (origins.includes("*")) {
            const message =
                "[FATAL SECURITY ERROR] Wildcard '*' origin is strictly forbidden in production when credentials are enabled! " +
                "Please configure specific frontend domains (e.g. https://your-app.vercel.app).";
            console.error(message);
            throw new Error(message);
        }
    }
}

/**
 * Validates an incoming request origin against the whitelist.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
    // Allow non-browser requests (e.g. mobile apps, curl, server-to-server, webhooks)
    if (!origin) return true;

    const isProduction = process.env.NODE_ENV === "production";

    // In local development, always allow localhost & 127.0.0.1 on any port
    if (!isProduction) {
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            return true;
        }
    }

    const allowed = getAllowedOrigins();
    return allowed.includes(origin);
}

