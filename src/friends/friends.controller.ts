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

function parseId(value: unknown): bigint | null {
    const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
    if (!/^[1-9]\d{0,19}$/.test(text)) return null;
    const id = BigInt(text);
    return id <= 18446744073709551615n ? id : null;
}

@Controller("api/friends")
@UseGuards(AuthGuard)
export class FriendsController {
    constructor(private readonly friendsService: FriendsService) {}

    @Get("suggestions")
    async getSuggestions(@Req() request: AuthenticatedRequest, @Res() response: Response): Promise<Response> {
        try { return response.status(200).json({ success: true, users: await this.friendsService.getSuggestions(request.userId!) }); }
        catch { return response.status(500).json({ success: false, message: "Internal server error" }); }
    }

    @Get("relationship/:userId")
    async getRelationship(@Req() request: AuthenticatedRequest, @Param("userId") rawId: string, @Res() response: Response): Promise<Response> {
        const id = parseId(rawId);
        if (!id) return response.status(400).json({ success: false, message: "Invalid user id" });
        try { return response.status(200).json({ success: true, relationship: await this.friendsService.relationship(request.userId!, id) }); }
        catch (error) { const status = error instanceof Error && error.message === "USER_NOT_FOUND" ? 404 : 400; return response.status(status).json({ success: false, message: error instanceof Error ? error.message : "Invalid relationship" }); }
    }

    @Post("follow/:userId")
    async follow(@Req() request: AuthenticatedRequest, @Param("userId") rawId: string, @Res() response: Response): Promise<Response> {
        return this.updateFollow(request, rawId, true, response);
    }

    @Delete("follow/:userId")
    async unfollow(@Req() request: AuthenticatedRequest, @Param("userId") rawId: string, @Res() response: Response): Promise<Response> {
        return this.updateFollow(request, rawId, false, response);
    }

    private async updateFollow(request: AuthenticatedRequest, rawId: string, follow: boolean, response: Response): Promise<Response> {
        const id = parseId(rawId);
        if (!id) return response.status(400).json({ success: false, message: "Invalid user id" });
        try { return response.status(200).json({ success: true, relationship: await this.friendsService.toggleFollow(request.userId!, id, follow) }); }
        catch (error) { const code = error instanceof Error ? error.message : "Internal server error"; return response.status(code === "USER_NOT_FOUND" ? 404 : code === "CANNOT_FOLLOW_YOURSELF" ? 400 : 500).json({ success: false, message: code }); }
    }

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

            const parsedAddresseeId = parseId(addresseeId);
            if (!parsedAddresseeId) {
                return response.status(400).json({
                    success: false,
                    message: "addresseeId is required",
                });
            }

            const friendship = await this.friendsService.sendFriendRequest(
                request.userId!,
                parsedAddresseeId,
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
            console.error("Send friend request failed:", error);
            if (typeof error === "object" && error !== null && "code" in error && (error.code === "P2021" || error.code === "P2022")) {
                return response.status(503).json({ success: false, message: "Cơ sở dữ liệu quan hệ chưa được cập nhật. Hãy áp dụng migration quan hệ mới." });
            }
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
                    INCOMING_REQUEST_EXISTS: { status: 409, message: "You already have a pending request from this user" },
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

            if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return response.status(409).json({ success: false, message: "Friend request already exists" });
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
        const requestId = parseId(id);
        if (!requestId) {
            return response.status(400).json({
                success: false,
                message: "Request id is required",
            });
        }

        try {
            const friendship = await this.friendsService.acceptFriendRequest(
                requestId,
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
        const requestId = parseId(id);
        if (!requestId) {
            return response.status(400).json({
                success: false,
                message: "Request id is required",
            });
        }

        try {
            const friendship = await this.friendsService.rejectFriendRequest(
                requestId,
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

    @Delete("requests/:id")
    async cancelFriendRequest(@Req() request: AuthenticatedRequest, @Param("id") rawId: string, @Res() response: Response): Promise<Response> {
        const requestId = parseId(rawId);
        if (!requestId) return response.status(400).json({ success: false, message: "Invalid request id" });
        try { await this.friendsService.cancelFriendRequest(requestId, request.userId!); return response.status(200).json({ success: true }); }
        catch (error) { if (error instanceof Error && error.message === "REQUEST_NOT_FOUND") return response.status(404).json({ success: false, message: "Friend request not found" }); return response.status(500).json({ success: false, message: "Internal server error" }); }
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
        const friendId = parseId(friendIdParam);
        if (!friendId) {
            return response.status(400).json({
                success: false,
                message: "Friend id is required",
            });
        }

        try {
            await this.friendsService.removeFriend(
                request.userId!,
                friendId,
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
        const userId = parseId(userIdParam);
        if (!userId) {
            return response.status(400).json({
                success: false,
                message: "User id is required",
            });
        }

        try {
            const friendship = await this.friendsService.blockUser(
                request.userId!,
                userId,
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
