"use client";

import { useRef, useState } from "react";
import { FileRow, ROW_HEIGHT, type ListFile } from "./file-row";

const MAX_HEIGHT = 300;
const OVERSCAN = 4;

/**
 * Fixed-row virtual list: 100+ photos stay smooth because only the visible
 * rows (and their previews) are mounted.
 */
export function FileList({
  items,
  onRemove,
  onDownload,
  label = "Selected files",
}: {
  items: ListFile[];
  onRemove?: (id: string) => void;
  onDownload?: (id: string) => void;
  label?: string;
}) {
  const [top, setTop] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const height = Math.min(MAX_HEIGHT, items.length * ROW_HEIGHT);
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  const scrolls = items.length * ROW_HEIGHT > MAX_HEIGHT;
  const atEnd = top + height >= items.length * ROW_HEIGHT - 2;

  return (
    <div
      ref={ref}
      role="list"
      aria-label={label}
      tabIndex={scrolls ? 0 : -1}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      className={
        "relative -mx-2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-[12px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
        (scrolls && !atEnd ? "[mask-image:linear-gradient(to_bottom,black_78%,transparent)]" : "")
      }
      style={{ height }}
    >
      <div style={{ height: items.length * ROW_HEIGHT, position: "relative" }}>
        <div style={{ position: "absolute", top: first * ROW_HEIGHT, left: 0, right: 0 }}>
          {items.slice(first, last).map((item) => (
            <FileRow key={item.id} item={item} onRemove={onRemove} onDownload={onDownload} />
          ))}
        </div>
      </div>
    </div>
  );
}
