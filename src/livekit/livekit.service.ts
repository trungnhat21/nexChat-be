import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AccessToken, EgressClient, WebhookReceiver } from "livekit-server-sdk";
import { makeRecordingOutput, type EgressStorageSettings } from "./livekit.recording.js";

const TOKEN_TTL_SECONDS = 10 * 60;

@Injectable()
export class LiveKitService {
    private readonly url = process.env.LIVEKIT_URL?.trim();
    private readonly apiKey = process.env.LIVEKIT_API_KEY?.trim();
    private readonly apiSecret = process.env.LIVEKIT_API_SECRET?.trim();

    constructor() {
        const configured = [this.url, this.apiKey, this.apiSecret].filter(Boolean).length;
        if (configured !== 0 && configured !== 3) {
            throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be configured together.");
        }
        if (this.url && !/^wss?:\/\//i.test(this.url)) {
            throw new Error("LIVEKIT_URL must be a ws:// or wss:// URL reachable by the client.");
        }
    }

    get isConfigured(): boolean {
        return Boolean(this.url && this.apiKey && this.apiSecret);
    }

    get serverUrl(): string {
        this.assertConfigured();
        return this.url!;
    }

    assertConfigured(): void {
        if (!this.isConfigured) throw new ServiceUnavailableException("LiveKit is not configured on this server.");
    }

    async issueParticipantToken(room: string, identity: string, name: string): Promise<{ token: string; expiresIn: number; url: string }> {
        this.assertConfigured();
        const accessToken = new AccessToken(this.apiKey!, this.apiSecret!, {
            identity,
            name: name.slice(0, 128),
            ttl: TOKEN_TTL_SECONDS,
        });
        accessToken.addGrant({
            roomJoin: true,
            room,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });
        return { token: await accessToken.toJwt(), expiresIn: TOKEN_TTL_SECONDS, url: this.url! };
    }

    private serverApiUrl(): string {
        this.assertConfigured();
        return this.url!.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
    }

    private egressStorage(): EgressStorageSettings {
        this.assertConfigured();
        const endpoint = process.env.RECORDING_EGRESS_S3_ENDPOINT?.trim();
        const bucket = process.env.RECORDING_S3_BUCKET?.trim();
        const accessKey = process.env.RECORDING_EGRESS_S3_ACCESS_KEY_ID?.trim();
        const secret = process.env.RECORDING_EGRESS_S3_SECRET_ACCESS_KEY?.trim();
        const region = process.env.RECORDING_S3_REGION?.trim() || "us-east-1";
        if (!endpoint || !bucket || !accessKey || !secret) {
            throw new ServiceUnavailableException("Recording Egress storage is not configured.");
        }
        let parsed: URL;
        try { parsed = new URL(endpoint); } catch { throw new ServiceUnavailableException("Recording Egress storage endpoint is invalid."); }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new ServiceUnavailableException("Recording Egress storage endpoint must use HTTP or HTTPS.");
        }
        return { endpoint, bucket, accessKey, secret, region };
    }

    async startRecording(roomName: string, objectKey: string, audioOnly: boolean) {
        const client = new EgressClient(this.serverApiUrl(), this.apiKey!, this.apiSecret!);
        const output = makeRecordingOutput(objectKey, this.egressStorage());
        return client.startRoomCompositeEgress(roomName, output, { audioOnly });
    }

    async stopRecording(egressId: string) {
        const client = new EgressClient(this.serverApiUrl(), this.apiKey!, this.apiSecret!);
        return client.stopEgress(egressId);
    }

    async verifyWebhook(rawBody: string, authorization: string | undefined) {
        this.assertConfigured();
        if (!authorization) throw new Error("LiveKit webhook Authorization header is required.");
        return new WebhookReceiver(this.apiKey!, this.apiSecret!).receive(rawBody, authorization);
    }
}
