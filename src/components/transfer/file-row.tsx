"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, X } from "lucide-react";
import { formatBytes } from "@/lib/files/format";
import { createPreviewUrl, revokePreviewUrl } from "@/lib/files/file-preview";
import { extensionOf } from "@/lib/files/file-type";

export const ROW_HEIGHT = 60;

export interface ListFile {
  id: string;
  name: string;
  size: number;
  /** The untouched original, when we have it locally (preview only). */
  file: File | null;
}

/**
 * Preview = an <img> pointing at the original File's object URL. If the browser
 * can't render it (HEIC outside Safari), a quiet tile shows the format instead.
 * The file is never converted to make a thumbnail.
 */
function Thumb({ file, ext }: { file: File | null; ext: string }) {
  const img = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);

  // Attached imperatively so StrictMode's mount/unmount/mount can't leave a revoked URL behind.
  useEffect(() => {
    const el = img.current;
    if (!file || !el) return;
    const u = createPreviewUrl(file);
    el.src = u;
    return () => revokePreviewUrl(u);
  }, [file]);

  return (
    <div className="relative size-10 shrink-0 overflow-hidden rounded-[8px] bg-white/[0.05]">
      {file && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={img} alt="" decoding="async" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className="grid size-full place-items-center text-[9px] font-medium tracking-[0.04em] text-ink-3" title="Original file">
          {ext.slice(0, 4).toUpperCase() || "FILE"}
        </span>
      )}
    </div>
  );
}

export function FileRow({
  item,
  onRemove,
  onDownload,
}: {
  item: ListFile;
  onRemove?: (id: string) => void;
  onDownload?: (id: string) => void;
}) {
  const ext = extensionOf(item.name).toUpperCase() || "FILE";
  const action = onRemove ?? onDownload;
  return (
    <div
      role="listitem"
      aria-label={`${item.name}, ${ext}, ${formatBytes(item.size)}`}
      className="group flex items-center gap-3.5 rounded-[12px] px-2 transition-colors duration-200 hover:bg-white/[0.035]"
      style={{ height: ROW_HEIGHT }}
    >
      <Thumb file={item.file} ext={ext} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] leading-tight text-foreground">{item.name}</p>
        <p className="num mt-1 text-[13px] text-ink-3">
          {ext} · {formatBytes(item.size)}
        </p>
      </div>
      {action && (
        <button
          type="button"
          onClick={() => action(item.id)}
          aria-label={`${onRemove ? "Remove" : "Download"} ${item.name}`}
          className="grid size-11 shrink-0 place-items-center rounded-[10px] text-ink-3 transition-[color,background-color,opacity] duration-200 hover:bg-white/[0.06] hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
        >
          {onRemove ? <X className="size-4" /> : <ArrowDown className="size-4" />}
        </button>
      )}
    </div>
  );
}
