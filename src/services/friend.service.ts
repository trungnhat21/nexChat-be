import prisma from "../configs/prisma.js";

// Search user
export const searchUsers = async (currentUserId: bigint, keyword: string) => {
    return prisma.users.findMany({
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
};

// friend request
export const sendFriendRequest = async (requesterId: bigint, addresseeId: bigint) => {
    if (requesterId === addresseeId) {
        throw new Error("CANNOT_ADD_YOURSELF");
    }
    const addressee = await prisma.users.findFirst({
        where: {
            id: addresseeId,
            deleted: "NO",
            status: "active",
        },
    });

    if (!addressee) {
        throw new Error("USER_NOT_FOUND");
    }
    const existingSFriendship = await prisma.friendships.findFirst({
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
    
    if (existingSFriendship) {
        switch (existingSFriendship.status) {
            case "pending":
                throw new Error("REQUEST_ALREADY_EXISTS");
            case "accepted":
                throw new Error("ALREADY_FRIENDS");
            case "blocked":
                throw new Error("USER_BLOCKED");
            case "rejected":
                return prisma.friendships.update({
                    where: {
                        id: existingSFriendship.id,
                    },
                    data: {
                        requester_id: requesterId,
                        addressee_id: addresseeId,
                        status: "pending",
                        updated_at: new Date(),
                    },
                });
        }
    }

    return prisma.friendships.create({
        data:{
            requester_id: requesterId,
            addressee_id: addresseeId,
            status: "pending",
        },
    });
};

export const getReceivedRequests = async (userId: bigint) => {
    return prisma.friendships.findMany({
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
};

export const getSentRequests = async (userId: bigint) => {
    return prisma.friendships.findMany({
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
};

//Accept friend request
export const acceptFriendRequest = async (friendshipId: bigint, currentUserId: bigint) => {
    const request = await prisma.friendships.findFirst({
        where: {
            id: friendshipId,
            addressee_id: currentUserId,
            status: "pending",
        },
    });

    if (!request) {
        throw new Error("Request not found");
    }
    return prisma.friendships.update({
        where: {
            id: request.id,
        },
        data: {
            status: "accepted",
            updated_at: new Date(),
        },
    });
};

//Reject request
export const rejectFriendRequest = async (requestId: bigint, currentUserId: bigint) => {
    const request =
        await prisma.friendships.findFirst({
            where: {
                id: requestId,
                addressee_id: currentUserId,
                status: "pending",
            },
        });

    if (!request) {
        throw new Error("Request not found");
    }

    return prisma.friendships.update({
        where: {
            id: request.id,
        },

        data: {
            status: "rejected",
            updated_at: new Date(),
        },
    });
};

export const getFriends = async (currentUserId: bigint) => {
    const friendships = await prisma.friendships.findMany({
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
};

//Unfriend
export const removeFriend = async (currentUserId: bigint, friendId: bigint) => {
    const friendship = await prisma.friendships.findFirst({
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
        throw new Error("Friendship not found");
    }

    return prisma.friendships.delete({
        where: {
            id: friendship.id,
        },
    });
};

//Block
export const blockUser = async (currentUserId: bigint, targetUserId: bigint) => {
    if (currentUserId === targetUserId) {
        throw new Error("Cannot block yourself");
    }
    const target = await prisma.users.findFirst({
            where: {
                id: targetUserId,
                deleted: "NO",
            },
        });

    if (!target) {
        throw new Error("User not found");
    }

    const existing = await prisma.friendships.findFirst({
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
        return prisma.friendships.update({
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

    return prisma.friendships.create({
        data: {
            requester_id: currentUserId,
            addressee_id: targetUserId,
            status: "blocked",
        },
    });
};