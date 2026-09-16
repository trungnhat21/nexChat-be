import type { Response } from "express";
import type { AuthRequest } from "../middlewares/auth.middleware.js";
import * as friendService from "../services/friend.service.js";

export const searchUsers = async (req: AuthRequest, res: Response) => {
    try {
        const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim() : "";

        if (!keyword) {
            return res.status(400).json({
                success: false,
                message: "Keyword is required",
            });
        }
        
        const users = await friendService.searchUsers(
            req.userId!,
            keyword
        );
        return res.status(200).json({
            success: true,
            users: users.map((user) =>({
                ...user,
                id: user.id.toString(),
            })),
        });
    } catch (error) {
        console.error("Search users error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const sendFriendRequest = async (req: AuthRequest, res: Response) => {
    try {
        const { addresseeId } = req.body;

        if (!addresseeId) {
            return res.status(400).json({
                success: false,
                message: "addresseeId is required",
            });
        }

        const friendship = await friendService.sendFriendRequest(req.userId!, BigInt(addresseeId));

        return res.status(201).json({
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

            switch (error.message) {

                case "CANNOT_ADD_YOURSELF":
                    return res.status(400).json({
                        success: false,
                        message: "You cannot add yourself",
                    });

                case "USER_NOT_FOUND":
                    return res.status(404).json({
                        success: false,
                        message: "User not found",
                    });

                case "REQUEST_ALREADY_EXISTS":
                    return res.status(409).json({
                        success: false,
                        message: "Friend request already exists",
                    });

                case "ALREADY_FRIENDS":
                    return res.status(409).json({
                        success: false,
                        message: "You are already friends",
                    });

                case "USER_BLOCKED":
                    return res.status(403).json({
                        success: false,
                        message: "Friend request is not allowed",
                    });
            }
        }

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const getReceivedRequests = async (req: AuthRequest, res:Response) => {
    try {
        const requests = await friendService.getReceivedRequests(req.userId!);
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

        return res.status(200).json({
            success: true,
            requests: data,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const getSentRequests = async (req: AuthRequest, res: Response) => {
    try {
        const requests = await friendService.getSentRequests(req.userId!);

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

        return res.status(200).json({
            success: true,
            requests: data,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const acceptFriendRequest = async (req: AuthRequest, res: Response) => {
    try {
        const id = req.params.id;

        if (!id || Array.isArray(id)) {
            return res.status(400).json({
                success: false,
                message: "Request id is required",
            });
        }

        const requestId = BigInt(id);

        const friendship = await friendService.acceptFriendRequest(requestId, req.userId!);

        return res.status(200).json({
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
        if (
            error instanceof Error &&
            error.message === "REQUEST_NOT_FOUND"
        ) {
            return res.status(404).json({
                success: false,
                message: "Friend request not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const rejectFriendRequest = async (req: AuthRequest, res: Response) => {
    try {
        const id = req.params.id;

        if (!id || Array.isArray(id)) {
            return res.status(400).json({
                success: false,
                message: "Request id is required",
            });
        }

        const requestId = BigInt(id);

        const friendship = await friendService.rejectFriendRequest(requestId, req.userId!);

        return res.status(200).json({
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
        if (
            error instanceof Error &&
            error.message === "REQUEST_NOT_FOUND"
        ) {
            return res.status(404).json({
                success: false,
                message: "Friend request not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const getFriends = async (req: AuthRequest, res: Response) => {
    try {
        const friends = await friendService.getFriends(req.userId!);

        return res.status(200).json({
            success: true,
            friends,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const removeFriend = async (req: AuthRequest, res: Response) => {
    try {
        const friendIdParam = req.params.friendId;

        if (!friendIdParam || Array.isArray(friendIdParam)) {
            return res.status(400).json({
                success: false,
                message: "Friend id is required",
            });
        }

        const friendId = BigInt(friendIdParam);

        await friendService.removeFriend(req.userId!, friendId);

        return res.status(200).json({
            success: true,
            message: "Friend removed successfully",
        });
    } catch (error) {
        if (
            error instanceof Error &&
            error.message === "FRIENDSHIP_NOT_FOUND"
        ) {
            return res.status(404).json({
                success: false,
                message: "Friendship not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

export const blockUser = async (req: AuthRequest, res: Response) => {
    try {
        const userIdParam = req.params.userId;

        if (!userIdParam || Array.isArray(userIdParam)) {
            return res.status(400).json({
                success: false,
                message: "User id is required",
            });
        }

        const targetUserId = BigInt(userIdParam);

        const friendship = await friendService.blockUser(req.userId!, targetUserId);

        return res.status(200).json({
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
            switch (error.message) {
                case "CANNOT_BLOCK_YOURSELF":
                    return res.status(400).json({
                        success: false,
                        message: "You cannot block yourself",
                    });

                case "USER_NOT_FOUND":
                    return res.status(404).json({
                        success: false,
                        message: "User not found",
                    });
            }
        }

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};