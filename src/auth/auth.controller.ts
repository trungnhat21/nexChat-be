import {
    Body,
    Controller,
    Post,
    Req,
    Res,
    UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthGuard } from "./auth.guard.js";
import { AuthFlowError, AuthService } from "./auth.service.js";
import type { AuthenticatedRequest } from "./auth.types.js";

interface RegisterBody {
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    userName?: string;
}

interface LoginBody {
    email?: string;
    password?: string;
}

interface OtpBody {
    code?: string;
}

interface VerifyTwoFactorBody {
    challengeToken: string;
    code: string;
}

@Controller("api/auth")
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    @Post("register")
    async register(
        @Body() body: RegisterBody,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const { email, password, firstName, lastName, userName } = body;

            if (!email || !password || !firstName || !lastName) {
                return response.status(400).json({
                    success: false,
                    message: "Missing required fields",
                });
            }

            const user = await this.authService.register(
                email,
                password,
                firstName,
                lastName,
                userName,
            );

            return response.status(201).json({
                success: true,
                message: "Register successfully",
                data: {
                    id: user.id.toString(),
                    email: user.email,
                },
            });
        } catch (error) {
            if (error instanceof AuthFlowError && error.code === "EMAIL_ALREADY_EXISTS") {
                return response.status(409).json({
                    success: false,
                    message: "Email already exists",
                });
            }

            console.error("Register error:", error);
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Post("login")
    async login(
        @Body() body: LoginBody,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const { email, password } = body;

            if (!email || !password) {
                return response.status(400).json({
                    success: false,
                    message: "Email and password are required",
                });
            }

            const result = await this.authService.login(email, password);

            if (result.kind === "two-factor") {
                return response.status(200).json({
                    success: true,
                    message: "2FA required",
                    challengeToken: result.challengeToken,
                });
            }

            this.setRefreshTokenCookie(response, result.refreshToken);

            return response.status(200).json({
                success: true,
                message: "Login successfully",
                accessToken: result.accessToken,
            });
        } catch (error) {
            if (error instanceof AuthFlowError && error.code === "INVALID_CREDENTIALS") {
                return response.status(401).json({
                    success: false,
                    message: "Invalid email or password",
                });
            }

            console.error("Login error:", error);
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Post("refresh")
    async refresh(
        @Req() request: Request,
        @Res() response: Response,
    ): Promise<Response> {
        const refreshToken: unknown = request.cookies.refreshToken;

        if (typeof refreshToken !== "string" || !refreshToken) {
            return response.status(401).json({
                success: false,
                message: "Refresh token missing",
            });
        }

        try {
            const result = await this.authService.refresh(refreshToken);

            return response.status(200).json({
                success: true,
                accessToken: result.accessToken,
                user: {
                    id: result.user.id.toString(),
                    email: result.user.email,
                    userName: result.user.user_name,
                },
            });
        } catch (error) {
            if (error instanceof AuthFlowError) {
                const messages: Record<string, string> = {
                    INVALID_REFRESH_TOKEN: "Invalid refresh token",
                    REFRESH_TOKEN_NOT_FOUND: "Refresh token not found",
                    USER_NOT_FOUND: "User not found",
                };
                const message = messages[error.code];

                if (message) {
                    return response.status(401).json({
                        success: false,
                        message,
                    });
                }
            }

            return response.status(401).json({
                success: false,
                message: "Invalid or expired refresh token",
            });
        }
    }

    @Post("2fa/setup")
    @UseGuards(AuthGuard)
    async setupTwoFactor(
        @Req() request: AuthenticatedRequest,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const otpauth = await this.authService.setupTwoFactor(request.userId!);

            return response.status(200).json({
                success: true,
                otpauth,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Post("2fa/enable")
    @UseGuards(AuthGuard)
    async enableTwoFactor(
        @Req() request: AuthenticatedRequest,
        @Body() body: OtpBody,
        @Res() response: Response,
    ): Promise<Response> {
        const { code } = body;

        if (!code) {
            return response.status(400).json({
                success: false,
                message: "OTP code is required",
            });
        }

        try {
            await this.authService.enableTwoFactor(request.userId!, code);

            return response.status(200).json({
                success: true,
                message: "2FA enabled successfully",
            });
        } catch (error) {
            if (error instanceof AuthFlowError) {
                if (error.code === "TWO_FACTOR_NOT_CONFIGURED") {
                    return response.status(400).json({
                        success: false,
                        message: "2FA not configured",
                    });
                }

                if (error.code === "INVALID_OTP") {
                    return response.status(400).json({
                        success: false,
                        message: "Invalid OTP",
                    });
                }
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Post("2fa/verify")
    async verifyTwoFactor(
        @Body() body: VerifyTwoFactorBody,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            console.log("BODY:", body);
            const result = await this.authService.verifyTwoFactor(
                body.challengeToken,
                body.code,
            );

            this.setRefreshTokenCookie(response, result.refreshToken);

            return response.status(200).json({
                success: true,
                accessToken: result.accessToken,
            });
        } catch (error) {
            console.error("VERIFY 2FA ERROR:", error);

            if (error instanceof AuthFlowError) {
                if (error.code === "TWO_FACTOR_NOT_ENABLED") {
                    return response.status(400).json({
                        success: false,
                        message: "2FA not enabled",
                    });
                }

                if (error.code === "INVALID_OTP") {
                    return response.status(401).json({
                        success: false,
                        message: "Invalid OTP",
                    });
                }
            }

            return response.status(401).json({
                success: false,
                message: "Invalid 2FA challenge",
            });
        }
    }

    @Post("logout")
    async logout(
        @Req() request: Request,
        @Res() response: Response,
    ): Promise<Response> {
        const refreshToken: unknown = request.cookies.refreshToken;

        if (typeof refreshToken === "string" && refreshToken) {
            await this.authService.revokeRefreshToken(refreshToken);
        }

        response.clearCookie("refreshToken");

        return response.status(200).json({
            success: true,
            message: "Logout successfully",
        });
    }

    private setRefreshTokenCookie(response: Response, refreshToken: string): void {
        response.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
    }
}
