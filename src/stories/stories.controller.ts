import { Body, Controller, Delete, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import type { UploadedMedia } from "../posts/posts.types.js";
import { STORY_FILE_BYTES, parseStoryId, parseStoryInput, parseStoryReaction, validateStoryMedia } from "./stories.validation.js";
import { StoriesService } from "./stories.service.js";

@Controller("api/stories")
@UseGuards(AuthGuard)
export class StoriesController {
    constructor(private readonly stories: StoriesService) {}

    @Get()
    list(@Req() request: AuthenticatedRequest, @Query("cursor") cursor: unknown) {
        return this.stories.list(request.userId!, cursor === undefined ? undefined : parseStoryId(cursor));
    }

    @Post()
    @UseInterceptors(FileInterceptor("media", { limits: { fileSize: STORY_FILE_BYTES, files: 1, fields: 2, fieldSize: 2000 } }))
    publish(@Req() request: AuthenticatedRequest, @Body() body: unknown, @UploadedFile() file?: UploadedMedia) {
        const input = parseStoryInput(body);
        validateStoryMedia(file);
        return this.stories.publish(request.userId!, file, input.caption, input.visibility);
    }

    @Post(":id/view")
    view(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.stories.view(request.userId!, parseStoryId(id));
    }

    @Post(":id/reaction")
    react(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
        return this.stories.react(request.userId!, parseStoryId(id), parseStoryReaction(body));
    }

    @Delete(":id/reaction")
    unreact(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.stories.react(request.userId!, parseStoryId(id), null);
    }

    @Get(":id/viewers")
    viewers(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.stories.viewers(request.userId!, parseStoryId(id));
    }

    @Delete(":id")
    remove(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
        return this.stories.remove(request.userId!, parseStoryId(id));
    }
}
