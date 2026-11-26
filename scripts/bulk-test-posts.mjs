#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const maxPostsPerRun = 50;
const mediaLimitBytes = 25 * 1024 * 1024;
const videoSampleUrl = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const imageAssets = [
    resolve(scriptDir, "../../nex-chat-fe/src/_metronic/assets/images/home/post-design-system.png"),
    resolve(scriptDir, "../../nex-chat-fe/src/_metronic/assets/images/profile/highlight-tech.png"),
    resolve(scriptDir, "../../nex-chat-fe/src/_metronic/assets/images/profile/highlight-ai.png"),
    resolve(scriptDir, "../../nex-chat-fe/src/_metronic/assets/images/profile/highlight-travel.png"),
];

const captions = {
    image: [
        "Một góc nhỏ trong ngày làm việc hôm nay. Lưu lại để cuối tuần xem lại nhé!",
        "Đang thử một ý tưởng mới cho dự án cá nhân. Mọi người thấy cách phối màu này ổn không?",
        "Cuối tuần dành chút thời gian học thêm điều mới, cảm giác có động lực hẳn.",
        "Ghi lại khoảnh khắc này trước khi bắt đầu một tuần bận rộn hơn.",
        "Một chút cảm hứng hôm nay: làm chậm lại, quan sát kỹ hơn và tiếp tục hoàn thiện.",
    ],
    video: [
        "Thử nghiệm video trong bài viết NexChat — một khoảnh khắc ngắn để kiểm tra phát media.",
        "Video thử nghiệm hôm nay. Mình đang kiểm tra tải và phát video trên bảng tin.",
        "Một đoạn video ngắn cho bài đăng thử nghiệm, xem trên điện thoại có ổn không nhỉ?",
    ],
    text: [
        "Bài viết thử nghiệm NexChat: hôm nay mình vừa hoàn thành một việc nhỏ trong danh sách cần làm.",
        "Một ghi chú ngắn để kiểm tra nội dung văn bản trên bảng tin. Chúc mọi người một ngày tốt lành!",
        "Đang kiểm tra bài viết chỉ có văn bản, không đính kèm hình ảnh hay video.",
    ],
};

export function parseArgs(argv) {
    const options = { images: 0, videos: 0, text: 0, runId: "default", privacy: "private", cleanup: false, dryRun: false, allowLocalApi: false, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") options.help = true;
        else if (arg === "--cleanup") options.cleanup = true;
        else if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--allow-local-api") options.allowLocalApi = true;
        else if (["--images", "--videos", "--text", "--run-id", "--privacy"].includes(arg)) {
            const value = argv[++i];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
            if (arg === "--images") options.images = parseCount(value, arg);
            else if (arg === "--videos") options.videos = parseCount(value, arg);
            else if (arg === "--text") options.text = parseCount(value, arg);
            else if (arg === "--run-id") options.runId = value;
            else options.privacy = value;
        } else throw new Error(`Unknown option: ${arg}`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/i.test(options.runId)) throw new Error("--run-id must be 1-40 letters, numbers, or hyphens.");
    if (!["private", "friends", "public"].includes(options.privacy)) throw new Error("--privacy must be private, friends, or public.");
    if (options.cleanup && (options.images || options.videos || options.text)) throw new Error("Use --cleanup separately from generation options.");
    if (!options.cleanup && !options.help && options.images + options.videos + options.text > maxPostsPerRun) throw new Error(`At most ${maxPostsPerRun} posts may be generated per run.`);
    if (!options.cleanup && !options.help && !options.dryRun && options.images + options.videos + options.text === 0) throw new Error("Set at least one of --images, --videos, or --text.");
    return options;
}

function parseCount(value, name) {
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count > maxPostsPerRun) throw new Error(`${name} must be between 0 and ${maxPostsPerRun}.`);
    return count;
}

export function validateTarget(raw, { allowLocalApi = false } = {}) {
    if (!raw) throw new Error("Set NEXCHAT_STAGING_API_URL to the staging API origin. The script does not load .env or select a target automatically.");
    let url;
    try { url = new URL(raw); } catch { throw new Error("NEXCHAT_STAGING_API_URL must be a valid URL."); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("API URL must be an http(s) origin without credentials, query, or fragment.");
    const host = url.hostname.toLowerCase();
    if (/prod|production/.test(host)) throw new Error("Production-like API hosts are blocked.");
    const local = ["localhost", "127.0.0.1", "::1"].includes(host);
    if (local && !allowLocalApi) throw new Error("Local API use requires the explicit --allow-local-api option.");
    if (!local && !host.includes("staging")) throw new Error("Target host must contain 'staging'; production or unknown hosts are blocked.");
    return url.origin;
}

function markerFor(runId, kind, index) { return `[NEXCHAT_TEST:${runId}:${kind}:${String(index).padStart(2, "0")}]`; }
function helpText() {
    return `NexChat bulk test posts (uses the authenticated Posts API; never writes directly to the database)\n\n` +
        `PowerShell setup:\n` +
        `  $env:NEXCHAT_STAGING_API_URL = "https://<your-staging-api-host>"\n` +
        `  $env:NEXCHAT_TEST_EMAIL = "<staging-test-account-email>"\n` +
        `  $env:NEXCHAT_TEST_PASSWORD = "<staging-test-account-password>"\n` +
        `  $env:NEXCHAT_EXPECTED_USER_ID = "<staging-test-account-id>"\n\n` +
        `Generate: node scripts/bulk-test-posts.mjs --images 20 --videos 10 --text 5\n` +
        `Dry run:  node scripts/bulk-test-posts.mjs --images 20 --videos 10 --text 5 --dry-run\n` +
        `Cleanup:  node scripts/bulk-test-posts.mjs --cleanup --run-id default\n\n` +
        `Optional: --run-id demo-2 --privacy private|friends|public. The default privacy is private.\n` +
        `Cleanup requires typing an exact confirmation phrase. Staging URL and user ID are mandatory.\n` +
        `Local API is blocked unless --allow-local-api is supplied; unknown/production hosts are blocked.\n` +
        `Video sample is fetched from MDN's CC0 sample on first use and cached in the OS temp directory.\n`;
}

function apiUrl(apiOrigin, path) { return new URL(path, apiOrigin); }
function errorMessage(payload, fallback) {
    const message = payload && typeof payload === "object" ? payload.message : null;
    return Array.isArray(message) ? message.join("; ") : typeof message === "string" ? message : fallback;
}

async function apiRequest(origin, token, route, init = {}) {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(apiUrl(origin, route), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(120_000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(`API ${response.status}: ${errorMessage(payload, response.statusText)}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}

async function authenticate(origin) {
    let token = process.env.NEXCHAT_TEST_ACCESS_TOKEN?.trim();
    if (!token) {
        const email = process.env.NEXCHAT_TEST_EMAIL?.trim();
        const password = process.env.NEXCHAT_TEST_PASSWORD;
        if (!email || !password) throw new Error("Set NEXCHAT_TEST_ACCESS_TOKEN or NEXCHAT_TEST_EMAIL and NEXCHAT_TEST_PASSWORD.");
        const result = await apiRequest(origin, null, "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
        if (result?.challengeToken) throw new Error("The selected test account requires 2FA; use a short-lived NEXCHAT_TEST_ACCESS_TOKEN from that account.");
        token = result?.accessToken;
    }
    if (typeof token !== "string" || !token) throw new Error("Authentication did not return an access token.");
    const session = await apiRequest(origin, token, "/api/auth/me");
    const user = session?.currentUser;
    const expectedId = process.env.NEXCHAT_EXPECTED_USER_ID?.trim();
    if (!expectedId) throw new Error("Set NEXCHAT_EXPECTED_USER_ID to confirm the intended staging test account before creating posts.");
    if (!user?.id || String(user.id) !== expectedId) throw new Error(`Authenticated account ID does not match NEXCHAT_EXPECTED_USER_ID (${expectedId}).`);
    return { token, user };
}

function statePath(origin, userId) {
    const fingerprint = createHash("sha256").update(`${origin}\n${userId}`).digest("hex").slice(0, 20);
    return join(scriptDir, ".bulk-test-posts-state", `${fingerprint}.json`);
}
async function loadState(file) {
    try {
        const state = JSON.parse(await readFile(file, "utf8"));
        return state && typeof state === "object" && state.runs && typeof state.runs === "object" ? state : { runs: {} };
    } catch (error) { if (error?.code === "ENOENT") return { runs: {} }; throw new Error("Bulk-post state file is invalid; refusing cleanup."); }
}
async function saveState(file, state) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, file);
}

async function getPostByMarker(origin, token, userId, marker) {
    const params = new URLSearchParams({ authorId: String(userId), search: marker, sort: "latest" });
    const result = await apiRequest(origin, token, `/api/posts?${params}`);
    return (result?.posts ?? []).find(post => post?.content?.includes(marker)) ?? null;
}

async function getVideoSample(env = process.env) {
    const localPath = env.NEXCHAT_TEST_VIDEO_PATH?.trim();
    if (localPath) {
        const path = resolve(localPath);
        const extension = path.split(".").at(-1)?.toLowerCase();
        const type = extension === "webm" ? "video/webm" : extension === "mp4" ? "video/mp4" : null;
        if (!type) throw new Error("NEXCHAT_TEST_VIDEO_PATH must point to an MP4 or WebM file.");
        const buffer = await readFile(path);
        if (buffer.length > mediaLimitBytes) throw new Error("NEXCHAT_TEST_VIDEO_PATH exceeds the app's 25 MiB per-file limit.");
        validateVideo(buffer, type);
        return { buffer, name: basename(path), type };
    }
    const cacheDir = join(tmpdir(), "nexchat-bulk-test-media");
    const cacheFile = join(cacheDir, "flower.mp4");
    try {
        const cached = await readFile(cacheFile);
        validateVideo(cached, "video/mp4");
        return { buffer: cached, name: "flower.mp4", type: "video/mp4" };
    } catch (error) { if (error?.code !== "ENOENT") await rm(cacheFile, { force: true }); }
    const response = await fetch(videoSampleUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Could not download the public sample video (HTTP ${response.status}); provide a local MP4/WebM with NEXCHAT_TEST_VIDEO_PATH.`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > mediaLimitBytes) throw new Error("The public sample video exceeds the app's 25 MiB per-file limit.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > mediaLimitBytes) throw new Error("The public sample video exceeds the app's 25 MiB per-file limit.");
    validateVideo(buffer, "video/mp4");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, buffer);
    return { buffer, name: "flower.mp4", type: "video/mp4" };
}
function validateVideo(buffer, type) {
    const valid = type === "video/mp4"
        ? buffer.length >= 12 && buffer.subarray(4, 8).toString() === "ftyp"
        : buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!valid) throw new Error(`Selected sample is not a valid ${type} container.`);
}

export async function imageMedia(index) {
    const path = imageAssets[index % imageAssets.length];
    const buffer = await readFile(path);
    if (buffer.length > mediaLimitBytes) throw new Error(`Project image exceeds 25 MiB: ${basename(path)}`);
    const type = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "image/jpeg"
        : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
        : buffer.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/) ? "image/gif"
        : buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp"
        : null;
    if (!type) throw new Error(`Project image has an unsupported or invalid format: ${basename(path)}`);
    const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" }[type];
    const name = `${basename(path).replace(/\.[^.]+$/, "")}${extension}`;
    return { buffer, name, type };
}

async function verifyMediaUrl(media) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(media.url, { headers: { Range: "bytes=0-0" }, signal: controller.signal });
        const valid = response.status === 200 || response.status === 206;
        const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase();
        await response.body?.cancel();
        if (!valid) throw new Error(`Signed media request returned HTTP ${response.status}.`);
        if (contentType && contentType !== media.type.toLowerCase()) throw new Error(`Media type mismatch (${contentType} vs ${media.type}).`);
    } finally { clearTimeout(timer); }
}

async function confirmCleanup(count, userId, runId) {
    if (count === 0) return false;
    const phrase = `DELETE ${count} POSTS FOR USER ${userId} RUN ${runId}`;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(`This removes only manifest-listed posts whose author and marker still match.\nType exactly:\n${phrase}\n> `)) === phrase; }
    finally { rl.close(); }
}

async function cleanupRun(origin, token, userId, runId, state, file) {
    const entries = state.runs[runId];
    if (!Array.isArray(entries) || entries.length === 0) { console.log(`No created posts recorded for run '${runId}'.`); return; }
    if (!await confirmCleanup(entries.length, userId, runId)) { console.log("Cleanup cancelled; no posts were deleted."); return; }
    let deleted = 0; let skipped = 0; let failed = 0;
    for (const entry of entries) {
        try {
            if (!entry || typeof entry.postId !== "string" || typeof entry.marker !== "string" || !entry.marker.includes(`:${runId}:`)) { skipped += 1; continue; }
            const result = await apiRequest(origin, token, `/api/posts/${encodeURIComponent(entry.postId)}`);
            const post = result?.post;
            if (!post || String(post.author?.id) !== String(userId) || !post.content?.includes(entry.marker)) { skipped += 1; continue; }
            await apiRequest(origin, token, `/api/posts/${encodeURIComponent(entry.postId)}`, { method: "DELETE" });
            deleted += 1;
        } catch (error) {
            if (error.status === 404) { skipped += 1; continue; }
            failed += 1;
            console.error(`Cleanup failed for post ${entry?.postId ?? "unknown"}: ${error.message}`);
        }
    }
    if (failed === 0) { delete state.runs[runId]; await saveState(file, state); }
    console.log(`Cleanup result: ${deleted} deleted, ${skipped} skipped (ownership/marker mismatch or missing), ${failed} failed.`);
}

async function createOne({ origin, token, user, state, stateFile, runId, privacy, kind, index, video, totals }) {
    const marker = markerFor(runId, kind, index);
    const existing = await getPostByMarker(origin, token, user.id, marker);
    if (existing) { totals.skipped += 1; return; }
    const selected = kind === "image" ? await imageMedia(index - 1) : kind === "video" ? video : null;
    const captionList = captions[kind];
    const caption = `${captionList[(index - 1) % captionList.length]}\n\n${marker}`;
    const body = new FormData();
    body.set("content", caption);
    body.set("privacy", privacy);
    body.set("keepMediaIds", "[]");
    if (selected) body.append("media", new Blob([selected.buffer], { type: selected.type }), selected.name);
    const created = await apiRequest(origin, token, "/api/posts", { method: "POST", body });
    const post = created?.post;
    if (!post?.id || !post?.author?.id || String(post.author.id) !== String(user.id)) throw new Error("Create API returned a post without the expected author and ID.");
    totals.created += 1;
    state.runs[runId] ??= [];
    const entry = { postId: String(post.id), marker, kind, createdAt: new Date().toISOString() };
    state.runs[runId].push(entry);
    await saveState(stateFile, state);
    const feedPost = await getPostByMarker(origin, token, user.id, marker);
    if (!feedPost || String(feedPost.id) !== String(post.id)) throw new Error("Created post was not found in the account's feed search.");
    if (selected) {
        const media = feedPost.media?.find(item => item.name === selected.name && item.type === selected.type);
        if (!media?.url) throw new Error("Created post is missing its media URL in the feed response.");
        await verifyMediaUrl(media);
    }
    totals.verified += 1;
    console.log(`Created ${kind} post ${post.id}; feed and ${selected ? "signed media URL" : "text content"} verified.`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    const options = parseArgs(argv);
    if (options.help) { console.log(helpText()); return 0; }
    const origin = validateTarget(env.NEXCHAT_STAGING_API_URL, options);
    if (options.dryRun) {
        const total = options.images + options.videos + options.text;
        console.log(`Dry run only. Target host: ${new URL(origin).host}; requested ${options.images} image, ${options.videos} video, ${options.text} text-only posts (total ${total}); privacy=${options.privacy}; run=${options.runId}. No login, network request, upload, or deletion performed.`);
        return 0;
    }
    const { token, user } = await authenticate(origin);
    console.log(`Authenticated staging test account ${user.id} (${user.user_name || user.email || "user"}).`);
    const file = statePath(origin, user.id);
    const state = await loadState(file);
    if (options.cleanup) {
        await cleanupRun(origin, token, user.id, options.runId, state, file);
        return 0;
    }
    const video = options.videos ? await getVideoSample(env) : null;
    const totals = { created: 0, verified: 0, skipped: 0, failed: 0 };
    const jobs = [
        ...Array.from({ length: options.images }, (_, index) => ["image", index + 1]),
        ...Array.from({ length: options.videos }, (_, index) => ["video", index + 1]),
        ...Array.from({ length: options.text }, (_, index) => ["text", index + 1]),
    ];
    for (const [kind, index] of jobs) {
        try { await createOne({ origin, token, user, state, stateFile: file, runId: options.runId, privacy: options.privacy, kind, index, video, totals }); }
        catch (error) { totals.failed += 1; console.error(`Failed ${kind} item ${index}: ${error.message}`); }
    }
    console.log(`Finished run '${options.runId}': ${totals.created} created, ${totals.verified} feed/media verified, ${totals.skipped} skipped as duplicates, ${totals.failed} failed.`);
    return totals.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
