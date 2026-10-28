# Call realtime event contract

Call notifications use the existing authenticated Socket.IO connection and the existing private `user:<id>` rooms. They are app-level state notifications only. LiveKit remains responsible for room connection, WebRTC signaling, and media; NexChat does not send SDP or ICE candidates over Socket.IO.

## Authentication and authority

Connect with the application's access token in `handshake.auth.token`, as for the other gateway events. The gateway derives the user identity from the verified session and never accepts a client-supplied user ID as identity. There are no client-originated `call:*` socket commands. Start/accept/decline/cancel/end remain authenticated HTTP operations; the gateway reloads the persisted call and checks its current state and the actor's participant role before emitting.

## Server-to-client events

| Event | Recipient | Persisted state / actor check |
| --- | --- | --- |
| `call:outgoing` | Caller private room | `ringing`; actor is caller/initiator |
| `call:incoming` | Callee private room | `ringing`; actor is caller/initiator |
| `call:accepted` | Caller and callee rooms | `accepted`; actor is callee |
| `call:declined` | Caller and callee rooms | `declined`; actor is callee |
| `call:cancelled` | Caller and callee rooms | `cancelled`; actor is caller |
| `call:ended` | Caller and callee rooms | `ended`; actor is either participant |

All events use this minimal shape (IDs are decimal strings to preserve unsigned 64-bit values):

```json
{
  "eventId": "70:accepted",
  "callId": "70",
  "conversationId": "22",
  "callerId": "4",
  "calleeId": "9",
  "callType": "audio",
  "status": "accepted",
  "createdAt": "2026-10-26T10:00:00.000Z",
  "acceptedAt": "2026-10-26T10:00:05.000Z",
  "endedAt": null,
  "endReason": null
}
```

The `callType` is `audio` or `video`; `status` is `ringing`, `accepted`, `declined`, `cancelled`, or `ended`. `endReason` is null until terminal state. The payload intentionally excludes credentials, LiveKit tokens, room names, and media signaling.

## Client behavior and delivery limits

- Register listeners after the authenticated socket connects. Every tab/device for the same account receives the event through its private user room.
- Treat `eventId` as a duplicate-suppression key and update call state idempotently. A retried start request that reuses the persisted idempotency key does not emit another start event.
- HTTP responses and persisted call state remain authoritative. On reconnect or a detected gap, reload `GET /api/calls/active` and optionally `GET /api/calls/history`; events are not replayed.
- Socket.IO room delivery is best-effort. The current gateway has no configured Redis Socket.IO adapter or durable outbox, so delivery across backend instances and delivery to disconnected clients are not guaranteed. Do not infer that a client received an event from a successful HTTP response.
# Reconciliation after reconnect

Socket.IO call events are best-effort notifications. After connecting/reconnecting, an authenticated client should request `GET /api/calls/active`; the response is filtered to calls where the session user is a participant. Ringing calls restore incoming/outgoing UI state. Accepted calls include a fresh, short-lived participant LiveKit token for reconnecting to the authorized room. Do not treat a missed socket event as a call state transition.
