# Origin — direct photo transfer

Send original HEIC/HEIF photos from an iPhone to Android or Windows, browser to browser.
No upload, no compression, no conversion, no account.

```
sender ── WebRTC DataChannel (encrypted, peer-to-peer) ──▶ receiver
   └────────── signaling server: introductions only ──────────┘
```

The server relays SDP/ICE messages and a device label ("iPhone"). It has no upload route and never sees
file bytes or file names. Rooms are in-memory and die on completion, departure or timeout.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 48 unit + integration tests
npm run typecheck && npm run lint && npm run build
```

Copy `.env.example` to `.env.local` to configure STUN/TURN. Default policy is `direct-only`: if no direct
path exists the transfer fails honestly instead of silently relaying. `TRANSFER_POLICY=allow-relay` hands out
short-lived TURN credentials from `/api/ice` and the UI then shows RELAYED with a disclosure.

Developer diagnostics: add `?diag=1` (or `NEXT_PUBLIC_DIAGNOSTICS=1`, or press Shift+D).

### Deployment constraint

Signaling uses server-sent events plus POST, and rooms live in process memory, so run **one long-lived Node
instance** (`next start`, a container, a VM). It will not work on stateless/serverless platforms with several
instances. To scale out, swap `src/server/rooms.ts` for a shared store (Redis pub/sub); the client
`SignalingClient` is transport-agnostic. Serve over HTTPS (WebRTC secure-context APIs, wake lock).

## How the pieces map

| Concern | Where |
| --- | --- |
| State machine (all UI derives from it) | `src/lib/webrtc/connection-state.ts` |
| Peer connection, ICE restart, generations | `src/lib/webrtc/peer-connection.ts` |
| Signaling client / server | `src/lib/webrtc/signaling-client.ts`, `src/server/rooms.ts`, `src/app/api/*` |
| Protocol, framing, validation | `src/lib/webrtc/protocol.ts` |
| Chunking, backpressure | `src/lib/webrtc/chunker.ts`, `data-channel.ts` |
| Sender / receiver engines, resume | `src/lib/webrtc/transfer-manager.ts` |
| Streaming SHA-256 (worker) | `src/lib/webrtc/sha256.ts`, `src/workers/file-hasher.worker.ts` |
| Orchestration | `src/lib/webrtc/connection-manager.ts` |
| Shader | `src/components/visual/*`, `src/lib/visual/field-store.ts` |

Originals are never decoded: previews are an `<img>` over the same `File`; the transferred bytes come from
`File.slice()`. A file is reported delivered only after size, chunk count and SHA-256 all match.

## Real-device checklist (not automated — must be run by hand)

Automated tests cover the engine over an in-memory channel and two real Chrome tabs over real WebRTC.
They do **not** cover iOS Safari. Before calling this done, run:

- [ ] iPhone Safari → Windows Chrome / Edge, Android Chrome, Mac Safari (2 MB, 100 MB, 1 GB+ batches)
- [ ] Android Chrome → Windows Chrome; Windows Edge → Android Chrome
- [ ] **iOS HEIC check**: select HEIC from Photos; confirm the received file is `.HEIC` with identical size
      (Safari may transcode if the accept list lacks HEIC; this app names HEIC/HEIF explicitly)
- [ ] Same Wi-Fi, different Wi-Fi, mobile hotspot, NAT-heavy network (expect a clear failure in direct-only mode)
- [ ] Screen lock, tab switch, backgrounding Safari mid-transfer (expect Reconnecting → resume)
- [ ] Sender cancel, receiver cancel/decline, reload while waiting, expired QR, two simultaneous sessions
- [ ] Download behaviour on iOS Safari for multi-file batches; large Blob creation memory limits
