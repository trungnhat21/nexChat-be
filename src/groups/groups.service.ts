import {
    ForbiddenException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { GroupError, GroupFlowError, MANAGE_ROLES } from "./groups.types.js";
import type { CreateGroupDto } from "./dto/create-group.dto.js";
import type { UpdateGroupDto } from "./dto/update-group.dto.js";
import type { UpdateMemberDto } from "./dto/join-group.dto.js";

// ─── Prisma select helpers ───────────────────────────────────────────────────

const groupBaseSelect = {
    id: true,
    name: true,
    description: true,
    cover_image: true,
    avatar: true,
    privacy: true,
    requires_approval: true,
    creator_id: true,
    created_at: true,
    updated_at: true,
} as const;

const memberUserSelect = {
    id: true,
    user_name: true,
    first_name: true,
    last_name: true,
    avatar: true,
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class GroupsService {
    constructor(private readonly prisma: PrismaService) {}

    // ── helpers ───────────────────────────────────────────────────────────────

    /** Serialize a BigInt group row into a plain JSON-safe object. */
    private serializeGroup(
        row: { id: bigint; creator_id: bigint; created_at: Date; updated_at: Date } & Record<string, unknown>,
        extra?: Record<string, unknown>,
    ) {
        return {
            ...row,
            id: row.id.toString(),
            creator_id: row.creator_id.toString(),
            created_at: (row.created_at as Date).toISOString(),
            updated_at: (row.updated_at as Date).toISOString(),
            ...extra,
        };
    }

    private serializeMember(member: {
        group_id: bigint;
        user_id: bigint;
        role: string;
        status: string;
        joined_at: Date;
        users?: {
            id: bigint;
            user_name: string | null;
            first_name: string | null;
            last_name: string | null;
            avatar: string | null;
        };
    }) {
        return {
            groupId: member.group_id.toString(),
            userId: member.user_id.toString(),
            role: member.role,
            status: member.status,
            joinedAt: member.joined_at.toISOString(),
            user: member.users
                ? {
                      id: member.users.id.toString(),
                      userName: member.users.user_name,
                      firstName: member.users.first_name,
                      lastName: member.users.last_name,
                      avatar: member.users.avatar,
                  }
                : undefined,
        };
    }

    /** Fetch a group or throw NotFoundException. */
    private async requireGroup(groupId: bigint) {
        const group = await this.prisma.groups.findUnique({
            where: { id: groupId },
            select: groupBaseSelect,
        });
        if (!group) throw new NotFoundException("Không tìm thấy nhóm.");
        return group;
    }

    /** Fetch a membership or return null. */
    private getMembership(groupId: bigint, userId: bigint) {
        return this.prisma.group_members.findUnique({
            where: { group_id_user_id: { group_id: groupId, user_id: userId } },
        });
    }

    /** Require an active (JOINED) membership with at least the given roles. */
    private async requireRole(
        groupId: bigint,
        userId: bigint,
        allowedRoles: readonly string[],
    ) {
        const membership = await this.getMembership(groupId, userId);
        if (!membership || membership.status !== "JOINED") {
            throw new ForbiddenException("Bạn không phải thành viên của nhóm này.");
        }
        if (!allowedRoles.includes(membership.role)) {
            throw new ForbiddenException("Bạn không có quyền thực hiện thao tác này.");
        }
        return membership;
    }

    // ── Create ────────────────────────────────────────────────────────────────

    async createGroup(userId: bigint, dto: CreateGroupDto) {
        const group = await this.prisma.$transaction(async (tx) => {
            const created = await tx.groups.create({
                data: {
                    name: dto.name,
                    description: dto.description ?? null,
                    cover_image: dto.cover_image ?? null,
                    avatar: dto.avatar ?? null,
                    privacy: dto.privacy ?? "PUBLIC",
                    requires_approval: dto.requires_approval ?? false,
                    creator_id: userId,
                },
                select: groupBaseSelect,
            });

            // Auto-add creator as OWNER member
            await tx.group_members.create({
                data: {
                    group_id: created.id,
                    user_id: userId,
                    role: "OWNER",
                    status: "JOINED",
                },
            });

            return created;
        });

        return { success: true, group: this.serializeGroup(group) };
    }

    // ── List ──────────────────────────────────────────────────────────────────

    /**
     * Returns:
     *   - `joined`: groups the user is already a member of (status JOINED)
     *   - `suggested`: public groups the user has not joined, ordered by newest
     */
    async listGroups(userId: bigint) {
        const [joinedRows, suggestedRows] = await Promise.all([
            this.prisma.groups.findMany({
                where: {
                    members: { some: { user_id: userId, status: "JOINED" } },
                },
                select: {
                    ...groupBaseSelect,
                    _count: { select: { members: { where: { status: "JOINED" } } } },
                    members: {
                        where: { user_id: userId },
                        select: { role: true, status: true },
                    },
                },
                orderBy: { updated_at: "desc" },
                take: 50,
            }),

            this.prisma.groups.findMany({
                where: {
                    privacy: "PUBLIC",
                    members: { none: { user_id: userId } },
                },
                select: {
                    ...groupBaseSelect,
                    _count: { select: { members: { where: { status: "JOINED" } } } },
                },
                orderBy: { created_at: "desc" },
                take: 20,
            }),
        ]);

        const serialize = (
            row: (typeof joinedRows)[0] | (typeof suggestedRows)[0],
            membership?: { role: string; status: string } | null,
        ) => ({
            ...this.serializeGroup(row),
            memberCount: row._count.members,
            membership: membership ?? null,
        });

        return {
            success: true,
            joined: joinedRows.map((row) =>
                serialize(row, row.members[0] ?? null),
            ),
            suggested: suggestedRows.map((row) => serialize(row)),
        };
    }

    
    // ── Get Top Groups by Member Count ─────────────────────────────────────────

    async getTopGroups(limit = 3) {
        const rows = await this.prisma.groups.findMany({
            where: { privacy: "PUBLIC" },
            select: {
                ...groupBaseSelect,
                _count: { select: { members: { where: { status: "JOINED" } } } },
            },
            orderBy: {
                members: { _count: "desc" },
            },
            take: limit,
        });

        return {
            success: true,
            groups: rows.map((row) => ({
                ...this.serializeGroup(row),
                memberCount: row._count.members,
            })),
        };
    }

    
    // ── Group Notification Count ──────────────────────────────────────────────

    async getGroupNotificationCount(userId: bigint): Promise<number> {
        const memberships = await this.prisma.group_members.findMany({
            where: {
                user_id: userId,
                status: "JOINED",
                role: { in: ["OWNER", "ADMIN", "MODERATOR"] },
            },
            select: { group_id: true, role: true },
        });

        if (!memberships.length) return 0;

        const adminGroupIds = memberships
            .filter((m) => m.role === "OWNER" || m.role === "ADMIN")
            .map((m) => m.group_id);

        const modGroupIds = memberships.map((m) => m.group_id);

        const [pendingMembersCount, pendingPostsCount] = await Promise.all([
            adminGroupIds.length
                ? this.prisma.group_members.count({
                      where: {
                          group_id: { in: adminGroupIds },
                          status: "PENDING",
                      },
                  })
                : 0,
            modGroupIds.length
                ? this.prisma.posts.count({
                      where: {
                          group_id: { in: modGroupIds },
                          approval_status: "PENDING_APPROVAL",
                          deleted_at: null,
                      },
                  })
                : 0,
        ]);

        return pendingMembersCount + pendingPostsCount;
    }

    // ── Get by ID ─────────────────────────────────────────────────────────────

    async getGroup(userId: bigint, groupId: bigint) {
        const group = await this.prisma.groups.findUnique({
            where: { id: groupId },
            select: {
                ...groupBaseSelect,
                _count: { select: { members: { where: { status: "JOINED" } } } },
                members: {
                    where: { user_id: userId },
                    select: { role: true, status: true, joined_at: true },
                },
            },
        });

        if (!group) throw new NotFoundException("Không tìm thấy nhóm.");

        const myMembership = group.members[0] ?? null;

        // Private groups are hidden from non-members
        if (group.privacy === "PRIVATE" && !myMembership) {
            throw new NotFoundException("Không tìm thấy nhóm.");
        }

        return {
            success: true,
            group: {
                ...this.serializeGroup(group),
                memberCount: group._count.members,
                membership: myMembership
                    ? {
                          role: myMembership.role,
                          status: myMembership.status,
                          joinedAt: myMembership.joined_at.toISOString(),
                      }
                    : null,
            },
        };
    }

    // ── Update ────────────────────────────────────────────────────────────────

    async updateGroup(userId: bigint, groupId: bigint, dto: UpdateGroupDto) {
        await this.requireGroup(groupId);
        await this.requireRole(groupId, userId, MANAGE_ROLES);

        const updated = await this.prisma.groups.update({
            where: { id: groupId },
            data: {
                ...(dto.name !== undefined && { name: dto.name }),
                ...(dto.description !== undefined && { description: dto.description }),
                ...(dto.cover_image !== undefined && { cover_image: dto.cover_image }),
                ...(dto.avatar !== undefined && { avatar: dto.avatar }),
                ...(dto.privacy !== undefined && { privacy: dto.privacy }),
                ...(dto.requires_approval !== undefined && {
                    requires_approval: dto.requires_approval,
                }),
                updated_at: new Date(),
            },
            select: groupBaseSelect,
        });

        return { success: true, group: this.serializeGroup(updated) };
    }

    // ── Join ──────────────────────────────────────────────────────────────────

    async joinGroup(userId: bigint, groupId: bigint) {
        const group = await this.requireGroup(groupId);

        const existing = await this.getMembership(groupId, userId);
        if (existing) {
            if (existing.status === "BANNED") {
                throw new ForbiddenException("Bạn đã bị cấm khỏi nhóm này.");
            }
            throw new GroupFlowError(GroupError.ALREADY_MEMBER);
        }

        const status = group.privacy === "PRIVATE" || group.requires_approval
            ? "PENDING"
            : "JOINED";

        const member = await this.prisma.group_members.create({
            data: {
                group_id: groupId,
                user_id: userId,
                role: "MEMBER",
                status,
            },
        });

        return {
            success: true,
            message:
                status === "PENDING"
                    ? "Yêu cầu tham gia đã được gửi, chờ duyệt."
                    : "Tham gia nhóm thành công.",
            membership: this.serializeMember(member),
        };
    }

    // ── Leave ─────────────────────────────────────────────────────────────────

    async leaveGroup(userId: bigint, groupId: bigint) {
        await this.requireGroup(groupId);

        const membership = await this.getMembership(groupId, userId);
        if (!membership) throw new GroupFlowError(GroupError.NOT_A_MEMBER);

        if (membership.role === "OWNER") {
            throw new GroupFlowError(GroupError.OWNER_CANNOT_LEAVE);
        }

        await this.prisma.group_members.delete({
            where: { group_id_user_id: { group_id: groupId, user_id: userId } },
        });

        return { success: true, message: "Đã rời nhóm." };
    }

    // ── List members ──────────────────────────────────────────────────────────

    async listMembers(
        userId: bigint,
        groupId: bigint,
        opts: { page: number; limit: number; role?: string; status?: string },
    ) {
        const group = await this.requireGroup(groupId);

        // Private groups: only members can see the member list
        const myMembership = await this.getMembership(groupId, userId);
        if (
            group.privacy === "PRIVATE" &&
            (!myMembership || myMembership.status !== "JOINED")
        ) {
            throw new ForbiddenException("Bạn không thể xem danh sách thành viên nhóm riêng tư.");
        }

        const where = {
            group_id: groupId,
            ...(opts.role ? { role: opts.role as "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER" } : {}),
            ...(opts.status ? { status: opts.status as "JOINED" | "PENDING" | "BANNED" } : { status: "JOINED" as const }),
        };

        const [total, members] = await Promise.all([
            this.prisma.group_members.count({ where }),
            this.prisma.group_members.findMany({
                where,
                include: { users: { select: memberUserSelect } },
                orderBy: [{ role: "asc" }, { joined_at: "asc" }],
                skip: (opts.page - 1) * opts.limit,
                take: opts.limit,
            }),
        ]);

        return {
            success: true,
            total,
            page: opts.page,
            limit: opts.limit,
            members: members.map((m) => this.serializeMember(m)),
        };
    }

    // ── Update member (approve / role change) ─────────────────────────────────

    async updateMember(
        actorId: bigint,
        groupId: bigint,
        targetUserId: bigint,
        dto: UpdateMemberDto,
    ) {
        await this.requireGroup(groupId);

        // Actor must be OWNER or ADMIN
        const actorMembership = await this.requireRole(groupId, actorId, MANAGE_ROLES);

        const targetMembership = await this.getMembership(groupId, targetUserId);
        if (!targetMembership) throw new GroupFlowError(GroupError.MEMBER_NOT_FOUND);

        // Only OWNER can promote to ADMIN or reassign OWNER role
        if (
            dto.role &&
            (dto.role === "OWNER" || dto.role === "ADMIN") &&
            actorMembership.role !== "OWNER"
        ) {
            throw new ForbiddenException(
                "Chỉ OWNER mới có thể thay đổi quyền ADMIN hoặc OWNER.",
            );
        }

        // Prevent ADMIN from acting on OWNER
        if (targetMembership.role === "OWNER" && actorMembership.role !== "OWNER") {
            throw new ForbiddenException("Không thể thay đổi quyền của OWNER nhóm.");
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            const member = await tx.group_members.update({
                where: {
                    group_id_user_id: { group_id: groupId, user_id: targetUserId },
                },
                data: {
                    ...(dto.role !== undefined && { role: dto.role }),
                    ...(dto.status !== undefined && { status: dto.status }),
                },
                include: { users: { select: memberUserSelect } },
            });

            // If OWNER transfers ownership, demote themselves to ADMIN
            if (dto.role === "OWNER" && actorId !== targetUserId) {
                await tx.group_members.update({
                    where: {
                        group_id_user_id: { group_id: groupId, user_id: actorId },
                    },
                    data: { role: "ADMIN" },
                });
            }

            return member;
        });

        return {
            success: true,
            message: "Cập nhật thành viên thành công.",
            membership: this.serializeMember(updated),
        };
    }

    // ── Remove member / Reject pending request ───────────────────────────────

    async removeMember(actorId: bigint, groupId: bigint, targetUserId: bigint) {
        await this.requireGroup(groupId);

        const actorMembership = await this.requireRole(groupId, actorId, MANAGE_ROLES);
        const targetMembership = await this.getMembership(groupId, targetUserId);
        if (!targetMembership) throw new GroupFlowError(GroupError.MEMBER_NOT_FOUND);

        if (targetMembership.role === "OWNER") {
            throw new ForbiddenException("Không thể xóa Trưởng nhóm.");
        }
        if (targetMembership.role === "ADMIN" && actorMembership.role !== "OWNER") {
            throw new ForbiddenException("Chỉ Trưởng nhóm mới có thể xóa Quản trị viên.");
        }

        await this.prisma.group_members.delete({
            where: {
                group_id_user_id: { group_id: groupId, user_id: targetUserId },
            },
        });

        return { success: true, message: "Đã xóa thành viên khỏi nhóm." };
    }
}
