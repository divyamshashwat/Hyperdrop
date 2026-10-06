# Transfer performance: what was measured, what changed

Status: **instrumented and audited; the 3-4 MB/s iPhone number is not yet explained.**
Nothing here was measured on an iPhone. Everything below ran in Chrome on the dev machine.

## 1. Audit of the original engine (before any change)

| Suspect | Finding |
| --- | --- |
| Stop-and-wait ACK per chunk | **No.** ACKs were informational only; chunks were never gated on them. |
| Base64 / JSON payloads | **No.** Binary frames; JSON only for control. |
| Sleeps / delays in the pump | **No.** (One 200 ms *fallback* timer in `drain()`, only if `bufferedamountlow` was late.) |
| Whole-file `arrayBuffer()` | **No.** 1 MB `File.slice()` blocks with one-block read-ahead. |
| Hashing on the main thread | **No.** Worker, fed per chunk. |
| React per chunk | **No.** Session throttles to ~8 Hz. |
| Small buffers | **Yes, a candidate.** high 1 MB / low 256 KB; 64 KB chunks on WebKit. |
| No in-flight window | **Yes.** Receiver backlog was unbounded (a memory risk more than a speed one). |

## 2. Tools added

- `?debug=1` panel (`src/components/dev/transfer-diagnostics.tsx`): ICE type, transport, RTT, capacity (when
  reported), buffered, in-flight, speed/avg/peak, event-loop lag, JS heap, last synthetic result.
- `getStats()` sampler at 1 Hz (`src/lib/diagnostics/stats.ts`), unit-tested incl. "a relay is never called direct".
- Synthetic benchmark over the **live** DataChannel (16/32/64/256 MB, no files): `src/lib/benchmarks/synthetic.ts`.
- In-page loopback matrix (two RTCPeerConnections, no radio): one variable changes per row.
- URL overrides for A/B on a phone: `?chunk=KB&high=MB&low=MB&window=MB&poll=ms`, `?shader=off|minimal|low|medium|high`.

## 3. Measurements (Chrome, same machine, dev build, page `visibilityState: hidden`)

Raw WebRTC DataChannel with **no app code**, 3 runs each, MB/s:

| chunk / high-water | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| 64 KB / 1 MB | 15.8 | 14.7 | 15.3 |
| 64 KB / 8 MB | 13.3 | 14.6 | 15.2 |
| 128 KB / 8 MB | 11.7 | 11.2 | 11.6 |
| 255 KB / 8 MB | 12.2 | 12.4 | 9.3 |

App loopback matrix (synthetic / real hashed file, 64 MB, MB/s; single run per row, so +/- 3 is noise):

| config | synthetic | file |
| --- | --- | --- |
| A legacy 128K, 1M/.25M, no window, 200 ms poll | 15.2 | 13.1 |
| B + 15 ms poll | 13.0 | 13.1 |
| C + 8M/2M buffers | 10.1 | 13.0 |
| D 64K, 8M/2M | 12.0 | 9.7 |
| E 256K, 8M/2M | 13.8 | 12.7 |
| F 64K, 12M/3M | 11.3 | 12.8 |
| G shipped default (64K, 4M/1M, 8M window) | 10.7 | 13.1 |

Real two-tab transfer over a real RTCPeerConnection, shipped defaults: **120 MB HEIC-named file, average 14.1 MB/s,
peak 15.2 MB/s**, hash-verified at the receiver. A 27 MB run reported 8.5 MB/s; that is fixed costs (accept, worker
start, final hash wait), not throughput, which is why the panel now refuses to compare below 64 MB.

### What this does and does not show

- In this environment the **transport is the ceiling (~15 MB/s)**, and the app matches raw WebRTC: Scenario B.
  Our pipeline (slicing, hashing, framing, acks) is not what limits it here.
- Larger chunks (128-255 KB) were **not** faster, and 8 MB buffers were **not** faster than 1 MB. By the rule
  "keep nothing without evidence", the defaults went **back to 64 KB chunks** with a modest 4 MB buffer.
- Chrome rejects `send()` once ~16 MB is queued ("send queue is full"). High-water is now clamped to 12 MB.
  Any 16-32 MB buffer experiment is invalid on Chrome.
- The byte window (8 MB, ACK ranges every 512 KB) was **not shown to add speed**. It stays because it bounds how far
  the sender can run ahead of a slow receiver (memory), and it is the resume bookkeeping. Setting `?window=0` turns it off.
- This machine's ceiling hides any gain above ~15 MB/s, so it cannot tell us whether the new defaults help on a
  fast Wi-Fi link. Only the phone can.

## 4. What is still unknown: the iPhone 3-4 MB/s

The loopback ceiling (~15 MB/s) is already ~4x that number, so the app is unlikely to be the first limit. Candidates,
in priority order, all visible in the `?debug=1` panel:

1. **Path:** ICE type/transport. `host/udp` is expected on one Wi-Fi; `srflx`, `tcp` or `relay` is a different problem.
2. **Network:** RTT and the synthetic benchmark. If synthetic ≈ photos, the radio/Wi-Fi/Safari WebRTC stack is the limit.
3. **iPhone CPU:** event-loop lag. Sustained > ~50 ms during a transfer means the main thread is the limit.
4. **Receiver:** `?debug=1` on the PC; folder write vs. in-memory Blob.

### Run this on the real devices (iPhone → PC)

1. PC: open `/?debug=1`, Receive. iPhone: scan the QR (the link keeps `?debug=1` only if you append it, so
   open `<your-origin>/r/<room>?debug=1#<secret>`, or add `?debug=1` after the room id).
2. On the iPhone panel, with no transfer running, tap **32 MB** then **64 MB**. Record: candidate, transport, RTT, MB/s.
3. Send a real 100+ MB batch. Record average/peak and loop lag.
4. Repeat with `?chunk=64`, `?chunk=128`, `?chunk=255`, and `?high=1` vs `?high=8`. Use the **median of 3**.
5. Compare synthetic vs photos (≥ 64 MB): equal → network-bound; synthetic much higher → file pipeline.

## 5. Not done

- No iPhone, Android, Edge or non-loopback measurements. No battery/thermal data.
- Unordered-delivery and multi-channel experiments: intentionally skipped (no evidence they'd help; they trade
  correctness for speculative gain).
- A separate control DataChannel: skipped. ACKs travel receiver→sender where there is almost no bulk traffic, so they
  are not stuck behind data; measure first if loop-lag or ACK latency ever shows otherwise.
- Shader on/off impact on throughput was not measured (loopback hides it). `?shader=off` exists for the phone test;
  the shader already drops to 30 fps and 8 lanes while bytes move.
