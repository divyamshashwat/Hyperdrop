"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTransfer } from "@/hooks/use-transfer";
import { detectCapabilities } from "@/lib/session/capabilities";
import { cn } from "@/lib/utils";
import { DestinationStep, IncomingOffer, ReceiveWaiting, ReceiverConnected } from "./receive-flow";
import { ChooseView, SelectionView } from "./send-flow";
import { TransferComplete } from "./transfer-complete";
import { TransferError } from "./transfer-error";
import { TransferProgress } from "./transfer-progress";
import { PrimaryButton, Screen, SecondaryButton, TextButton } from "./ui";
import { NearbyView } from "./nearby-flow";
import { useNearby } from "@/hooks/use-nearby";

// Developer-only: never part of the main bundle.
const Diagnostics = dynamic(() => import("@/components/dev/transfer-diagnostics").then((m) => m.TransferDiagnostics), {
  ssr: false,
});

/**
 * No `image/*` on purpose: iOS Safari may transcode HEIC to JPEG for a generic
 * image filter. Naming HEIC/HEIF explicitly asks for the original bytes.
 */
const ACCEPT =
  "image/heic,image/heif,.heic,.heif,image/jpeg,image/png,image/webp,image/avif,image/gif,image/tiff,.dng";

function hasFiles(e: React.DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function TransferShell({ roomId }: { roomId?: string }) {
  const api = useTransfer({ roomId });
  const { m, metrics, received, dest, awake, actions } = api;
  const nearby = useNearby(actions.joinNearby);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** Pre-session sub-step on Chromium desktop: where should photos land? */
  const [choosingDest, setChoosingDest] = useState(false);

  const openPicker = useCallback(() => {
    actions.pickOpen();
    inputRef.current?.click();
  }, [actions]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onCancel = () => actions.pickCancel();
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [actions]);

  const canDrop = ["idle", "files-selected", "pairing", "connecting", "connected"].includes(m.phase) && m.role !== "receiver";

  const senderHome = m.files.length ? (
    <SelectionView api={api} openPicker={openPicker} />
  ) : (
    <ChooseView api={api} openPicker={openPicker} />
  );

  // Nearby takes over the screen only until pairing begins; then the normal flow continues.
  const nearbyActive = nearby.state.status !== "off" && ["idle", "selecting-files", "files-selected"].includes(m.phase);

  const view = (() => {
    if (nearbyActive) return <NearbyView state={nearby.state} onRetry={nearby.start} onClose={nearby.close} />;
    switch (m.phase) {
      case "idle":
      case "selecting-files":
        // Arriving by QR: show the sender's home from the first frame, never the homepage.
        if (roomId) return senderHome;
        return choosingDest ? (
          <DestinationStep
            onBack={() => setChoosingDest(false)}
            onReady={(dir) => {
              setChoosingDest(false);
              actions.receive(dir);
            }}
          />
        ) : (
          <Home
            onSend={openPicker}
            onReceive={() => (detectCapabilities().folderWrite ? setChoosingDest(true) : actions.receive(null))}
            onNearby={nearby.start}
            dragging={dragging}
          />
        );
      case "files-selected":
        return <SelectionView api={api} openPicker={openPicker} onNearby={nearby.start} />;
      case "creating-session":
      case "waiting-for-peer":
        return <ReceiveWaiting api={api} />;
      case "pairing":
      case "connecting":
      case "connected":
        return m.role === "receiver" ? <ReceiverConnected api={api} /> : senderHome;
      case "awaiting-acceptance":
        return <IncomingOffer api={api} />;
      case "sending":
      case "receiving":
      case "finalizing":
        return <TransferProgress m={m} metrics={metrics} awake={awake} dest={dest} onCancel={actions.cancel} />;
      case "reconnecting":
        if (m.resumePhase === "sending" || m.resumePhase === "receiving") {
          return <TransferProgress m={m} metrics={metrics} awake={awake} dest={dest} onCancel={actions.cancel} />;
        }
        return m.role === "receiver" ? <ReceiverConnected api={api} /> : senderHome;
      case "completed":
        return (
          <TransferComplete m={m} received={received} dest={dest} onDone={actions.reset} onSendMore={actions.sendMore} />
        );
      case "paused":
      case "failed":
      case "expired":
      case "cancelled":
        return (
          <TransferError
            m={m}
            onPrimary={() => {
              if (m.phase === "paused") return actions.resume();
              if (m.error?.code === "unsupported") return actions.reset();
              if (m.role === "receiver") return actions.receive();
              return m.files.length ? actions.backToFiles() : actions.reset();
            }}
            onSecondary={actions.cancel}
          />
        );
    }
  })();

  return (
    <main
      className="relative z-10 flex flex-1 flex-col sm:items-center sm:justify-center"
      onDragEnter={(e) => canDrop && hasFiles(e) && (e.preventDefault(), setDragging(true))}
      onDragOver={(e) => canDrop && hasFiles(e) && (e.preventDefault(), setDragging(true))}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (!canDrop || !hasFiles(e)) return;
        e.preventDefault();
        actions.addFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const list = e.target.files;
          if (list && list.length) actions.addFiles(list);
          else actions.pickCancel();
          e.target.value = ""; // allow re-selecting the same files
        }}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none fixed inset-3 z-0 rounded-[22px] bg-white/[0.025] ring-1 ring-white/15 transition-opacity duration-300 sm:inset-5",
          dragging ? "opacity-100" : "opacity-0",
        )}
      />
      {view}
      <Diagnostics api={api} />
    </main>
  );
}

function Home({
  onSend,
  onReceive,
  onNearby,
  dragging,
}: {
  onSend: () => void;
  onReceive: () => void;
  onNearby: () => void;
  dragging: boolean;
}) {
  return (
    <Screen
      wide
      align="end"
      label="Send or receive photos"
      actions={
        <div className={cn("flex flex-col gap-2.5 transition-opacity duration-300", dragging && "opacity-0")}>
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <PrimaryButton onClick={onSend} arrow className="sm:flex-[1.4]">
              Send photos
            </PrimaryButton>
            <SecondaryButton onClick={onReceive} className="sm:flex-1">
              Receive
            </SecondaryButton>
          </div>
          <TextButton onClick={onNearby} className="self-center">
            Find a nearby computer
          </TextButton>
        </div>
      }
    >
      <div className={cn("transition-opacity duration-300", dragging && "opacity-0")}>
        <h1 className="t-hero">
          <span className="whitespace-nowrap">Move your photos.</span>
          <br />
          <span className="whitespace-nowrap text-foreground/50">Keep the original.</span>
        </h1>
        <p className="t-lede mt-5 max-w-[30rem]">
          Send original HEIC photos from iPhone straight to Android or Windows. Nothing is uploaded, nothing is compressed.
        </p>
        <p className="t-small mt-8">No account. Original files. Device to device.</p>
      </div>
      {dragging && (
        <p aria-live="polite" className="t-title pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center">
          Drop the originals here
        </p>
      )}
    </Screen>
  );
}
