import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class FriendsService {
    constructor(private readonly prisma: PrismaService) {}

    searchUsers(currentUserId: bigint, keyword: string) {
        return this.prisma.users.findMany({
            where: {
                id: {
                    not: currentUserId,
                },
                deleted: "NO",
                status: "active",
                OR: [
                    {
                        user_name: {
                            contains: keyword,
                        },
                    },
                    {
                        email: {
                            contains: keyword,
                        },
                    },
                    {
                        first_name: {
                            contains: keyword,
                        },
                    },
                    {
                        last_name: {
                            contains: keyword,
                        },
                    },
                ],
            },
            select: {
                id: true,
                email: true,
                status: true,
                user_name: true,
                first_name: true,
                last_name: true,
                avatar: true,
            },
            take: 20,
        });
    }

    async sendFriendRequest(requesterId: bigint, addresseeId: bigint) {
        if (requesterId === addresseeId) {
            throw new Error("CANNOT_ADD_YOURSELF");
        }

        const addressee = await this.prisma.users.findFirst({
            where: {
                id: addresseeId,
                deleted: "NO",
                status: "active",
            },
        });

        if (!addressee) {
            throw new Error("USER_NOT_FOUND");
        }

        const existingFriendship = await this.prisma.friendships.findFirst({
            where: {
                OR: [
                    {
                        requester_id: requesterId,
                        addressee_id: addresseeId,
                    },
                    {
                        requester_id: addresseeId,
                        addressee_id: requesterId,
                    },
                ],
            },
        });

        if (existingFriendship) {
            switch (existingFriendship.status) {
                case "pending":
                    throw new Error("REQUEST_ALREADY_EXISTS");
                case "accepted":
                    throw new Error("ALREADY_FRIENDS");
                case "blocked":
                    throw new Error("USER_BLOCKED");
                case "rejected":
                    return this.prisma.$transaction(async (transaction) => {
                        const friendship = await transaction.friendships.update({
                            where: {
                                id: existingFriendship.id,
                            },
                            data: {
                                requester_id: requesterId,
                                addressee_id: addresseeId,
                                status: "pending",
                                updated_at: new Date(),
                            },
                        });

                        await transaction.notifications.create({
                            data: {
                                user_id: addresseeId,
                                actor_id: requesterId,
                                type: "friend_request",
                                reference_id: friendship.id,
                            },
                        });

                        return friendship;
                    });
            }
        }

        return this.prisma.$transaction(async (transaction) => {
            const friendship = await transaction.friendships.create({
                data: {
                    requester_id: requesterId,
                    addressee_id: addresseeId,
                    status: "pending",
                },
            });

            await transaction.notifications.create({
                data: {
                    user_id: addresseeId,
                    actor_id: requesterId,
                    type: "friend_request",
                    reference_id: friendship.id,
                },
            });

            return friendship;
        });
    }

    getReceivedRequests(userId: bigint) {
        return this.prisma.friendships.findMany({
            where: {
                addressee_id: userId,
                status: "pending",
            },
            include: {
                users_friendships_requester_idTousers: {
                    select: {
                        id: true,
                        email: true,
                        status: true,
                        user_name: true,
                        first_name: true,
                        last_name: true,
                        avatar: true,
                    },
                },
            },
            orderBy: {
                created_at: "desc",
            },
        });
    }

    getSentRequests(userId: bigint) {
        return this.prisma.friendships.findMany({
            where: {
                requester_id: userId,
                status: "pending",
            },
            include: {
                users_friendships_addressee_idTousers: {
                    select: {
                        id: true,
                        email: true,
                        status: true,
                        user_name: true,
                        first_name: true,
                        last_name: true,
                        avatar: true,
                    },
                },
            },
            orderBy: {
                created_at: "desc",
            },
        });
    }

    async acceptFriendRequest(requestId: bigint, currentUserId: bigint) {
        const request = await this.prisma.friendships.findFirst({
            where: {
                id: requestId,
                addressee_id: currentUserId,
                status: "pending",
            },
        });

        if (!request) {
            throw new Error("REQUEST_NOT_FOUND");
        }

        return this.prisma.$transaction(async (transaction) => {
            const friendship = await transaction.friendships.update({
                where: {
                    id: request.id,
                },
                data: {
                    status: "accepted",
                    updated_at: new Date(),
                },
            });

            await transaction.notifications.create({
                data: {
                    user_id: request.requester_id,
                    actor_id: currentUserId,
                    type: "friend_accept",
                    reference_id: friendship.id,
                },
            });

            return friendship;
        });
    }

    async rejectFriendRequest(requestId: bigint, currentUserId: bigint) {
        const request = await this.prisma.friendships.findFirst({
            where: {
                id: requestId,
                addressee_id: currentUserId,
                status: "pending",
            },
        });

        if (!request) {
            throw new Error("REQUEST_NOT_FOUND");
        }

        return this.prisma.friendships.update({
            where: {
                id: request.id,
            },
            data: {
                status: "rejected",
                updated_at: new Date(),
            },
        });
    }

    async getFriends(currentUserId: bigint) {
        const friendships = await this.prisma.friendships.findMany({
            where: {
                status: "accepted",
                OR: [
                    {
                        requester_id: currentUserId,
                    },
                    {
                        addressee_id: currentUserId,
                    },
                ],
            },
            include: {
                users_friendships_requester_idTousers: {
                    select: {
                        id: true,
                        email: true,
                        user_name: true,
                        first_name: true,
                        last_name: true,
                        avatar: true,
                    },
                },
                users_friendships_addressee_idTousers: {
                    select: {
                        id: true,
                        email: true,
                        user_name: true,
                        first_name: true,
                        last_name: true,
                        avatar: true,
                    },
                },
            },
        });

        return friendships.map((item) => {
            if (item.requester_id === currentUserId) {
                const friend = item.users_friendships_addressee_idTousers;
                return {
                    friendshipId: item.id.toString(),
                    ...friend,
                    id: friend.id.toString(),
                };
            }

            const friend = item.users_friendships_requester_idTousers;
            return {
                friendshipId: item.id.toString(),
                ...friend,
                id: friend.id.toString(),
            };
        });
    }

    async removeFriend(currentUserId: bigint, friendId: bigint) {
        const friendship = await this.prisma.friendships.findFirst({
            where: {
                status: "accepted",
                OR: [
                    {
                        requester_id: currentUserId,
                        addressee_id: friendId,
                    },
                    {
                        requester_id: friendId,
                        addressee_id: currentUserId,
                    },
                ],
            },
        });

        if (!friendship) {
            throw new Error("FRIENDSHIP_NOT_FOUND");
        }

        return this.prisma.friendships.delete({
            where: {
                id: friendship.id,
            },
        });
    }

    async blockUser(currentUserId: bigint, targetUserId: bigint) {
        if (currentUserId === targetUserId) {
            throw new Error("CANNOT_BLOCK_YOURSELF");
        }

        const target = await this.prisma.users.findFirst({
            where: {
                id: targetUserId,
                deleted: "NO",
            },
        });

        if (!target) {
            throw new Error("USER_NOT_FOUND");
        }

        const existing = await this.prisma.friendships.findFirst({
            where: {
                OR: [
                    {
                        requester_id: currentUserId,
                        addressee_id: targetUserId,
                    },
                    {
                        requester_id: targetUserId,
                        addressee_id: currentUserId,
                    },
                ],
            },
        });

        if (existing) {
            return this.prisma.friendships.update({
                where: {
                    id: existing.id,
                },
                data: {
                    requester_id: currentUserId,
                    addressee_id: targetUserId,
                    status: "blocked",
                    updated_at: new Date(),
                },
            });
        }

        return this.prisma.friendships.create({
            data: {
                requester_id: currentUserId,
                addressee_id: targetUserId,
                status: "blocked",
            },
        });
    }
}
