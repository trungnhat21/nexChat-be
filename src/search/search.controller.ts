import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { AuthGuard } from "../auth/auth.guard.js";
import {
    parseSearchCategory,
    parseSearchCursor,
    parseSearchLimit,
    parseSearchMediaOnly,
    parseSearchPeriod,
    parseSearchQuery,
    parseSearchSort,
} from "./search.validation.js";
import { SearchService } from "./search.service.js";

@Controller("api/search")
@UseGuards(AuthGuard)
export class SearchController {
    constructor(private readonly searchService: SearchService) {}

    @Get()
    search(
        @Req() request: AuthenticatedRequest,
        @Query("query") query: unknown,
        @Query("category") category: unknown,
        @Query("cursor") cursor: unknown,
        @Query("limit") limit: unknown,
        @Query("sort") sort: unknown,
        @Query("period") period: unknown,
        @Query("mediaOnly") mediaOnly: unknown,
    ) {
        return this.searchService.search(
            request.userId!,
            parseSearchQuery(query),
            parseSearchCategory(category),
            parseSearchCursor(cursor),
            parseSearchLimit(limit, 5),
            {
                sort: parseSearchSort(sort),
                period: parseSearchPeriod(period),
                mediaOnly: parseSearchMediaOnly(mediaOnly),
            },
        );
    }
}
