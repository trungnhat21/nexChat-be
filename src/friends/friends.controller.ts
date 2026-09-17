import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { FriendsService } from "./friends.service.js";

interface FriendRequestBody {
    addresseeId?: string | number | bigint | boolean;
}

@Controller("api/friends")
@UseGuards(AuthGuard)
export class FriendsController {
    constructor(private readonly friendsService: FriendsService) {}

    @Get("search")
    async searchUsers(
        @Req() request: AuthenticatedRequest,
        @Query("keyword") rawKeyword: unknown,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const keyword = typeof rawKeyword === "string" ? rawKeyword.trim() : "";

            if (!keyword) {
                return response.status(400).json({
                    success: false,
                    message: "Keyword is required",
                });
            }

            const users = await this.friendsService.searchUsers(request.userId!, keyword);

            return response.status(200).json({
                success: true,
                users: users.map((user) => ({
                    ...user,
                    id: user.id.toString(),
                })),
            });
        } catch (error) {
            console.error("Search users error:", error);
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Post("request")
    async sendFriendRequest(
        @Req() request: AuthenticatedRequest,
        @Body() body: FriendRequestBody,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const { addresseeId } = body;

            if (!addresseeId) {
                return response.status(400).json({
                    success: false,
                    message: "addresseeId is required",
                });
            }

            const friendship = await this.friendsService.sendFriendRequest(
                request.userId!,
                BigInt(addresseeId),
            );

            return response.status(201).json({
                success: true,
                message: "Friend request sent successfully",
                friendship: {
                    id: friendship.id.toString(),
                    requesterId: friendship.requester_id.toString(),
                    addresseeId: friendship.addressee_id.toString(),
                    status: friendship.status,
                },
            });
        } catch (error) {
            if (error instanceof Error) {
                const errorResponses: Record<string, { status: number; message: string }> = {
                    CANNOT_ADD_YOURSELF: {
                        status: 400,
                        message: "You cannot add yourself",
                    },
                    USER_NOT_FOUND: {
                        status: 404,
                        message: "User not found",
                    },
                    REQUEST_ALREADY_EXISTS: {
                        status: 409,
                        message: "Friend request already exists",
                    },
                    ALREADY_FRIENDS: {
                        status: 409,
                        message: "You are already friends",
                    },
                    USER_BLOCKED: {
                        status: 403,
                        message: "Friend request is not allowed",
                    },
                };
                const mapped = errorResponses[error.message];

                if (mapped) {
                    return response.status(mapped.status).json({
                        success: false,
                        message: mapped.message,
                    });
                }
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Get("requests/received")
    async getReceivedRequests(
        @Req() request: AuthenticatedRequest,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const requests = await this.friendsService.getReceivedRequests(request.userId!);
            const data = requests.map((item) => {
                const requester = item.users_friendships_requester_idTousers;
                return {
                    id: item.id.toString(),
                    requesterId: item.requester_id.toString(),
                    addresseeId: item.addressee_id.toString(),
                    status: item.status,
                    createAt: item.created_at,
                    requester: {
                        ...requester,
                        id: requester.id.toString(),
                    },
                };
            });

            return response.status(200).json({
                success: true,
                requests: data,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Get("requests/sent")
    async getSentRequests(
        @Req() request: AuthenticatedRequest,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const requests = await this.friendsService.getSentRequests(request.userId!);
            const data = requests.map((item) => {
                const addressee = item.users_friendships_addressee_idTousers;
                return {
                    id: item.id.toString(),
                    requesterId: item.requester_id.toString(),
                    addresseeId: item.addressee_id.toString(),
                    status: item.status,
                    createdAt: item.created_at,
                    addressee: {
                        ...addressee,
                        id: addressee.id.toString(),
                    },
                };
            });

            return response.status(200).json({
                success: true,
                requests: data,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Patch("requests/:id/accept")
    async acceptFriendRequest(
        @Req() request: AuthenticatedRequest,
        @Param("id") id: string,
        @Res() response: Response,
    ): Promise<Response> {
        if (!id) {
            return response.status(400).json({
                success: false,
                message: "Request id is required",
            });
        }

        try {
            const friendship = await this.friendsService.acceptFriendRequest(
                BigInt(id),
                request.userId!,
            );

            return response.status(200).json({
                success: true,
                message: "Friend request accepted successfully",
                friendship: {
                    id: friendship.id.toString(),
                    requesterId: friendship.requester_id.toString(),
                    addresseeId: friendship.addressee_id.toString(),
                    status: friendship.status,
                },
            });
        } catch (error) {
            if (error instanceof Error && error.message === "REQUEST_NOT_FOUND") {
                return response.status(404).json({
                    success: false,
                    message: "Friend request not found",
                });
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Patch("requests/:id/reject")
    async rejectFriendRequest(
        @Req() request: AuthenticatedRequest,
        @Param("id") id: string,
        @Res() response: Response,
    ): Promise<Response> {
        if (!id) {
            return response.status(400).json({
                success: false,
                message: "Request id is required",
            });
        }

        try {
            const friendship = await this.friendsService.rejectFriendRequest(
                BigInt(id),
                request.userId!,
            );

            return response.status(200).json({
                success: true,
                message: "Friend request rejected successfully",
                friendship: {
                    id: friendship.id.toString(),
                    requesterId: friendship.requester_id.toString(),
                    addresseeId: friendship.addressee_id.toString(),
                    status: friendship.status,
                },
            });
        } catch (error) {
            if (error instanceof Error && error.message === "REQUEST_NOT_FOUND") {
                return response.status(404).json({
                    success: false,
                    message: "Friend request not found",
                });
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Get()
    async getFriends(
        @Req() request: AuthenticatedRequest,
        @Res() response: Response,
    ): Promise<Response> {
        try {
            const friends = await this.friendsService.getFriends(request.userId!);

            return response.status(200).json({
                success: true,
                friends,
            });
        } catch {
            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Delete(":friendId")
    async removeFriend(
        @Req() request: AuthenticatedRequest,
        @Param("friendId") friendIdParam: string,
        @Res() response: Response,
    ): Promise<Response> {
        if (!friendIdParam) {
            return response.status(400).json({
                success: false,
                message: "Friend id is required",
            });
        }

        try {
            await this.friendsService.removeFriend(
                request.userId!,
                BigInt(friendIdParam),
            );

            return response.status(200).json({
                success: true,
                message: "Friend removed successfully",
            });
        } catch (error) {
            if (error instanceof Error && error.message === "FRIENDSHIP_NOT_FOUND") {
                return response.status(404).json({
                    success: false,
                    message: "Friendship not found",
                });
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }

    @Post(":userId/block")
    async blockUser(
        @Req() request: AuthenticatedRequest,
        @Param("userId") userIdParam: string,
        @Res() response: Response,
    ): Promise<Response> {
        if (!userIdParam) {
            return response.status(400).json({
                success: false,
                message: "User id is required",
            });
        }

        try {
            const friendship = await this.friendsService.blockUser(
                request.userId!,
                BigInt(userIdParam),
            );

            return response.status(200).json({
                success: true,
                message: "User blocked successfully",
                friendship: {
                    id: friendship.id.toString(),
                    requesterId: friendship.requester_id.toString(),
                    addresseeId: friendship.addressee_id.toString(),
                    status: friendship.status,
                },
            });
        } catch (error) {
            if (error instanceof Error) {
                if (error.message === "CANNOT_BLOCK_YOURSELF") {
                    return response.status(400).json({
                        success: false,
                        message: "You cannot block yourself",
                    });
                }

                if (error.message === "USER_NOT_FOUND") {
                    return response.status(404).json({
                        success: false,
                        message: "User not found",
                    });
                }
            }

            return response.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    }
}
