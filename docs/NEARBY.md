# Nearby pairing (audible chirp)

Status: **implemented and verified in software.** The first version used near-ultrasonic carriers (20-21 kHz).
It did not pair on real hardware, so Nearby now uses an **audible** band (2.4-4.2 kHz) that every laptop speaker
and phone microphone reproduces well. Fill in section 4 from real devices.

## 1. What it is

The receiver plays a short, quiet chirp; the phone hears it, decodes a **single-use 32-bit token**, the
server resolves it to the existing room, and WebRTC takes over. The sound carries the token only: never photo
data, never SDP/ICE. Fallbacks: QR, then the 6-digit code.

```
receiver  POST /api/session/:id/nearby -> token (20 s, single use, revokes the previous one)
          token -> packet -> speaker (<= 15 s of repeats, stops on pairing)
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
| Modulation | 4-FSK, Gray-coded, one sine at a time, 50 ms symbols, 6 ms raised-cosine edges |
| Length | 61 symbols, about 3.05 s, then 300 ms of silence before the repeat |

Any burst of up to 7 bad symbols is corrected. Payloads that fail the CRC are dropped, never guessed.

## 3. Frequency profile

| Profile | Needs | Carriers (Hz) |
| --- | --- | --- |
| `audible` | 16 kHz or more | 2400 · 3000 · 3600 · 4200 |

Why this band: above most speech and mains-hum energy, below where small speakers roll off, no carrier is a
harmonic of another (speaker distortion can't fake a symbol), and 600 Hz spacing keeps reverb and frequency error
well apart. Symbols are 50 ms (was 30 ms) so room echo of one symbol has mostly decayed before the next is read.

The decoder's noise floor falls fast but rises slowly (~10 s), so the packet's own room echo can't inflate it
before the preamble is recognised; this was the main thing that broke audible decoding in a reverberant room.

History: the near-ultrasonic profiles (20.15-21.05 kHz, and 20.5-22.0 kHz before that) were removed; real
speaker/microphone paths attenuated them too much to pair.

The transmitter picks from the output rate it actually got (`AudioContext.sampleRate`). The phone decodes
every profile its real capture rate can represent. Default level 0.18 (audible, so kept modest). Override with `?nearbyLevel=0.1` to find the
lowest level that still works.

### 3a. Simulated sweep with people talking (2026-11)

`npm run sweep:nearby` runs tone set × symbol length × speech level × talker (close talker, café babble) × distance
through the real decoder, in parallel on every core. Full tables and method: [NEARBY-sweep.md](./NEARBY-sweep.md).

Worst-case chance of pairing within one 15 s broadcast, averaged over speech levels from −6 to +18 dB vs the chirp:

| Tones @ symbol | 30 cm | 1 m | 2 m | per-packet decode at 30 cm, speech +18 dB |
| --- | --- | --- | --- | --- |
| 5.5–7.9 kHz @ 40 ms (`hi-5.5`) | 100% | 100% | 69% | 90% |
| 4.0–6.4 kHz @ 40 ms (`mid-4.0`) | 97% | 97% | 64% | 40% |
| 3.0–5.1 kHz @ 50 ms | 91% | 85% | 56% | 23% |
| **2.4–4.2 kHz @ 50 ms (shipping)** | 80% | 79% | 33% | 3% |
| 1.9–3.7 kHz @ 50 ms | 72% | 66% | 14% | 0% |

What it says:
- **Speech is the problem below ~4 kHz.** Above it speech has little energy ("s" aside), so the higher sets keep
  pairing with speech 18 dB louder than the chirp, where the shipping set stops.
- **At 2 m, room echo is the limit, not speech.** Every set falls to ~30–55% per packet even with speech quieter than
  the chirp; longer symbols help a little. Nearby is a 30 cm–1 m feature.
- **Symbol length matters less than tone height.** 40 ms matches 50–70 ms here with a 2.7 s packet instead of 3.4–4.6 s.
- **No false packets** in 96 minutes of loud speech alone, in any configuration, and no spurious preamble locks.

**A/B on hardware.** `hi-5.5` and `mid-4.0` are `CANDIDATE_PROFILES`: every phone decodes them alongside the shipping
profile, so only the computer changes. Open it with `?nearbyProfile=hi-5.5` (or `mid-4.0`), tap Start Nearby, and
pair from the phone as usual, with someone talking nearby. If a candidate pairs reliably on your speakers, make it
the shipping profile. The sweep can't model laptop speakers that roll off above 6–8 kHz, which is the risk for
`hi-5.5`; `mid-4.0` is the safer bet.

## 4. Calibration and compatibility matrix (fill this in)

Page: `/proximity-test` (not linked, noindex). Over **HTTPS** (the microphone needs a secure page).

1. Computer: **Emit**, one frequency at a time, at levels 0.05 / 0.1 / 0.2.
2. Phone: **Listen**. Copy the "Matrix row" line into the table below.
3. Then **Emit test packet ×3** and check the phone decodes it (corrections and latency are shown).
4. Repeat at 30 cm, 1 m, 2 m; quiet room, office, TV/music.

| Phone | iOS / browser | ctx Hz | mic Hz | 2.4 | 3.0 | 3.6 | 4.2 | packet @ 0.1 | `mid-4.0` w/ talking | `hi-5.5` w/ talking | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | |

Earlier ultrasonic row (iPhone, iOS 18.5 Safari, Windows PC speaker): 20.0-21.0 kHz detected as single tones, but
packets never paired.

## 5. Verified so far (this machine only)

- Unit tests: CRC vector, Hamming single-error correction, interleaver, packet shape, a 7-symbol burst corrected,
  undecodable payloads rejected, profile choice from real rates, carriers in 2-5 kHz and below Nyquist, no carrier a
  harmonic of another, packet under 3.5 s, decoding at 48 k and 44.1 k through noise, delay, attenuation, an
  on-carrier interferer and multi-tap room echo out to 120 ms, **no packet** from 12 s of noise, speech-band motion,
  a held chord, a sweep and a steady 3 kHz beep, and repeats decode once each.
- Server: tokens single use, expire in 20 s, revoked on re-issue and when pairing happens by QR/code.
- In Chrome: the real Web Audio path (`AudioBuffer` via `OfflineAudioContext`) decodes at 48 k and 44.1 k (the
  "Digital self-test" button). The receiver broadcast starts, the token joins the room (200), and a replay is
  rejected (404).

Not yet verified: the audible profile through a real speaker and microphone.

## 6. Honest failure modes

- **Insecure page (plain `http://` on a LAN):** iOS Safari won't expose the microphone, so the phone says
  "Nearby isn't available here" and offers QR. Serve over HTTPS to use Nearby.
- **Bluetooth / headphones:** their mics are narrowband and far from the computer. The phone suggests the
  built-in mic.
- **Loud room:** music or a TV playing in 2-4 kHz can mask the chirp. Move closer or use QR.
- Debug: `?debug=proximity` shows rates, EC/NS/AGC, per-carrier level, noise floor, SNR, preamble/sync/payload/CRC,
  session validity, timings and a 1-6 kHz spectrum. The token is never displayed.
