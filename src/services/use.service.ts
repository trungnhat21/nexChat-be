import prisma from "../configs/prisma";

export const getAllUser = async () => {
    return await prisma.users.findMany({
        orderBy: {
            created_at: "asc",
        },
    });
};

export const getUserById = async (id: bigint) => {
    return await prisma.users.findUnique({
        where: {
            id,
        },
    });
};