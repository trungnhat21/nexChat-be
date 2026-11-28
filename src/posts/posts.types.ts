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
    postType?: "post" | "video";
    groupId?: bigint;
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

export interface PostView {
    id: string; content: string; postType?: "post" | "video"; privacy: "public" | "friends" | "private"; createdAt: string; updatedAt: string;
    canEdit: boolean; author: { id: string; name: string; handle: string | null; avatar: string | null };
    liked: boolean; likes: number; saved: boolean; comments: number;
    media: { id: string; url: string; type: string; name: string; size: number }[];
    isRepost: boolean; original: PostView | null;
    groupId?: string | null;
    approvalStatus?: "PUBLISHED" | "PENDING_APPROVAL" | "REJECTED";
}

export interface ApprovePostDto {
    action: "approve" | "reject";
}

export type PostSort = "relevance" | "latest";
export type PostPeriod = "all" | "24h" | "week" | "month";

export interface GetPostsDto {
    cursor?: bigint | undefined;
    randomize?: boolean | undefined;
    feedSession?: FeedRandomizationSession | undefined;
    randomCursor?: FeedRandomizationCursor | undefined;
    search?: string | undefined;
    authorId?: bigint | undefined;
    savedOnly?: boolean | undefined;
    sort?: PostSort | undefined;
    period?: PostPeriod | undefined;
    mediaOnly?: boolean | undefined;
    postType?: "post" | "video" | undefined;
}

export interface FeedRandomizationSession {
    version: 1;
    seed: string;
    snapshotId: string;
}

export interface FeedRandomizationCursor {
    version: 1;
    seed: string;
    segment: number;
    lastId: string;
}
