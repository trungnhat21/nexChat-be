import { BadRequestException } from "@nestjs/common";
import type { UploadedMedia } from "../posts/posts.types.js";
import { validateMedia } from "../posts/posts.validation.js";

export const STORY_FILE_BYTES = 25 * 1024 * 1024;
export const STORY_VISIBILITIES = ["public", "friends", "followers", "private"] as const;
export type StoryVisibility = typeof STORY_VISIBILITIES[number];
export const STORY_REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "😡"] as const;
export type StoryReaction = typeof STORY_REACTIONS[number];

export function parseStoryId(value: unknown): bigint {
    if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new BadRequestException("Story ID is invalid.");
    const id = BigInt(value);
    if (id > 18446744073709551615n) throw new BadRequestException("Story ID is invalid.");
    return id;
}

export function parseStoryInput(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("Story data is invalid.");
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !["caption", "visibility"].includes(key))) throw new BadRequestException("Unexpected story fields.");
    const caption = body.caption === undefined ? "" : body.caption;
    const visibility = body.visibility === undefined ? "friends" : body.visibility;
    if (typeof caption !== "string" || caption.length > 500) throw new BadRequestException("Caption must be at most 500 characters.");
    if (typeof visibility !== "string" || !STORY_VISIBILITIES.includes(visibility as StoryVisibility)) throw new BadRequestException("Story visibility is invalid.");
    return { caption: caption.trim(), visibility: visibility as StoryVisibility };
}

export function validateStoryMedia(file: UploadedMedia | undefined): asserts file is UploadedMedia {
    if (!file) throw new BadRequestException("Choose an image or video for your story.");
    if (file.size > STORY_FILE_BYTES) throw new BadRequestException("A story file must be 25 MB or smaller.");
    validateMedia([file]);
}

export function parseStoryReaction(raw: unknown): StoryReaction {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("Story reaction is invalid.");
    const reaction = (raw as Record<string, unknown>).reaction;
    if (typeof reaction !== "string" || !STORY_REACTIONS.includes(reaction as StoryReaction)) throw new BadRequestException("Choose a supported story reaction.");
    return reaction as StoryReaction;
}
