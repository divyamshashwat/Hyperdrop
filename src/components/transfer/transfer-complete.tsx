"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { downloadAll, downloadBlob } from "@/lib/files/download";
import { formatBytes } from "@/lib/files/format";
import type { FsDir, ReceivedFile } from "@/lib/files/sink";
import { buildZip, canZip } from "@/lib/files/zip";
import type { Machine } from "@/lib/webrtc/connection-state";
import { FileList } from "./file-list";
import { Dots, Facts, PrimaryButton, Screen, SecondaryButton, TextButton, Title } from "./ui";

/** Restraint: the facts, the proof, and what to do next. */
export function TransferComplete({
  m,
  received,
  dest,
  onDone,
  onSendMore,
}: {
  m: Machine;
  received: ReceivedFile[];
  dest: FsDir | null;
  onDone: () => void;
  onSendMore: () => void;
}) {
  const receiving = m.role === "receiver";
  const count = m.summary?.fileCount ?? received.length;
  const total = m.summary?.totalBytes ?? received.reduce((n, f) => n + f.size, 0);
  const inMemory = received.filter((f) => f.file);
  const savedToFolder = receiving && received.length > 0 && inMemory.length === 0;
  const needsSave = receiving && inMemory.length > 0;
  const [busy, setBusy] = useState(false);

  const items = useMemo(
    () => received.map((f) => ({ id: String(f.index), name: f.name, size: f.size, file: f.file })),
    [received],
  );

  const saveAll = async () => {
    setBusy(true);
    try {
      if (inMemory.length === 1) downloadBlob(inMemory[0].file!, inMemory[0].name);
      else await downloadAll(inMemory.map((f) => ({ name: f.name, blob: f.file! })));
    } finally {
      setBusy(false);
    }
  };

  const saveZip = async () => {
    setBusy(true);
    try {
      const blob = await buildZip(inMemory.map((f) => ({ name: f.name, blob: f.file!, lastModified: f.file!.lastModified })));
      downloadBlob(blob, "origin-photos.zip");
    } catch {
      toast.error("Couldn't build the ZIP. Use Save photos instead.");
    } finally {
      setBusy(false);
    }
  };

  const actions = needsSave ? (
    <>
      <PrimaryButton onClick={saveAll} disabled={busy}>
        {busy ? (
          <span>
            Saving
            <Dots />
          </span>
        ) : (
          "Save photos"
        )}
      </PrimaryButton>
      {inMemory.length > 1 && canZip(inMemory) && (
        <SecondaryButton onClick={saveZip} disabled={busy}>
          Save as one ZIP
        </SecondaryButton>
      )}
      <TextButton onClick={onDone} className="self-center">
        Done
      </TextButton>
    </>
  ) : receiving ? (
    <PrimaryButton onClick={onDone}>Done</PrimaryButton>
  ) : (
    <>
      <PrimaryButton onClick={onSendMore} arrow>
        Send more
      </PrimaryButton>
      <SecondaryButton onClick={onDone}>Done</SecondaryButton>
    </>
  );

  return (
    <Screen label="Transfer complete" align={needsSave ? "start" : "center"} actions={actions}>
      <Title aria-live="polite">Transfer complete.</Title>
      <p className="t-lede num mt-3">
        <span className="text-foreground">
          {count} original {count === 1 ? "photo" : "photos"}
        </span>{" "}
        · {formatBytes(total, total >= 1e9 ? 2 : 1)}
      </p>
      <Facts
        className="mt-7"
        items={[
          { text: receiving ? "Every file verified, byte for byte" : "Verified by the receiver, byte for byte" },
          { text: "No compression, no conversion" },
          ...(savedToFolder && dest ? [{ text: `Saved to ${dest.name}` }] : []),
        ]}
      />
      {needsSave && (
        <div className="mt-8">
          <FileList items={items} onDownload={(id) => {
            const f = received.find((r) => String(r.index) === id);
            if (f?.file) downloadBlob(f.file, f.name);
          }} label="Received files" />
          {inMemory.length > 1 && <p className="t-small mt-3">The ZIP only packages the originals. Nothing inside is changed.</p>}
        </div>
      )}
    </Screen>
  );
}
