import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { safeFilename } from "./posts.validation.js";
import type { StoredMedia, UploadedMedia } from "./posts.types.js";

@Injectable()
export class PostStorageService {
    private client: S3Client | undefined;
    private readonly logger = new Logger(PostStorageService.name);
    onModuleDestroy(): void { this.client?.destroy(); }
    private settings() {
        const endpoint = process.env.S3_ENDPOINT;
        const bucket = process.env.S3_BUCKET;
        const accessKeyId = process.env.S3_ACCESS_KEY_ID;
        const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new ServiceUnavailableException("Chưa cấu hình kho media.");
        return { endpoint, bucket, credentials: { accessKeyId, secretAccessKey }, region: process.env.S3_REGION || "us-east-1" };
    }
    private getClient(): S3Client {
        const { endpoint, credentials, region } = this.settings();
        return this.client ??= new S3Client({ endpoint, credentials, region, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
    }
    async upload(userId: bigint, file: UploadedMedia, folder: "posts" | "profiles" | "stories" = "posts"): Promise<StoredMedia> {
        const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };
        const key = `${folder}/${userId}/${randomUUID()}.${extensions[file.mimetype]}`;
        try {
            await this.getClient().send(new PutObjectCommand({
                Bucket: this.settings().bucket, Key: key, Body: file.buffer,
                ContentType: file.mimetype, ContentLength: file.size,
            }));
            return { key, type: file.mimetype, name: safeFilename(file.originalname), size: file.size };
        } catch (error) {
            this.logger.warn(`Media upload failed (${error instanceof Error ? error.name : "unknown"}).`);
            await this.remove([key]);
            throw new ServiceUnavailableException("Không thể tải media lên MinIO. Vui lòng thử lại.");
        }
    }
    async url(key: string, type: string | null, expiresInSeconds = 3600): Promise<string> {
        const storyKey = /^stories\/[1-9]\d*\/[a-f0-9-]+\.(jpg|png|gif|webp|mp4|webm)$/.test(key);
        if (!storyKey && !key.startsWith("posts/") && !key.startsWith("profiles/")) throw new ServiceUnavailableException("Đường dẫn media chưa được hỗ trợ.");
        return getSignedUrl(this.getClient(), new GetObjectCommand({
            Bucket: this.settings().bucket, Key: key,
            ResponseContentType: type || ({ jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" } as Record<string, string>)[key.split(".").at(-1) ?? ""] || "application/octet-stream", ResponseContentDisposition: "inline",
        }), { expiresIn: Math.min(3600, Math.max(1, expiresInSeconds)) });
    }
    async remove(keys: string[], throwOnError = false): Promise<void> {
        await Promise.all(keys.map(async key => {
            if (!/^(posts|profiles|stories)\/[1-9]\d*\/[a-f0-9-]+\.(jpg|png|gif|webp|mp4|webm)$/.test(key)) return;
            try { await this.getClient().send(new DeleteObjectCommand({ Bucket: this.settings().bucket, Key: key })); }
            catch (error) { this.logger.error(`Media cleanup pending: ${key} (${error instanceof Error ? error.name : "unknown"}).`); if (throwOnError) throw new ServiceUnavailableException("Could not remove media object; cleanup will be retried."); }
        }));
    }
}
