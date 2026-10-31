import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { PostsService } from "./posts.service.js";
import { POST_LIMITS, type UploadedMedia, type GetPostsDto } from "./posts.types.js";
import { parseId, parseMutation, parseComment, parseRepost, parsePostSort, parsePostPeriod, parsePostMediaOnly } from "./posts.validation.js";

const mediaInterceptor = FilesInterceptor("media", POST_LIMITS.files, {
    limits: { files: POST_LIMITS.files, fileSize: POST_LIMITS.fileBytes, fields: 3, fieldSize: 24 * 1024, parts: 9 },
});

@Controller("api/posts")
@UseGuards(AuthGuard)
export class PostsController {
    constructor(private readonly posts: PostsService) {}
    @Get()
    list(
        @Req() request: AuthenticatedRequest,
        @Query("cursor") cursor: unknown,
        @Query("search") search: unknown,
        @Query("authorId") authorId: unknown,
        @Query("sort") sort: unknown,
        @Query("period") period: unknown,
        @Query("mediaOnly") mediaOnly: unknown,
    ) {
        if (search !== undefined && (typeof search !== "string" || search.length > 200)) throw new BadRequestException("Tìm kiếm tối đa 200 ký tự.");
        const searchQuery = typeof search === "string" ? search.trim() : "";
        const dto: GetPostsDto = {
            ...(cursor === undefined ? {} : { cursor: parseId(cursor) }),
            search: searchQuery,
            ...(authorId === undefined ? {} : { authorId: parseId(authorId) }),
            sort: parsePostSort(sort, Boolean(searchQuery)),
            period: parsePostPeriod(period),
            mediaOnly: parsePostMediaOnly(mediaOnly),
        };
        return this.posts.list(request.userId!, dto);
    }
    @Get("saved")
    saved(
        @Req() request: AuthenticatedRequest,
        @Query("cursor") cursor: unknown,
        @Query("search") search: unknown,
        @Query("sort") sort: unknown,
        @Query("period") period: unknown,
        @Query("mediaOnly") mediaOnly: unknown,
    ) {
        if (search !== undefined && (typeof search !== "string" || search.length > 200)) throw new BadRequestException("Tìm kiếm tối đa 200 ký tự.");
        const searchQuery = typeof search === "string" ? search.trim() : "";
        const dto: GetPostsDto = {
            ...(cursor === undefined ? {} : { cursor: parseId(cursor) }),
            search: searchQuery,
            sort: parsePostSort(sort, Boolean(searchQuery)),
            period: parsePostPeriod(period),
            mediaOnly: parsePostMediaOnly(mediaOnly),
            savedOnly: true,
        };
        return this.posts.list(request.userId!, dto);
    }
    @Get(":id")
    get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.posts.get(request.userId!, parseId(id)); }
    @Get(":id/comments")
    comments(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query("cursor") cursor: unknown) {
        return this.posts.listComments(request.userId!, parseId(id), cursor === undefined ? undefined : parseId(cursor));
    }
    @Post(":id/comments")
    comment(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
        const comment = parseComment(body);
        return this.posts.mutateComment(request.userId!, parseId(id), comment.content, undefined, comment.parentCommentId);
    }
    @Patch(":id/comments/:commentId")
    editComment(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("commentId") commentId: string, @Body() body: unknown) {
        return this.posts.mutateComment(request.userId!, parseId(id), parseComment(body).content, parseId(commentId));
    }
    @Delete(":id/comments/:commentId")
    deleteComment(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Param("commentId") commentId: string) {
        return this.posts.mutateComment(request.userId!, parseId(id), null, parseId(commentId));
    }
    @Put(":id/save")
    save(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.posts.setSaved(request.userId!, parseId(id), true); }
    @Delete(":id/save")
    unsave(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.posts.setSaved(request.userId!, parseId(id), false); }
    @Post(":id/repost")
    repost(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.posts.repost(request.userId!, parseId(id), parseRepost(body)); }
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
    @Put(":id/like")
    like(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.posts.setLike(request.userId!, parseId(id), true);
    }
    @Delete(":id/like")
    unlike(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.posts.setLike(request.userId!, parseId(id), false);
    }
    @Delete(":id")
    remove(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.posts.remove(request.userId!, parseId(id));
    }
}
