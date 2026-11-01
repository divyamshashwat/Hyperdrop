"use client";

import { useMemo, useState } from "react";
import { formatBytes, pluralPhotos } from "@/lib/files/format";
import { totalSize } from "@/lib/files/file-utils";
import type { TransferApi } from "@/hooks/use-transfer";
import { FileList } from "./file-list";
import { Dots, Facts, Lede, PrimaryButton, Screen, SecondaryButton, StatusLine, TextButton, Title } from "./ui";

const LARGE_BYTES = 1_000_000_000;

/**
 * Safari only shares this phone's Wi-Fi address with pages that have microphone access, and
 * without it the computer can't reach the phone directly. Say so plainly; one tap fixes it.
 */
function LanPrompt({ api }: { api: TransferApi }) {
  if (!api.m.lanPrompt) return null;
  return (
    <div role="alert" className="mt-6 rounded-[14px] bg-white/[0.06] p-4">
      <p className="text-[15px] text-foreground">Allow local connection</p>
      <p className="t-small mt-1">
        Safari only lets this phone be found on your Wi-Fi when the page has microphone access. Nothing is recorded, and
        it switches off as soon as the devices connect.
      </p>
      <div className="mt-3">
        <SecondaryButton onClick={api.actions.allowLan}>Allow</SecondaryButton>
      </div>
    </div>
  );
}

/**
 * The sender's home after scanning the QR. The connection forms in the
 * background while the user does what they came to do: choose photos.
 */
export function ChooseView({ api, openPicker }: { api: TransferApi; openPicker: () => void }) {
  const { m } = api;
  const connected = m.phase === "connected";
  return (
    <Screen
      label="Choose photos"
      actions={
        <PrimaryButton onClick={openPicker} arrow>
          Choose photos
        </PrimaryButton>
      }
    >
      <StatusLine route={m.route} peer={m.peerLabel} role={m.role} pending={!connected} />
      <LanPrompt api={api} />
      <Title className="mt-6">{connected ? "Ready to send." : "Almost ready."}</Title>
      <Lede>Choose the photos you want to send. They arrive exactly as they are: same file, same quality.</Lede>
      <Facts
        className="mt-8"
        items={[
          { text: "Device connected", done: connected },
          { text: "Direct path", done: connected && m.route === "direct" },
          { text: "Ready", done: connected && m.route !== null },
        ]}
      />
    </Screen>
  );
}

/** Count, size, what will happen, one decision. */
export function SelectionView({
  api,
  openPicker,
  onNearby,
}: {
  api: TransferApi;
  openPicker: () => void;
  onNearby?: () => void;
}) {
  const { m, actions } = api;
  const total = useMemo(() => totalSize(m.files), [m.files]);
  const items = useMemo(() => m.files.map((f) => ({ id: f.id, name: f.name, size: f.size, file: f.file })), [m.files]);
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);
  const needsCode = m.phase === "files-selected";
  const connected = m.phase === "connected";
  const large = total >= LARGE_BYTES;
  const digits = code.replace(/\D/g, "");

  const primary = needsCode ? (
    <>
      {onNearby && (
        <PrimaryButton onClick={onNearby} arrow>
          Find a nearby computer
        </PrimaryButton>
      )}
      <SecondaryButton type="submit" form="pair-code" disabled={digits.length !== 6}>
        Connect with code
      </SecondaryButton>
    </>
  ) : (
    <PrimaryButton onClick={actions.send} disabled={!connected} arrow={connected}>
      {!connected ? (
        <span>
          Preparing connection
          <Dots />
        </span>
      ) : large ? (
        "Start transfer"
      ) : (
        "Send photos"
      )}
    </PrimaryButton>
  );

  return (
    <Screen
      label="Selected photos"
      align="start"
      actions={
        <>
          {primary}
          <div className="flex justify-center gap-2">
            <TextButton onClick={openPicker}>Add more</TextButton>
            <TextButton onClick={actions.clearFiles}>Clear</TextButton>
          </div>
        </>
      }
    >
      {!needsCode && <StatusLine route={m.route} peer={m.peerLabel} role={m.role} pending={!connected} className="mb-6" />}
      {!needsCode && <LanPrompt api={api} />}
      <Title className="num">{pluralPhotos(m.files.length)}</Title>
      <p className="t-lede num mt-2">
        <span className="text-foreground">{formatBytes(total, total >= 1e9 ? 2 : 1)}</span> · originals, no compression
      </p>

      <div className="mt-7">
        <FileList items={items} onRemove={actions.removeFile} />
      </div>

      {large && !needsCode && (
        <div className="mt-8">
          <p className="t-meta text-foreground">A large transfer. For the smoothest run:</p>
          <Facts className="mt-3" items={[{ text: "Keep this page open" }, { text: "Keep your phone awake" }, { text: "Stay on Wi-Fi" }]} />
        </div>
      )}

      {needsCode && (
        <form
          id="pair-code"
          className="mt-8"
          onSubmit={(e) => {
            e.preventDefault();
            setInvalid(!actions.joinWithCode(code));
          }}
        >
          <label htmlFor="code" className="t-meta block">
            On the other device, tap Receive. Then find it nearby, scan its code with your camera, or type the six digits here.
          </label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000 000"
            maxLength={7}
            value={code}
            aria-invalid={invalid}
            onChange={(e) => {
              const d = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d);
              setInvalid(false);
            }}
            className="num mt-4 h-16 w-full rounded-[14px] bg-white/[0.06] px-5 text-center text-[28px] font-medium tracking-[0.18em] text-foreground outline-none transition-colors duration-200 placeholder:text-ink-3/70 hover:bg-white/[0.08] focus:bg-white/[0.09] focus-visible:outline-none"
          />
          {invalid && <p className="mt-2 text-[14px] text-destructive">Enter the six digits shown on the receiving device.</p>}
        </form>
      )}
    </Screen>
  );
}
