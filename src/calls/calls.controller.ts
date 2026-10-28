import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { CallsService } from "./calls.service.js";
import { parseCallHistoryQuery, parseCallId, parseCallStart } from "./calls.validation.js";

@Controller("api/calls")
@UseGuards(AuthGuard)
export class CallsController {
    constructor(private readonly calls: CallsService) {}

    @Post()
    start(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
        return this.calls.start(request.userId!, parseCallStart(body));
    }

    @Post(":id/accept")
    accept(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.calls.accept(request.userId!, parseCallId(id));
    }

    @Post(":id/decline")
    decline(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.calls.decline(request.userId!, parseCallId(id));
    }

    @Post(":id/cancel")
    cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.calls.cancel(request.userId!, parseCallId(id));
    }

    @Post(":id/end")
    end(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.calls.end(request.userId!, parseCallId(id));
    }

    @Get("history")
    history(@Req() request: AuthenticatedRequest, @Query("cursor") cursor: unknown, @Query("limit") limit: unknown) {
        return this.calls.history(request.userId!, parseCallHistoryQuery(cursor, limit));
    }

    @Get("active")
    active(@Req() request: AuthenticatedRequest) {
        return this.calls.active(request.userId!);
    }
}
