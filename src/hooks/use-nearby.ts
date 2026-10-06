"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NearbyListener, type NearbyState } from "@/lib/proximity/listener";
import { setFieldProximity } from "@/lib/visual/field-store";

export type NearbyUi = NearbyState | { status: "off" };

/**
 * The phone side of Nearby. Owns one NearbyListener at a time; React only sees
 * state *changes* (listening, signal, validating, ...), never audio frames.
 */
export function useNearby(onToken: (tokenHex: string) => Promise<boolean>) {
  const [state, setState] = useState<NearbyUi>({ status: "off" });
  const listener = useRef<NearbyListener | null>(null);
  const tokenCb = useRef(onToken);
  useEffect(() => {
    tokenCb.current = onToken;
  }, [onToken]);

  const update = useCallback((s: NearbyUi) => {
    setState(s);
    setFieldProximity(
      s.status === "listening" || s.status === "starting"
        ? 1
        : s.status === "signal"
          ? 2
          : s.status === "validating"
            ? 3
            : 0,
    );
  }, []);

  /** Call from a click handler: this is where the microphone permission prompt happens. */
  const start = useCallback(() => {
    listener.current?.stop();
    const l = new NearbyListener({ onState: update, onToken: (t) => tokenCb.current(t) });
    listener.current = l;
    void l.start();
  }, [update]);

  const close = useCallback(() => {
    listener.current?.stop();
    listener.current = null;
    update({ status: "off" });
  }, [update]);

  // Paired: the microphone is already off; drop back so the transfer flow takes over.
  useEffect(() => {
    if (state.status === "paired") {
      listener.current = null;
      setFieldProximity(0);
      const t = setTimeout(() => setState({ status: "off" }), 0);
      return () => clearTimeout(t);
    }
  }, [state.status]);

  // Route change / unmount: never leave the microphone running.
  useEffect(
    () => () => {
      listener.current?.stop();
      setFieldProximity(0);
    },
    [],
  );

  return { state, start, close };
}
