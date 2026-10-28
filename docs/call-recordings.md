# Call recording (Phase 4)

## Compatibility and media path

The backend pins `livekit-server-sdk` to `2.17.0`. The implementation uses the installed SDK's `EgressClient.startRoomCompositeEgress()` API and `EncodedFileOutput` with S3 output. It does not use the newer unified `StartEgress` API. LiveKit Server and Egress deployment versions are not configured in this repository, so compatibility with the actual staging server must be confirmed with an Egress smoke test before enabling recording.

Media flows directly from LiveKit Egress to the private MinIO/S3 bucket. NestJS stores metadata and signs access URLs; it does not proxy recording bytes. Egress needs network access to LiveKit, Redis (per the Egress deployment configuration), and the S3 endpoint. `RECORDING_EGRESS_S3_ENDPOINT` must be the actual hostname reachable from the Egress container; `localhost` is valid only if MinIO runs in that same container. No container/service name or port is assumed here.

Use a dedicated private recording bucket. The Egress credential should be limited to writing objects under `recordings/*` (PutObject and multipart upload operations required by the deployed Egress version). The separate `RECORDING_S3_*` backend credential needs only GetObject for signed playback and DeleteObject for explicit/retention deletion. Do not grant public access or bucket-wide administration. Validate exact MinIO policy actions against the deployed Egress version and MinIO policy engine before staging.

Example policy templates (replace `<PRIVATE_RECORDING_BUCKET>` with the actual bucket before applying). Egress only receives write and multipart permissions on recording keys:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": "arn:aws:s3:::<PRIVATE_RECORDING_BUCKET>/recordings/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::<PRIVATE_RECORDING_BUCKET>",
      "Condition": { "StringLike": { "s3:prefix": ["recordings/*"] } }
    }
  ]
}
```

Give the backend a different identity with `s3:GetObject` and `s3:DeleteObject` only on `arn:aws:s3:::<PRIVATE_RECORDING_BUCKET>/recordings/*`. The application does not need public-read, bucket listing, or bucket administration. Confirm MinIO supports these exact policy actions/conditions in the deployed release; narrow further if the Egress upload implementation does not require multipart listing.

## Configuration

Set these variables only in the backend/Egress secret stores. Never expose them to frontend builds:

| Variable | Purpose |
| --- | --- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Existing server-side LiveKit connection and webhook verification |
| `RECORDING_S3_ENDPOINT` | Reachable S3-compatible endpoint used by NestJS for signed reads/deletes |
| `RECORDING_S3_BUCKET` | Private recording bucket name, shared with Egress |
| `RECORDING_S3_REGION` | S3 region value (defaults to `us-east-1` for MinIO-compatible deployments) |
| `RECORDING_S3_ACCESS_KEY_ID`, `RECORDING_S3_SECRET_ACCESS_KEY` | Restricted backend read/delete identity |
| `RECORDING_EGRESS_S3_ENDPOINT` | Egress-container-reachable S3 endpoint; may differ from backend endpoint |
| `RECORDING_EGRESS_S3_ACCESS_KEY_ID`, `RECORDING_EGRESS_S3_SECRET_ACCESS_KEY` | Dedicated Egress upload identity |
| `RECORDING_RETENTION_DAYS` | Media retention, integer 1–3650; defaults to 30 days |

The SDK config sets path-style S3 addressing. Do not set endpoint to `localhost` based only on the backend `.env`; determine the actual container network first. Keep the bucket private. The sample `.env.example` intentionally contains no credentials.

## Consent, APIs, and retention

Both call participants must separately opt in while the call is `accepted`. Consent is persisted. Egress starts only after the second consent and a row lock/revalidation of the call, account, friendship/block status, and both consents. Revoking either consent requests Egress stop. Ending, declining, or cancelling the call also requests stop. Start/stop failures are recorded; `POST /api/calls/:callId/recordings/:recordingId/retry-stop` retries a failed stop.

- `POST /api/calls/:callId/recording-consent` with `{ "consent": true|false }`
- `GET /api/calls/:callId/recordings`
- `GET /api/calls/:callId/recordings/:recordingId/playback` (returns a URL valid for at most 5 minutes)
- `DELETE /api/calls/:callId/recordings/:recordingId` (removes media; metadata remains)
- `POST /api/calls/:callId/recordings/:recordingId/retry-stop`

Only authenticated call participants can use these endpoints. Retention cleanup deletes expired media after 30 days by default while keeping audit metadata. Deletion failures are retained as `delete_failed` and retried; stale stop requests are also retried. A backend restart marks a stale `starting` row without an Egress ID as failed rather than blindly starting again, because Egress may have accepted the request before the process stopped. Such cases require operator reconciliation. Do not manually remove or overwrite objects. Random object keys and a unique DB constraint prevent overwriting an existing recording.

## Webhook verification

Configure LiveKit to POST Egress events to `/api/webhooks/livekit` with `Content-Type: application/webhook+json`. The Express raw-body parser is installed before JSON parsing for this route, and `WebhookReceiver` validates the LiveKit Authorization signature before database changes. Webhook IDs are unique; unmatched early events are retained and replayed when the Egress ID is persisted. Event timestamps and terminal states prevent older events from reverting later state. LiveKit webhook delivery is best effort; monitor failed/missing Egress completion events and reconcile against LiveKit operationally.

## Staging-only checks

Before enabling recording, an operator must confirm actual Server/Egress versions, configured Egress API capability, Redis reachability, the real container-to-container MinIO hostname/port/TLS path, bucket privacy, least-privilege credentials, and webhook URL/content type. Run a consented two-user staging call and verify upload, signed playback, stop completion, duplicate webhook handling, and retention deletion. This repository has no deployment compose or infrastructure definition and no real recording has been verified.
