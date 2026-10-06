"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** The QR carries only a room id and a one-time join secret. No file data, no names. */
export function QrPairing({ link }: { link: string | null }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!link) return;
    let alive = true;
    QRCode.toString(link, {
      type: "svg",
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#0b0b0a", light: "#efeeea" },
    }).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [link]);

  return (
    <div
      className="size-[min(64vw,240px)] rounded-[20px] bg-[#efeeea] p-[18px] transition-transform duration-500 ease-[var(--ease-out)] hover:scale-[1.015]"
      role="img"
      aria-label="QR code. Scan it with the sending device's camera."
    >
      {svg ? (
        <div className="stage-in size-full [&_svg]:size-full [&_svg]:[shape-rendering:crispEdges]" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="size-full animate-pulse rounded-[6px] bg-black/[0.06]" />
      )}
    </div>
  );
}
