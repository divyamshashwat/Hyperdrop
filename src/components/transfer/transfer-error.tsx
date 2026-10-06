"use client";

import type { ConnectHint, ErrorCode, Machine } from "@/lib/webrtc/connection-state";
import { Lede, PrimaryButton, Screen, TextButton, Title } from "./ui";

interface Copy {
  title: string;
  body: string;
  action?: string;
}

const COPY: Record<ErrorCode, Copy> = {
  "connection-failed": {
    title: "Direct connection unavailable",
    body: "For the fastest transfer, connect both devices to the same Wi-Fi network.",
    action: "Try again",
  },
  interrupted: {
    title: "Transfer interrupted",
    body: "Your previous progress is still available. It continues where it stopped.",
    action: "Resume",
  },
  "peer-left": {
    title: "Connection lost",
    body: "The devices can no longer reach each other.",
    action: "Start again",
  },
  "session-expired": {
    title: "Session expired",
    body: "Start a new transfer session.",
    action: "Start again",
  },
  unsupported: {
    title: "Unsupported browser",
    body: "This browser does not support the capabilities Origin needs. Try the latest Safari, Chrome or Edge.",
  },
  permission: {
    title: "Permission problem",
    body: "The selected files could not be accessed. Select them again.",
    action: "Select again",
  },
  "verification-failed": {
    title: "Verification failed",
    body: "What arrived didn't match the original, so it wasn't marked as delivered. Nothing was changed on your device.",
    action: "Try again",
  },
  rejected: {
    title: "Transfer declined",
    body: "The receiving device chose not to accept these files.",
    action: "Back to files",
  },
  "peer-cancelled": {
    title: "Cancelled by the other device",
    body: "The transfer was stopped from the other side.",
    action: "Start over",
  },
  "session-not-found": {
    title: "Session not found",
    body: "This code or link is no longer valid. Ask the receiving device for a new one.",
    action: "Start over",
  },
  "session-busy": {
    title: "Session already in use",
    body: "Another device is already connected to this receiver. Ask it to show a new code.",
    action: "Start over",
  },
  "rate-limited": {
    title: "Too many attempts",
    body: "Wait a minute, then try again.",
    action: "Start over",
  },
  storage: {
    title: "Couldn't save the files",
    body: "The receiving device could not store the incoming data. Check free space and try again.",
    action: "Try again",
  },
  protocol: {
    title: "Something went wrong",
    body: "The two devices stopped agreeing on the transfer. Try again.",
    action: "Try again",
  },
  "relay-blocked": {
    title: "Direct connection unavailable",
    body: "Only a relayed path was available, and this service sends directly or not at all. Try the same Wi-Fi network.",
    action: "Try again",
  },
  unknown: { title: "Something went wrong", body: "Try again.", action: "Try again" },
};

const BRAVE_FIX = "open brave://settings/privacy, set “WebRTC IP handling policy” to Default, and try again.";

/** A connection that never formed, explained from the candidates each side offered. */
function connectCopy(hint: ConnectHint): Copy {
  const brave = typeof navigator !== "undefined" && "brave" in navigator;
  if (hint === "local-hidden") {
    return {
      title: "This browser is blocking the direct connection",
      body: brave
        ? `Brave hides this device's network address, so the other device can't reach it. To fix it, ${BRAVE_FIX} Or use Chrome, Edge or Safari.`
        : "This browser hides this device's network address, so the other device can't reach it. Try again and tap Allow when asked for a local connection, or allow WebRTC for this site in your privacy settings.",
      action: "Try again",
    };
  }
  if (hint === "remote-hidden") {
    return {
      title: "The other device's browser is blocking the connection",
      body: `It hides its network address, so this device can't reach it. On an iPhone, try again and tap Allow when it asks for a local connection. If it uses Brave, ${BRAVE_FIX}`,
      action: "Try again",
    };
  }
  return {
    title: "Direct connection unavailable",
    body: "Both devices offered a direct path, but the network kept them apart. Make sure they're on the same Wi-Fi; guest networks and some mesh routers isolate devices. A phone hotspot works as a fallback.",
    action: "Try again",
  };
}

export function TransferError({
  m,
  onPrimary,
  onSecondary,
}: {
  m: Machine;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const cancelled = m.phase === "cancelled" && !m.error;
  const code = m.error?.code ?? "unknown";
  const copy: Copy = cancelled
    ? { title: "Transfer cancelled", body: "Nothing was sent.", action: m.files.length ? "Back to files" : "Start over" }
    : code === "interrupted" && m.role === "receiver"
      ? { ...COPY.interrupted, body: "Waiting for the sender to reconnect. Anything already received is kept.", action: undefined }
      : code === "connection-failed" && m.error?.hint
        ? connectCopy(m.error.hint)
        : COPY[code];

  return (
    <Screen
      label={copy.title}
      actions={
        <>
          {copy.action && <PrimaryButton onClick={onPrimary}>{copy.action}</PrimaryButton>}
          {code === "interrupted" && (
            <TextButton onClick={onSecondary} className="self-center">
              Cancel transfer
            </TextButton>
          )}
        </>
      }
    >
      <div role="alert">
        <Title>{copy.title.endsWith(".") ? copy.title : `${copy.title}.`}</Title>
        <Lede>{copy.body}</Lede>
      </div>
      {m.error && (
        <details className="t-small mt-8">
          <summary className="cursor-pointer select-none transition-colors hover:text-muted-foreground">Technical details</summary>
          <p className="mt-2 break-words font-mono text-[12px]">
            {m.error.code}
            {m.error.detail ? ` · ${m.error.detail}` : ""}
          </p>
        </details>
      )}
    </Screen>
  );
}

