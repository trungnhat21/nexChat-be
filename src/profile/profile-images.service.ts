import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { UsersService } from "../users/users.service.js";
import { PostStorageService } from "../posts/post-storage.service.js";
import { validateMedia } from "../posts/posts.validation.js";
import type { UploadedMedia } from "../posts/posts.types.js";

@Injectable()
export class ProfileImagesService {
    constructor(private readonly prisma: PrismaService, private readonly storage: PostStorageService, private readonly users: UsersService) {}

    async upload(userId: bigint, kind: string, file: UploadedMedia | undefined) {
        if (kind !== "avatar" && kind !== "cover") throw new BadRequestException("Loại ảnh không hợp lệ.");
        if (!file || !file.mimetype.startsWith("image/") || file.size > 10 * 1024 * 1024) throw new BadRequestException("Chọn ảnh JPEG, PNG, GIF hoặc WebP có dung lượng tối đa 10 MB.");
        validateMedia([file]);
        const existing = await this.prisma.users.findFirst({ where: { id: userId, deleted: "NO" }, select: { id: true } });
        if (!existing) throw new NotFoundException("Tài khoản không tồn tại.");
        const uploaded = await this.storage.upload(userId, file, "profiles");
        let result;
        try {
            result = await this.prisma.$transaction(async tx => {
                const locked = await tx.users.updateMany({ where: { id: userId, deleted: "NO" }, data: { updated_at: new Date() } });
                if (!locked.count) throw new NotFoundException("Tài khoản không tồn tại.");
                const user = await tx.users.findUniqueOrThrow({ where: { id: userId } });
                const profile = await tx.profiles.findUnique({ where: { user_id: userId } });
                const previous = kind === "avatar" ? profile?.avatar_url || user.avatar : profile?.cover_url;
                const field = kind === "avatar" ? { avatar_url: uploaded.key } : { cover_url: uploaded.key };
                await tx.profiles.upsert({
                    where: { user_id: userId },
                    create: { user_id: userId, display_name: [user.last_name, user.first_name].filter(Boolean).join(" ").slice(0,100) || user.user_name || "Người dùng", ...field },
                    update: { ...field, updated_at: new Date() },
                });
                const updatedUser = kind === "avatar" ? await tx.users.update({ where: { id: userId }, data: { avatar: uploaded.key } }) : user;
                return { previous, updatedUser };
            }, { timeout: 15000 });
        } catch (error) { await this.storage.remove([uploaded.key]); throw error; }
        if (kind === "avatar") await this.users.syncProfileImage(result.updatedUser);
        if (result.previous && result.previous !== uploaded.key) await this.storage.remove([result.previous]);
        return { success: true, kind, url: await this.storage.url(uploaded.key, uploaded.type) };
    }
}
