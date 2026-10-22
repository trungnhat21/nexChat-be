export interface UploadedMedia {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}
export interface PostMutation {
    content: string;
    privacy: "public" | "friends" | "private";
    keepMediaIds: bigint[];
}
export interface StoredMedia {
    key: string;
    name: string;
    type: string;
    size: number;
}
export const POST_LIMITS = {
    contentLength: 5000,
    files: 5,
    fileBytes: 25 * 1024 * 1024,
    totalBytes: 50 * 1024 * 1024,
} as const;
