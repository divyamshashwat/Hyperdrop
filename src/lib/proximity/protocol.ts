/**
 * Nearby pairing: the acoustic packet format.
 *
 * The packet carries ONE thing: a short, single-use, server-issued token that
 * names a temporary signaling room. Never photo data, never SDP or ICE.
 *
 *   PREAMBLE (8 sym) · SYNC (4 sym) · DATA (49 sym)
 *   DATA = interleave( hamming74( [version|flags][token u32][crc16] ) )
 *        = 7 bytes = 14 nibbles -> 14 x 7 = 98 bits -> 49 two-bit symbols
 */

export const PROTOCOL_VERSION = 1;
export const BITS_PER_SYMBOL = 2;
export const TONES = 4;

/** Distinctive alternating pattern; never produced by a constant tone or a sweep. */
export const PREAMBLE = [0, 3, 0, 3, 1, 2, 1, 2] as const;
export const SYNC = [3, 1, 2, 0] as const;

const PAYLOAD_BYTES = 5;
const PACKET_BYTES = PAYLOAD_BYTES + 2; // + CRC-16
const CODEWORDS = PACKET_BYTES * 2; // one Hamming(7,4) codeword per nibble
export const CODED_BITS = CODEWORDS * 7; // 98
export const DATA_SYMBOLS = CODED_BITS / BITS_PER_SYMBOL; // 49
export const PACKET_SYMBOLS = PREAMBLE.length + SYNC.length + DATA_SYMBOLS; // 61

export interface PairingPayload {
  version: number;
  flags: number;
  /** 32-bit single-use token issued by the server. */
  token: number;
}

/* ------------------------------------------------------------- bytes + CRC */

export function serializePayload(p: PairingPayload): Uint8Array {
  const b = new Uint8Array(PAYLOAD_BYTES);
  b[0] = ((p.version & 0xf) << 4) | (p.flags & 0xf);
  new DataView(b.buffer).setUint32(1, p.token >>> 0);
  return b;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function addCRC(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 2);
  out.set(bytes);
  const c = crc16(bytes);
  out[bytes.length] = c >> 8;
  out[bytes.length + 1] = c & 0xff;
  return out;
}

export function checkCRC(bytes: Uint8Array): Uint8Array | null {
  const body = bytes.subarray(0, bytes.length - 2);
  const c = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  return crc16(body) === c ? body : null;
}

/* ----------------------------------------------------- Hamming(7,4) FEC */

/** Codeword bit order (1-indexed): p1 p2 d1 p3 d2 d3 d4. Corrects any single bit error. */
export function hammingEncode(nibble: number): number[] {
  const d1 = (nibble >> 3) & 1;
  const d2 = (nibble >> 2) & 1;
  const d3 = (nibble >> 1) & 1;
  const d4 = nibble & 1;
  return [d1 ^ d2 ^ d4, d1 ^ d3 ^ d4, d1, d2 ^ d3 ^ d4, d2, d3, d4];
}

export function hammingDecode(c: number[]): { nibble: number; corrected: boolean } {
  const bits = c.slice();
  const s = (bits[0] ^ bits[2] ^ bits[4] ^ bits[6]) | ((bits[1] ^ bits[2] ^ bits[5] ^ bits[6]) << 1) | ((bits[3] ^ bits[4] ^ bits[5] ^ bits[6]) << 2);
  if (s) bits[s - 1] ^= 1;
  return { nibble: (bits[2] << 3) | (bits[4] << 2) | (bits[5] << 1) | bits[6], corrected: s !== 0 };
}

export function addErrorCorrection(bytes: Uint8Array): number[][] {
  const words: number[][] = [];
  for (const b of bytes) words.push(hammingEncode(b >> 4), hammingEncode(b & 0xf));
  return words;
}

export function removeErrorCorrection(words: number[][]): { bytes: Uint8Array; corrections: number } {
  const bytes = new Uint8Array(words.length / 2);
  let corrections = 0;
  for (let i = 0; i < bytes.length; i++) {
    const hi = hammingDecode(words[2 * i]);
    const lo = hammingDecode(words[2 * i + 1]);
    corrections += Number(hi.corrected) + Number(lo.corrected);
    bytes[i] = (hi.nibble << 4) | lo.nibble;
  }
  return { bytes, corrections };
}

/* ------------------------------------------------------------ interleave */

/**
 * Block interleaver: emit bit j of every codeword before bit j+1 of any. Adjacent
 * symbols therefore always hit *different* codewords, so a burst of up to 7
 * corrupted symbols costs each codeword at most one bit, which Hamming fixes.
 */
export function interleaveBits(words: number[][]): number[] {
  const out: number[] = [];
  for (let j = 0; j < 7; j++) for (let i = 0; i < words.length; i++) out.push(words[i][j]);
  return out;
}

export function deinterleaveBits(bits: number[], codewords = CODEWORDS): number[][] {
  const words = Array.from({ length: codewords }, () => new Array<number>(7).fill(0));
  let k = 0;
  for (let j = 0; j < 7; j++) for (let i = 0; i < codewords; i++) words[i][j] = bits[k++] ?? 0;
  return words;
}

/* ------------------------------------------------------- symbol mapping */

/** Gray code: confusing a tone with its neighbour flips only one bit. */
const GRAY = [0b00, 0b01, 0b11, 0b10];
const GRAY_INV = [0, 1, 3, 2];

export function mapSymbols(bits: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 2) out.push(GRAY_INV[(bits[i] << 1) | (bits[i + 1] ?? 0)]);
  return out;
}

export function unmapSymbols(symbols: number[]): number[] {
  const bits: number[] = [];
  for (const s of symbols) {
    const g = GRAY[s & 3];
    bits.push(g >> 1, g & 1);
  }
  return bits;
}

/* --------------------------------------------------------------- packet */

export function encodePacket(p: PairingPayload): number[] {
  const data = mapSymbols(interleaveBits(addErrorCorrection(addCRC(serializePayload(p)))));
  return [...PREAMBLE, ...SYNC, ...data];
}

export interface DecodedPacket {
  payload: PairingPayload;
  corrections: number;
}

/** Data symbols -> payload, or null if the CRC fails after error correction. Never guesses. */
export function decodeDataSymbols(symbols: number[]): DecodedPacket | null {
  if (symbols.length !== DATA_SYMBOLS) return null;
  const { bytes, corrections } = removeErrorCorrection(deinterleaveBits(unmapSymbols(symbols)));
  const body = checkCRC(bytes);
  if (!body) return null;
  const version = body[0] >> 4;
  if (version !== PROTOCOL_VERSION) return null;
  return {
    payload: { version, flags: body[0] & 0xf, token: new DataView(body.buffer, body.byteOffset).getUint32(1) },
    corrections,
  };
}

export function tokenToHex(token: number): string {
  return (token >>> 0).toString(16).padStart(8, "0");
}

export function hexToToken(hex: string): number {
  return parseInt(hex, 16) >>> 0;
}
