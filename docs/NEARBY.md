# Nearby pairing (near-ultrasonic)

Status: **implemented and verified in software; not yet validated on real hardware.** The carriers below are
physics-based starting points. Do not ship a profile until the matrix in section 4 has rows from several phones.

## 1. What it is

The receiver plays a short, inaudible packet; the phone hears it, decodes a **single-use 32-bit token**, the
server resolves it to the existing room, and WebRTC takes over. The sound carries the token only: never photo
data, never SDP/ICE. Fallbacks: QR, then the 6-digit code. There is **no audible fallback**.

```
receiver  POST /api/session/:id/nearby -> token (20 s, single use, revokes the previous one)
          token -> packet -> speaker (<= 10 s of repeats, stops on pairing)
phone     tap -> mic -> AudioWorklet -> Goertzel decoder -> preamble -> sync -> Hamming -> CRC
          POST /api/session/join {nearby} -> room -> mic OFF -> WebRTC
```

## 2. Packet

| Field | Size |
| --- | --- |
| Preamble | 8 symbols `0 3 0 3 1 2 1 2` |
| Sync | 4 symbols `3 1 2 0` |
| Version + flags | 1 byte |
| Token | 4 bytes |
| CRC-16/CCITT-FALSE | 2 bytes |
| FEC | Hamming(7,4) per nibble, 14x7 block interleave, 98 bits |
| Modulation | 4-FSK, Gray-coded, one sine at a time, 30 ms symbols, 4 ms raised-cosine edges |
| Length | 61 symbols, about 1.8 s, then 220 ms of silence before the repeat |

Any burst of up to 7 bad symbols is corrected. Payloads that fail the CRC are dropped, never guessed.

## 3. Frequency profiles (starting points)

| Profile | Needs | Carriers (Hz) |
| --- | --- | --- |
| `ultrasonic-low` | 44.1 or 48 kHz | 20150 · 20450 · 20750 · 21050 |

The original 48 kHz profile (20.5 / 21.0 / 21.5 / 22.0 kHz) was **removed after the first hardware
measurement**: the iPhone below hears nothing at 21.5 kHz and above, so it could never decode.

The transmitter picks from the output rate it actually got (`AudioContext.sampleRate`). The phone decodes
every profile its real capture rate can represent. Default level 0.22. Override with `?nearbyLevel=0.1` to find the
lowest level that still works.

## 4. Calibration and compatibility matrix (fill this in)

Page: `/proximity-test` (not linked, noindex). Over **HTTPS** (the microphone needs a secure page).

1. Computer: **Emit**, one frequency at a time, at levels 0.05 / 0.1 / 0.2.
2. Phone: **Listen**. Copy the "Matrix row" line into the table below.
3. Then **Emit test packet ×3** and check the phone decodes it (corrections and latency are shown).
4. Repeat at 30 cm, 1 m, 2 m; quiet room, office, TV/music.

| Phone | iOS / browser | ctx Hz | mic Hz | 20.0 | 20.5 | 21.0 | 21.5 | 22.0 | packet @ 0.1 | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone (model ?) | iOS 18.5 / Safari | 48000 | 48000 | ✓ | ✓ | ✓ | ✕ | ✕ | not yet run | Windows PC speaker, Brave; 20.5 strongest; EC off, NS/AGC not reported |

Ship only carriers that pass on **every** row. If 22.0 kHz fails anywhere, move `ultrasonic-high` down.

## 5. Verified so far (this machine only)

- 15 unit tests: CRC vector, Hamming single-error correction, interleaver, packet shape, a 7-symbol burst corrected,
  undecodable payloads rejected, profile choice from real rates, carriers above 20 kHz and below Nyquist, packet under
  2.5 s, decoding at 48 k and 44.1 k through noise, delay, attenuation and an on-carrier interferer, **no packet**
  from 12 s of noise, speech-band motion, a sweep and a steady 21 kHz whine, and repeats decode once each.
- Server: tokens single use, expire in 20 s, revoked on re-issue and when pairing happens by QR/code.
- In Chrome: the real Web Audio path (`AudioBuffer` via `OfflineAudioContext`) decodes at 48 k and 44.1 k (the
  "Digital self-test" button). The receiver broadcast starts, the token joins the room (200), and a replay is
  rejected (404).

Not verified: anything through a real speaker and microphone. In particular, iPhone Safari's capture path, whose
processing and sample-rate behaviour can remove the band entirely.

## 6. Honest failure modes

- **Insecure page (plain `http://` on a LAN):** iOS Safari won't expose the microphone, so the phone says
  "Nearby isn't available here" and offers QR. Serve over HTTPS to use Nearby.
- **Band filtered:** if audible sound is present but the carrier band is digital silence, the phone says so
  within about 0.4 s instead of listening for 20 s.
- **Bluetooth / headphones:** they usually strip the band. The phone suggests the built-in mic.
- Debug: `?debug=proximity` shows rates, EC/NS/AGC, per-carrier level, noise floor, SNR, preamble/sync/payload/CRC,
  session validity, timings and an 18-24 kHz spectrum. The token is never displayed.
