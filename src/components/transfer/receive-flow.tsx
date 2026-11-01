"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatBytes, formatCode, pluralPhotos } from "@/lib/files/format";
import { pickFolder, type FsDir } from "@/lib/files/sink";
import { NearbyBroadcaster } from "@/lib/proximity/encoder";
import { friendlyDevice, friendlyDeviceStart } from "@/lib/session/device";
import type { TransferApi } from "@/hooks/use-transfer";
import { ConfirmCancel } from "./confirm-cancel";
import { QrPairing } from "./qr-pairing";
import { Dots, Lede, PrimaryButton, Screen, SecondaryButton, StatusLine, TextButton, Title } from "./ui";

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return (
    <span className="num">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

/** Chromium desktop: pick where photos land before the QR appears, so they stream straight to disk. */
export function DestinationStep({ onReady, onBack }: { onReady: (dir: FsDir | null) => void; onBack: () => void }) {
  const choose = async () => {
    const dir = await pickFolder(); // must stay inside this click (user activation)
    if (dir) onReady(dir);
  };
  return (
    <Screen
      label="Choose a destination"
      actions={
        <>
          <PrimaryButton onClick={choose} arrow>
            Choose folder
          </PrimaryButton>
          <SecondaryButton onClick={() => onReady(null)}>Save through the browser</SecondaryButton>
          <TextButton onClick={onBack} className="self-center">
            Back
          </TextButton>
        </>
      }
    >
      <Title>Where should the photos go?</Title>
      <Lede>Pick a folder and every original is written straight into it as it arrives. Nothing to download one by one.</Lede>
    </Screen>
  );
}

export function ReceiveWaiting({ api }: { api: TransferApi }) {
  const { m, actions, dest, broadcast } = api;
  const p = m.pairing;
  const nearbyOk = NearbyBroadcaster.supported() && broadcast !== "unsupported";
  const on = broadcast === "on";

  const copy = async () => {
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p.link);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  return (
    <Screen
      label="Ready to receive"
      actions={
        <>
          {nearbyOk && (
            <PrimaryButton onClick={actions.startNearby} disabled={!p || on}>
              {on ? (
                <span>
                  Nearby is on
                  <Dots />
                </span>
              ) : broadcast === "ended" ? (
                "Start Nearby again"
              ) : (
                "Start Nearby"
              )}
            </PrimaryButton>
          )}
          <div className="flex justify-center gap-2">
            <TextButton onClick={copy} disabled={!p}>
              Copy link
            </TextButton>
            <TextButton onClick={actions.reset}>Cancel</TextButton>
          </div>
        </>
      }
    >
      <Title>{on ? "Bring your iPhone near." : "Scan with your iPhone."}</Title>
      <Lede>
        {on ? "You'll hear a soft chirp. On the phone, tap Find a nearby computer. Or scan the code." : "Open the camera and point it at the code."}
        {dest ? (
          <>
            {" "}
            Photos go to <span className="text-foreground">{dest.name}</span>.
          </>
        ) : null}
      </Lede>
      {broadcast === "unsupported" && (
        <p className="t-small mt-3">Nearby isn&apos;t available on this computer. The code works the same.</p>
      )}

      <div className="mt-9 flex justify-center">
        <QrPairing link={p?.link ?? null} />
      </div>

      <div className="mt-8 flex items-baseline justify-between gap-4">
        <p className="t-meta">
          {p ? (
            <>
              Waiting for your phone
              <Dots />
            </>
          ) : (
            <>
              Preparing
              <Dots />
            </>
          )}
        </p>
        {p && (
          <p className="t-small">
            <Countdown expiresAt={p.expiresAt} />
          </p>
        )}
      </div>
      <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-white/[0.07] pt-4">
        <p className="t-meta">Can&apos;t scan? Enter</p>
        <p className="num text-[22px] font-medium tracking-[0.12em]" aria-label={p ? `Code ${p.code.split("").join(" ")}` : undefined}>
          {p ? formatCode(p.code) : "··· ···"}
        </p>
      </div>
      <p className="t-small mt-6">Device to device. Nothing is uploaded to our servers.</p>
    </Screen>
  );
}

export function IncomingOffer({ api }: { api: TransferApi }) {
  const { m, actions, dest } = api;
  const s = m.summary;
  if (!s) return null;
  const more = s.fileCount - s.names.length;
  const receiving = m.role === "receiver";
  const who = friendlyDevice(m.peerLabel);

  if (!receiving) {
    return (
      <Screen label="Waiting for acceptance" actions={<ConfirmCancel onConfirm={actions.cancel} label="Cancel" />}>
        <StatusLine route={m.route} peer={m.peerLabel} role={m.role} />
        <Title className="mt-6">
          Waiting for {who}
          <Dots />
        </Title>
        <Lede>
          {pluralPhotos(s.fileCount)}, {formatBytes(s.totalBytes, s.totalBytes >= 1e9 ? 2 : 1)}. The other device needs to accept.
        </Lede>
      </Screen>
    );
  }

  return (
    <Screen
      label="Incoming transfer"
      actions={
        <>
          <PrimaryButton onClick={actions.accept}>Accept</PrimaryButton>
          <SecondaryButton onClick={actions.decline}>Decline</SecondaryButton>
        </>
      }
    >
      <StatusLine route={m.route} peer={m.peerLabel} role={m.role} />
      <Title className="num mt-6">
        {friendlyDeviceStart(m.peerLabel)} wants to send {pluralPhotos(s.fileCount)}.
      </Title>
      <p className="t-lede num mt-3">
        <span className="text-foreground">{formatBytes(s.totalBytes, s.totalBytes >= 1e9 ? 2 : 1)}</span> · original files
      </p>
      <ul className="mt-7 space-y-1.5 border-t border-white/[0.07] pt-5 text-[15px] text-muted-foreground">
        {s.names.map((n, i) => (
          <li key={i} className="truncate">
            {n}
          </li>
        ))}
        {more > 0 && <li className="text-ink-3">and {more} more</li>}
      </ul>
      <p className="t-small mt-6">
        {dest ? (
          <>
            Saving to <span className="text-muted-foreground">{dest.name}</span>. Nothing is saved until you accept.
          </>
        ) : (
          "Nothing is saved until you accept."
        )}
      </p>
    </Screen>
  );
}

export function ReceiverConnected({ api }: { api: TransferApi }) {
  const { m, actions } = api;
  return (
    <Screen label="Connected" actions={<TextButton onClick={actions.reset} className="self-center">Disconnect</TextButton>}>
      <StatusLine route={m.route} peer={m.peerLabel} role={m.role} pending={m.phase !== "connected"} />
      <Title className="mt-6">
        Waiting for photos
        <Dots />
      </Title>
      <Lede>{friendlyDeviceStart(m.peerLabel)} is choosing what to send.</Lede>
    </Screen>
  );
}
