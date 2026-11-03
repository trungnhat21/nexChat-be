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
import { GroupsService } from "./groups.service.js";
import { GroupFlowError, GroupError } from "./groups.types.js";
import { parseCreateGroupDto } from "./dto/create-group.dto.js";
import { parseUpdateGroupDto } from "./dto/update-group.dto.js";
import { parseUpdateMemberDto } from "./dto/join-group.dto.js";
import { ForbiddenException, NotFoundException } from "@nestjs/common";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseId(value: string): bigint | null {
    if (!/^[1-9]\d{0,19}$/.test(value)) return null;
    const id = BigInt(value);
    return id <= 18446744073709551615n ? id : null;
}

function parsePage(raw: unknown, defaultVal = 1): number {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : defaultVal;
}

function parseLimit(raw: unknown, max = 50, defaultVal = 20): number {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : defaultVal;
}

/** Map well-known error codes/types → HTTP response. */
function handleGroupError(error: unknown, response: Response): Response {
    if (error instanceof NotFoundException) {
        return response
            .status(404)
            .json({ success: false, message: error.message });
    }
    if (error instanceof ForbiddenException) {
        return response
            .status(403)
            .json({ success: false, message: error.message });
    }
    if (error instanceof GroupFlowError) {
        const statusMap: Record<string, number> = {
            [GroupError.GROUP_NOT_FOUND]: 404,
            [GroupError.ALREADY_MEMBER]: 409,
            [GroupError.NOT_A_MEMBER]: 404,
            [GroupError.MEMBER_NOT_FOUND]: 404,
            [GroupError.OWNER_CANNOT_LEAVE]: 403,
            [GroupError.FORBIDDEN]: 403,
            [GroupError.MEMBER_BANNED]: 403,
        };
        const messageMap: Record<string, string> = {
            [GroupError.GROUP_NOT_FOUND]: "Không tìm thấy nhóm.",
            [GroupError.ALREADY_MEMBER]: "Bạn đã là thành viên hoặc đã gửi yêu cầu.",
            [GroupError.NOT_A_MEMBER]: "Bạn không phải thành viên nhóm này.",
            [GroupError.MEMBER_NOT_FOUND]: "Không tìm thấy thành viên.",
            [GroupError.OWNER_CANNOT_LEAVE]: "OWNER không thể rời nhóm khi chưa chuyển giao quyền sở hữu.",
            [GroupError.FORBIDDEN]: "Bạn không có quyền thực hiện thao tác này.",
            [GroupError.MEMBER_BANNED]: "Thành viên đã bị cấm.",
        };
        return response
            .status(statusMap[error.code] ?? 400)
            .json({ success: false, message: messageMap[error.code] ?? error.code });
    }
    if (error instanceof Error) {
        const parseErrors: Record<string, { status: number; message: string }> = {
            INVALID_BODY: { status: 400, message: "Dữ liệu không hợp lệ." },
            INVALID_NAME: { status: 400, message: "Tên nhóm không hợp lệ (1–255 ký tự)." },
            INVALID_ROLE: { status: 400, message: "Vai trò không hợp lệ." },
            INVALID_STATUS: { status: 400, message: "Trạng thái không hợp lệ." },
        };
        const mapped = parseErrors[error.message];
        if (mapped) {
            return response.status(mapped.status).json({ success: false, message: mapped.message });
        }
    }
    console.error("[GroupsController] Unhandled error:", error);
    return response.status(500).json({ success: false, message: "Lỗi máy chủ nội bộ." });
}

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller("api/groups")
@UseGuards(AuthGuard)
export class GroupsController {
    constructor(private readonly groupsService: GroupsService) {}

    // POST /api/groups — Tạo nhóm mới
    @Post()
    async create(
        @Req() req: AuthenticatedRequest,
        @Body() body: unknown,
        @Res() res: Response,
    ): Promise<Response> {
        try {
            const dto = parseCreateGroupDto(body);
            const result = await this.groupsService.createGroup(req.userId!, dto);
            return res.status(201).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // GET /api/groups — Danh sách nhóm (joined + suggested)
    @Get()
    async list(
        @Req() req: AuthenticatedRequest,
        @Res() res: Response,
    ): Promise<Response> {
        try {
            const result = await this.groupsService.listGroups(req.userId!);
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    
    // GET /api/groups/top — Top nhóm có số lượng thành viên nhiều nhất
    @Get("top")
    async getTop(
        @Query("limit") rawLimit: unknown,
        @Res() res: Response,
    ): Promise<Response> {
        try {
            const limit = parseLimit(rawLimit, 10, 3);
            const result = await this.groupsService.getTopGroups(limit);
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // GET /api/groups/:id — Chi tiết nhóm
    @Get(":id")
    async findOne(
        @Req() req: AuthenticatedRequest,
        @Param("id") rawId: string,
        @Res() res: Response,
    ): Promise<Response> {
        const groupId = parseId(rawId);
        if (!groupId) {
            return res.status(400).json({ success: false, message: "ID nhóm không hợp lệ." });
        }
        try {
            const result = await this.groupsService.getGroup(req.userId!, groupId);
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // PATCH /api/groups/:id — Cập nhật thông tin nhóm (OWNER / ADMIN only)
    @Patch(":id")
    async update(
        @Req() req: AuthenticatedRequest,
        @Param("id") rawId: string,
        @Body() body: unknown,
        @Res() res: Response,
    ): Promise<Response> {
        const groupId = parseId(rawId);
        if (!groupId) {
            return res.status(400).json({ success: false, message: "ID nhóm không hợp lệ." });
        }
        try {
            const dto = parseUpdateGroupDto(body);
            const result = await this.groupsService.updateGroup(req.userId!, groupId, dto);
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // POST /api/groups/:id/join — Tham gia nhóm
    @Post(":id/join")
    async join(
        @Req() req: AuthenticatedRequest,
        @Param("id") rawId: string,
        @Res() res: Response,
    ): Promise<Response> {
        const groupId = parseId(rawId);
        if (!groupId) {
            return res.status(400).json({ success: false, message: "ID nhóm không hợp lệ." });
        }
        try {
            const result = await this.groupsService.joinGroup(req.userId!, groupId);
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // POST /api/groups/:id/leave — Rời nhóm
    @Post(":id/leave")
    async leave(
        @Req() req: AuthenticatedRequest,
        @Param("id") rawId: string,
        @Res() res: Response,
    ): Promise<Response> {
        const groupId = parseId(rawId);
        if (!groupId) {
            return res.status(400).json({ success: false, message: "ID nhóm không hợp lệ." });
        }
        try {
            const result = await this.groupsService.leaveGroup(req.userId!, groupId);
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // GET /api/groups/:id/members — Danh sách thành viên (có phân trang + filter)
    @Get(":id/members")
    async listMembers(
        @Req() req: AuthenticatedRequest,
        @Param("id") rawId: string,
        @Query("page") rawPage: unknown,
        @Query("limit") rawLimit: unknown,
        @Query("role") role: unknown,
        @Query("status") status: unknown,
        @Res() res: Response,
    ): Promise<Response> {
        const groupId = parseId(rawId);
        if (!groupId) {
            return res.status(400).json({ success: false, message: "ID nhóm không hợp lệ." });
        }
        const page = parsePage(rawPage);
        const limit = parseLimit(rawLimit);
        const roleFilter = typeof role === "string" && role ? role : undefined;
        const statusFilter = typeof status === "string" && status ? status : undefined;

        try {
            const result = await this.groupsService.listMembers(
                req.userId!,
                groupId,
                {
                    page,
                    limit,
                    ...(roleFilter !== undefined && { role: roleFilter }),
                    ...(statusFilter !== undefined && { status: statusFilter }),
                },
            );
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // PATCH /api/groups/:id/members/:userId — Duyệt thành viên / đổi role
    @Patch(":id/members/:userId")
    async updateMember(
        @Req() req: AuthenticatedRequest,
        @Param("id") rawGroupId: string,
        @Param("userId") rawUserId: string,
        @Body() body: unknown,
        @Res() res: Response,
    ): Promise<Response> {
        const groupId = parseId(rawGroupId);
        const targetUserId = parseId(rawUserId);

        if (!groupId || !targetUserId) {
            return res.status(400).json({ success: false, message: "ID không hợp lệ." });
        }
        try {
            const dto = parseUpdateMemberDto(body);
            const result = await this.groupsService.updateMember(
                req.userId!,
                groupId,
                targetUserId,
                dto,
            );
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }

    // DELETE /api/groups/:id/members/:userId — Xóa thành viên / Từ chối duyệt
    @Delete(":id/members/:userId")
    async removeMember(
        @Req() req: AuthenticatedRequest,
        @Param("id") rawGroupId: string,
        @Param("userId") rawUserId: string,
        @Res() res: Response,
    ): Promise<Response> {
        const groupId = parseId(rawGroupId);
        const targetUserId = parseId(rawUserId);

        if (!groupId || !targetUserId) {
            return res.status(400).json({ success: false, message: "ID không hợp lệ." });
        }
        try {
            const result = await this.groupsService.removeMember(
                req.userId!,
                groupId,
                targetUserId,
            );
            return res.status(200).json(result);
        } catch (error) {
            return handleGroupError(error, res);
        }
    }
}
