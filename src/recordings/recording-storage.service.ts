import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

@Injectable()
export class RecordingStorageService implements OnModuleDestroy {
    private client: S3Client | undefined;
    private readonly logger = new Logger(RecordingStorageService.name);

    onModuleDestroy(): void { this.client?.destroy(); }

    private settings() {
        const endpoint = process.env.RECORDING_S3_ENDPOINT?.trim();
        const bucket = process.env.RECORDING_S3_BUCKET?.trim();
        const accessKeyId = process.env.RECORDING_S3_ACCESS_KEY_ID?.trim();
        const secretAccessKey = process.env.RECORDING_S3_SECRET_ACCESS_KEY?.trim();
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new ServiceUnavailableException("Recording download storage is not configured.");
        let parsed: URL;
        try { parsed = new URL(endpoint); } catch { throw new ServiceUnavailableException("Recording download storage endpoint is invalid."); }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ServiceUnavailableException("Recording download storage endpoint must use HTTP or HTTPS.");
        return { endpoint, bucket, credentials: { accessKeyId, secretAccessKey }, region: process.env.RECORDING_S3_REGION?.trim() || "us-east-1" };
    }

    private getClient(): S3Client {
        const { endpoint, credentials, region } = this.settings();
        return this.client ??= new S3Client({ endpoint, credentials, region, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
    }

    async playbackUrl(objectKey: string, contentType: string, expiresInSeconds = 300): Promise<string> {
        this.assertKey(objectKey);
        const { bucket } = this.settings();
        return getSignedUrl(this.getClient(), new GetObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            ResponseContentType: contentType,
            ResponseContentDisposition: "inline",
        }), { expiresIn: Math.min(300, Math.max(1, expiresInSeconds)) });
    }

    async remove(objectKey: string): Promise<void> {
        this.assertKey(objectKey);
        const { bucket } = this.settings();
        try {
            await this.getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
        } catch (error) {
            this.logger.warn(`Recording object deletion failed (${error instanceof Error ? error.name : "unknown"}).`);
            throw new ServiceUnavailableException("Recording media deletion failed; it will be retried.");
        }
    }

    private assertKey(key: string) {
        if (!/^recordings\/[1-9]\d*\/[0-9a-f-]{36}\.mp4$/i.test(key)) throw new ServiceUnavailableException("Recording object key is invalid.");
    }
}
