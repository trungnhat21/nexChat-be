import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { PostStorageService } from "../posts/post-storage.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

@Injectable()
export class FriendsService {
    constructor(private readonly prisma: PrismaService, private readonly storage: PostStorageService, private readonly notifications: NotificationsService) {}

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
                    throw new Error(existingFriendship.requester_id === requesterId ? "REQUEST_ALREADY_EXISTS" : "INCOMING_REQUEST_EXISTS");
                case "accepted":
                    throw new Error("ALREADY_FRIENDS");
                case "blocked":
                    throw new Error("USER_BLOCKED");
                case "rejected":
                    const friendship = await this.prisma.$transaction(async (transaction) => {
                        const friendship = await transaction.friendships.update({
                            where: {
                                id: existingFriendship.id,
                            },
                            data: {
                                requester_id: requesterId,
                                addressee_id: addresseeId,
                                user_low_id: requesterId < addresseeId ? requesterId : addresseeId,
                                user_high_id: requesterId > addresseeId ? requesterId : addresseeId,
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
                    this.notifications.emitCreated(addresseeId);
                    return friendship;
            }
        }

        try { const friendship = await this.prisma.$transaction(async (transaction) => {
            const friendship = await transaction.friendships.create({
                data: {
                    requester_id: requesterId,
                    addressee_id: addresseeId,
                    user_low_id: requesterId < addresseeId ? requesterId : addresseeId,
                    user_high_id: requesterId > addresseeId ? requesterId : addresseeId,
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
        }); this.notifications.emitCreated(addresseeId); return friendship; } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") throw new Error("REQUEST_ALREADY_EXISTS");
            throw error;
        }
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
        const friendship = await this.prisma.$transaction(async (transaction) => {
            const request = await transaction.friendships.findFirst({ where: { id: requestId, addressee_id: currentUserId, status: "pending" } });
            if (!request) throw new Error("REQUEST_NOT_FOUND");
            const changed = await transaction.friendships.updateMany({ where: { id: request.id, addressee_id: currentUserId, status: "pending" }, data: { status: "accepted", updated_at: new Date() } });
            if (!changed.count) throw new Error("REQUEST_NOT_FOUND");
            const friendship = { ...request, status: "accepted" as const };

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
        this.notifications.emitCreated(friendship.requester_id);
        this.notifications.notifyFriendshipAccepted(friendship.requester_id, friendship.addressee_id);
        return friendship;
    }

    async rejectFriendRequest(requestId: bigint, currentUserId: bigint) {
        const result = await this.prisma.friendships.updateMany({ where: { id: requestId, addressee_id: currentUserId, status: "pending" }, data: { status: "rejected", updated_at: new Date() } });
        if (!result.count) throw new Error("REQUEST_NOT_FOUND");
        return this.prisma.friendships.findUniqueOrThrow({ where: { id: requestId } });
    }

    async cancelFriendRequest(requestId: bigint, currentUserId: bigint) {
        const result = await this.prisma.friendships.deleteMany({ where: { id: requestId, requester_id: currentUserId, status: "pending" } });
        if (!result.count) throw new Error("REQUEST_NOT_FOUND");
    }

    async relationship(currentUserId: bigint, targetId: bigint) {
        const [friendship, followed, target] = await Promise.all([
            this.prisma.friendships.findFirst({ where: { OR: [{ requester_id: currentUserId, addressee_id: targetId }, { requester_id: targetId, addressee_id: currentUserId }] } }),
            this.prisma.follows.findUnique({ where: { follower_id_following_id: { follower_id: currentUserId, following_id: targetId } }, select: { id: true } }),
            this.prisma.users.findFirst({ where: { id: targetId, deleted: "NO", status: "active" }, select: { id: true } }),
        ]);
        if (!target) throw new Error("USER_NOT_FOUND");
        const [followers, following, friends] = await Promise.all([
            this.prisma.follows.count({ where: { following_id: targetId } }),
            this.prisma.follows.count({ where: { follower_id: targetId } }),
            this.prisma.friendships.count({ where: { status: "accepted", OR: [{ requester_id: targetId }, { addressee_id: targetId }] } }),
        ]);
        let friendStatus: string = "none";
        let requestId: string | null = null;
        if (friendship) {
            if (friendship.status === "accepted") friendStatus = "friends";
            else if (friendship.status === "blocked") friendStatus = "blocked";
            else if (friendship.status === "pending") {
                friendStatus = friendship.requester_id === currentUserId ? "outgoing" : "incoming";
                requestId = friendship.id.toString();
            }
        }
        return { friendStatus, requestId, following: !!followed, followers, followingCount: following, friends };
    }

    async toggleFollow(currentUserId: bigint, targetId: bigint, follow: boolean) {
        if (currentUserId === targetId) throw new Error("CANNOT_FOLLOW_YOURSELF");
        const target = await this.prisma.users.findFirst({ where: { id: targetId, deleted: "NO", status: "active" }, select: { id: true } });
        if (!target) throw new Error("USER_NOT_FOUND");
        if (follow) await this.prisma.follows.upsert({ where: { follower_id_following_id: { follower_id: currentUserId, following_id: targetId } }, create: { follower_id: currentUserId, following_id: targetId }, update: {} });
        else await this.prisma.follows.deleteMany({ where: { follower_id: currentUserId, following_id: targetId } });
        return this.relationship(currentUserId, targetId);
    }

    async getSuggestions(currentUserId: bigint) {
        const users = await this.prisma.users.findMany({ where: { id: { not: currentUserId }, deleted: "NO", status: "active" }, select: { id: true, user_name: true, first_name: true, last_name: true, avatar: true, profiles: { select: { avatar_url: true } } }, orderBy: { id: "desc" }, take: 12 });
        const ids = users.map(user => user.id);
        const [friendships, follows] = await Promise.all([
            ids.length ? this.prisma.friendships.findMany({ where: { OR: [{ requester_id: currentUserId, addressee_id: { in: ids } }, { requester_id: { in: ids }, addressee_id: currentUserId }] } }) : [],
            ids.length ? this.prisma.follows.findMany({ where: { follower_id: currentUserId, following_id: { in: ids } }, select: { following_id: true } }) : [],
        ]);
        return Promise.all(users.map(async user => {
            const edge = friendships.find(item => item.requester_id === user.id || item.addressee_id === user.id);
            const friendStatus = !edge ? "none" : edge.status === "accepted" ? "friends" : edge.status === "blocked" ? "blocked" : edge.status === "pending" ? edge.requester_id === currentUserId ? "outgoing" : "incoming" : "none";
            const avatar = user.profiles?.avatar_url || user.avatar;
            return { id: user.id.toString(), name: [user.last_name, user.first_name].filter(Boolean).join(" ") || user.user_name || "User", avatar: avatar?.startsWith("profiles/") ? await this.storage.url(avatar, null) : avatar, friendStatus, requestId: edge?.status === "pending" ? edge.id.toString() : null, following: follows.some(item => item.following_id === user.id) };
        }));
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

        return Promise.all(friendships.map(async (item) => {
            const friend = item.requester_id === currentUserId
                ? item.users_friendships_addressee_idTousers
                : item.users_friendships_requester_idTousers;
            const avatar = friend.avatar?.startsWith("profiles/")
                ? await this.storage.url(friend.avatar, null)
                : friend.avatar;
            return {
                friendshipId: item.id.toString(),
                ...friend,
                avatar,
                id: friend.id.toString(),
            };
        }));
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
                    user_low_id: currentUserId < targetUserId ? currentUserId : targetUserId,
                    user_high_id: currentUserId > targetUserId ? currentUserId : targetUserId,
                    status: "blocked",
                    updated_at: new Date(),
                },
            });
        }

        return this.prisma.friendships.create({
            data: {
                requester_id: currentUserId,
                addressee_id: targetUserId,
                user_low_id: currentUserId < targetUserId ? currentUserId : targetUserId,
                user_high_id: currentUserId > targetUserId ? currentUserId : targetUserId,
                status: "blocked",
            },
        });
    }
}
