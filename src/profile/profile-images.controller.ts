import { Controller, Param, Patch, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import type { UploadedMedia } from "../posts/posts.types.js";
import { ProfileImagesService } from "./profile-images.service.js";

@Controller("api/profile/images")
@UseGuards(AuthGuard)
export class ProfileImagesController {
    constructor(private readonly images: ProfileImagesService) {}
    @Patch(":kind")
    @UseInterceptors(FileInterceptor("image", { limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 0, parts: 2 } }))
    upload(@Req() request: AuthenticatedRequest, @Param("kind") kind: string, @UploadedFile() image: UploadedMedia | undefined) {
        return this.images.upload(request.userId!, kind, image);
    }
}
