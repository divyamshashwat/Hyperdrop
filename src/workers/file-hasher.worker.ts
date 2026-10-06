/// <reference lib="webworker" />
import { Sha256 } from "../lib/webrtc/sha256";

type Msg =
  | { op: "update"; id: number; buf: ArrayBuffer }
  | { op: "digest"; id: number };

const hashers = new Map<number, Sha256>();

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.op === "update") {
    let h = hashers.get(m.id);
    if (!h) hashers.set(m.id, (h = new Sha256()));
    h.update(new Uint8Array(m.buf));
  } else {
    const h = hashers.get(m.id) ?? new Sha256();
    hashers.delete(m.id);
    (self as unknown as Worker).postMessage({ id: m.id, hex: h.hex() });
  }
};
