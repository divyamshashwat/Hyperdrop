"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { toSelected } from "@/lib/files/file-utils";
import { FolderSink, type FsDir, type ReceivedFile } from "@/lib/files/sink";
import { NearbyBroadcaster, type BroadcastState } from "@/lib/proximity/ultrasonic-encoder";
import { parseJoinHash, normalizeCode } from "@/lib/session/room";
import { supportsRequiredApis } from "@/lib/session/device";
import { EMPTY_METRICS, type MetricsSnapshot } from "@/lib/transfer/metrics";
import { field, setFieldMetrics, setFieldPhase } from "@/lib/visual/field-store";
import { INITIAL, isTransferring, reduce } from "@/lib/webrtc/connection-state";
import { TransferSession, type DiagSnapshot } from "@/lib/webrtc/connection-manager";

interface Options {
  /** Present on /r/[room]: the sender arrived by scanning the receiver's QR. */
  roomId?: string;
}

export function useTransfer({ roomId }: Options = {}) {
  const router = useRouter();
  const [m, dispatch] = useReducer(reduce, INITIAL);
  const [metrics, setMetrics] = useState<MetricsSnapshot>(EMPTY_METRICS);
  const [received, setReceived] = useState<ReceivedFile[]>([]);
  const [diag, setDiag] = useState<DiagSnapshot | null>(null);
  /** Receiver's chosen destination folder (Chromium desktop). Null → browser downloads. */
  const [dest, setDest] = useState<FsDir | null>(null);
  /** True once a screen wake lock is actually held. */
  const [awake, setAwake] = useState(false);
  const destRef = useRef<FsDir | null>(null);
  /** Receiver's Nearby transmitter state. */
  const [broadcast, setBroadcast] = useState<BroadcastState>("off");
  const broadcaster = useRef<NearbyBroadcaster | null>(null);
  const session = useRef<TransferSession | null>(null);
  const machine = useRef(m);
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joined = useRef(false);

  useEffect(() => {
    machine.current = m;
  }, [m]);

  const create = useCallback((role: "sender" | "receiver", reset = true) => {
    session.current?.dispose();
    if (reset) {
      setMetrics(EMPTY_METRICS);
      setReceived([]);
    }
    const s = new TransferSession(role, {
      dispatch,
      onMetrics: setMetrics,
      onReceived: setReceived,
      onDiag: setDiag,
    });
    session.current = s;
    const q = new URLSearchParams(location.search);
    if (process.env.NEXT_PUBLIC_DIAGNOSTICS === "1" || q.has("diag") || q.has("debug")) {
      s.startDiagnostics();
      (window as unknown as { __origin?: TransferSession }).__origin = s;
    }
    return s;
  }, []);

  /* ---- shader bridge: phase + throttled metrics only; never per-frame ---- */
  useEffect(() => setFieldPhase(m.phase), [m.phase]);

  /* ---- Nearby broadcast lives only while the receiver is waiting for a phone ---- */
  useEffect(() => {
    if (m.phase !== "waiting-for-peer") broadcaster.current?.stop(false);
  }, [m.phase]);
  useEffect(() => () => broadcaster.current?.stop(false), []);
  useEffect(() => {
    field.receiver = m.role === "receiver";
  }, [m.role]);
  useEffect(() => {
    if (isTransferring(m.phase)) setFieldMetrics(metrics.percentage, metrics.bytesPerSecond);
  }, [m.phase, metrics.percentage, metrics.bytesPerSecond]);

  /* ---- arriving through a QR link: join immediately, files come after ---- */
  useEffect(() => {
    if (disposeTimer.current) clearTimeout(disposeTimer.current);
    if (roomId && !joined.current) {
      const secret = parseJoinHash(location.hash);
      joined.current = true;
      if (!supportsRequiredApis()) {
        dispatch({ type: "FAILED", code: "unsupported" });
      } else if (!secret) {
        dispatch({ type: "FAILED", code: "session-not-found" });
      } else {
        history.replaceState(null, "", location.pathname + location.search); // the secret never stays in the address bar
        queueMicrotask(() => void create("sender", false).join({ roomId, secret }, true));
      }
    }
    return () => {
      // Deferred so React StrictMode's simulated unmount doesn't kill a live session.
      disposeTimer.current = setTimeout(() => session.current?.dispose(), 60);
    };
  }, [roomId, create]);

  /* ---- page lifecycle: leave the room on pagehide, recover on return ---- */
  useEffect(() => {
    const hide = () => session.current?.dispose();
    const nudge = () => {
      if (!document.hidden) session.current?.nudge();
    };
    const warn = (e: BeforeUnloadEvent) => {
      if (isTransferring(machine.current.phase)) e.preventDefault();
    };
    const offline = () => session.current?.onOffline();
    addEventListener("pagehide", hide);
    addEventListener("pageshow", nudge);
    addEventListener("offline", offline);
    addEventListener("online", nudge);
    document.addEventListener("visibilitychange", nudge);
    addEventListener("beforeunload", warn);
    return () => {
      removeEventListener("pagehide", hide);
      removeEventListener("pageshow", nudge);
      removeEventListener("offline", offline);
      removeEventListener("online", nudge);
      document.removeEventListener("visibilitychange", nudge);
      removeEventListener("beforeunload", warn);
    };
  }, []);

  /* ---- keep the screen awake while bytes are moving (iOS drops the channel on lock) ---- */
  useEffect(() => {
    if (!isTransferring(m.phase) && m.phase !== "reconnecting") return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = (await navigator.wakeLock?.request("screen")) ?? null;
        if (cancelled) void lock?.release();
        else setAwake(!!lock);
      } catch {
        setAwake(false); // not available or denied: the UI shows a "keep this page open" reminder instead
      }
    };
    void acquire();
    const again = () => {
      if (!document.hidden) void acquire();
    };
    document.addEventListener("visibilitychange", again);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", again);
      void lock?.release();
      setAwake(false);
    };
  }, [m.phase]);

  /* ---- actions ---- */
  const actions = useMemo(
    () => ({
      pickOpen: () => dispatch({ type: "PICK_OPEN" }),
      pickCancel: () => dispatch({ type: "PICK_CANCEL" }),
      addFiles: (list: File[] | FileList) => {
        const files = Array.from(list).filter((f) => f.size >= 0).map(toSelected);
        dispatch({ type: "FILES_ADD", files });
      },
      removeFile: (id: string) => dispatch({ type: "FILES_REMOVE", id }),
      clearFiles: () => dispatch({ type: "FILES_CLEAR" }),
      /** `folder` is the destination chosen up front (or null to save through browser downloads). */
      receive: (folder: FsDir | null = destRef.current) => {
        if (!supportsRequiredApis()) return dispatch({ type: "FAILED", code: "unsupported" });
        destRef.current = folder;
        setDest(folder);
        void create("receiver").startReceiving();
      },
      joinWithCode: (raw: string) => {
        const code = normalizeCode(raw);
        if (!code) return false;
        if (!supportsRequiredApis()) {
          dispatch({ type: "FAILED", code: "unsupported" });
          return true;
        }
        void create("sender").join({ code });
        return true;
      },
      /** Sender: a token heard over Nearby. Resolves true once the server accepts it and pairing starts. */
      joinNearby: async (tokenHex: string) => {
        if (!supportsRequiredApis()) return false;
        return create("sender").join({ nearby: tokenHex }, false, { quiet: true });
      },
      /** Receiver: start broadcasting. Must be called from the click (audio needs user activation). */
      startNearby: () => {
        const b = (broadcaster.current ??= new NearbyBroadcaster(setBroadcast));
        if (!b.prepare()) {
          setBroadcast("unsupported");
          return;
        }
        void session.current?.issueNearbyToken().then((token) => {
          if (token) b.play(token);
          else b.stop(false);
        });
      },
      stopNearby: () => broadcaster.current?.stop(false),
      send: () => {
        const files = machine.current.files.map((f) => f.file);
        if (files.length) session.current?.sendFiles(files);
      },
      accept: () => {
        const dir = destRef.current;
        session.current?.accept(dir ? (files) => new FolderSink(dir, files) : undefined);
      },
      sendMore: () => {
        if (!session.current?.sendMore()) dispatch({ type: "FAILED", code: "peer-left" });
      },
      decline: () => session.current?.reject(),
      cancel: () => session.current?.cancel(),
      resume: () => session.current?.resume(),
      backToFiles: () => dispatch({ type: "BACK_TO_FILES" }),
      reset: () => {
        session.current?.dispose();
        session.current = null;
        destRef.current = null;
        setDest(null);
        setMetrics(EMPTY_METRICS);
        setReceived([]);
        dispatch({ type: "RESET" });
        if (roomId) router.replace("/"); // leave the one-time pairing page for the real home
      },
    }),
    [create, roomId, router],
  );

  return { m, metrics, received, diag, dest, awake, broadcast, actions };
}

export type TransferApi = ReturnType<typeof useTransfer>;
