import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { PostsService } from "./posts.service.js";
import { POST_LIMITS, type UploadedMedia } from "./posts.types.js";
import { parseId, parseMutation } from "./posts.validation.js";

const mediaInterceptor = FilesInterceptor("media", POST_LIMITS.files, {
    limits: { files: POST_LIMITS.files, fileSize: POST_LIMITS.fileBytes, fields: 3, fieldSize: 24 * 1024, parts: 9 },
});

@Controller("api/posts")
@UseGuards(AuthGuard)
export class PostsController {
    constructor(private readonly posts: PostsService) {}
    @Get()
    list(@Req() request: AuthenticatedRequest, @Query("cursor") cursor: unknown, @Query("search") search: unknown, @Query("authorId") authorId: unknown) {
        if (search !== undefined && (typeof search !== "string" || search.length > 200)) throw new BadRequestException("Tìm kiếm tối đa 200 ký tự.");
        return this.posts.list(request.userId!, cursor === undefined ? undefined : parseId(cursor), typeof search === "string" ? search.trim() : "", authorId === undefined ? undefined : parseId(authorId));
    }
    @Post()
    @UseInterceptors(mediaInterceptor)
    create(@Req() request: AuthenticatedRequest, @Body() body: unknown, @UploadedFiles() files: UploadedMedia[] = []) {
        return this.posts.create(request.userId!, parseMutation(body), files);
    }
    @Patch(":id")
    @UseInterceptors(mediaInterceptor)
    update(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown, @UploadedFiles() files: UploadedMedia[] = []) {
        return this.posts.update(request.userId!, parseId(id), parseMutation(body, true), files);
    }
    @Delete(":id")
    remove(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.posts.remove(request.userId!, parseId(id));
    }
}
