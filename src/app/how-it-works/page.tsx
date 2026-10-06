import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "How it works — Origin" };

const STEPS = [
  ["Open the receiver", "On the Windows PC or Android phone, tap Receive. A QR code appears."],
  ["Scan the QR with your iPhone", "Use the camera. You land straight in the transfer, already connecting."],
  ["Choose your photos", "HEIC stays HEIC. The originals are never converted or compressed."],
  ["Transfer directly", "Photos go device to device, and each one is verified before it counts as delivered."],
] as const;

export default function HowItWorks() {
  return (
    <main className="stage-in relative z-10 mx-auto w-full max-w-[560px] flex-1 px-6 pt-6 pb-16 sm:pt-16">
      <h1 className="t-title">Your photo goes from your device to the other one. Nowhere else.</h1>

      <figure className="mt-12" aria-label="The photos travel directly between the devices. Our server only introduces them.">
        <svg viewBox="0 0 320 120" className="w-full" aria-hidden="true">
          <g stroke="currentColor" fill="none" className="text-foreground">
            <circle cx="24" cy="78" r="5" fill="currentColor" stroke="none" />
            <circle cx="296" cy="78" r="5" />
            <path d="M34 78 H286" strokeOpacity=".7" />
            <path d="M28 70 C 90 18, 230 18, 292 70" strokeOpacity=".18" strokeDasharray="1.5 4" />
          </g>
          <g fill="currentColor" fontSize="10" className="text-muted-foreground">
            <text x="24" y="104" textAnchor="middle">iPhone</text>
            <text x="296" y="104" textAnchor="middle">PC or Android</text>
            <text x="160" y="72" textAnchor="middle" className="fill-foreground">Photos, direct</text>
            <text x="160" y="22" textAnchor="middle">Introduction only</text>
          </g>
        </svg>
      </figure>

      <ol className="mt-12 space-y-8">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="grid grid-cols-[2rem_1fr] gap-x-3">
            <span className="num text-[17px] text-ink-3">{i + 1}</span>
            <div>
              <h2 className="text-[19px] font-semibold tracking-[-0.02em]">{title}</h2>
              <p className="t-meta mt-1.5">{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="t-meta mt-12">
        If a photo ever arrives as JPEG, check Settings → Photos → Transfer to Mac or PC → Keep Originals on the iPhone.
      </p>
      <Link href="/" className="mt-8 inline-flex min-h-11 items-center text-[15px] text-foreground underline-offset-4 hover:underline">
        Start a transfer
      </Link>
    </main>
  );
}
