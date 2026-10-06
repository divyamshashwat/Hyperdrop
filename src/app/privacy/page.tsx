import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy — Origin" };

const POINTS: Array<[string, string]> = [
  [
    "A server helps the devices meet",
    "WebRTC needs a go-between so two browsers can find each other. Our signaling server relays small connection messages (SDP and ICE candidates) and a device label such as “iPhone”. It never receives your photos, and it does not see file names or sizes.",
  ],
  [
    "Photos travel peer-to-peer",
    "File data goes over an encrypted WebRTC data channel (DTLS) straight from one browser to the other. There is no upload endpoint in this app.",
  ],
  [
    "Sessions are temporary",
    "A receiving session lives in server memory only. It expires after 10 minutes if nobody joins, and is deleted when either side leaves. The QR link carries a one-time join secret in the URL fragment, which browsers never send to a server. The 6-digit code works once.",
  ],
  [
    "Nothing is stored",
    "We keep no accounts, no logs of your files, and no copies. Received files exist only in the receiving browser until you save them.",
  ],
  [
    "Your network can see that a connection exists",
    "To set up a direct path, each browser learns the other’s network address, as it does in any video call. A public STUN server is used to discover addresses. Your Wi-Fi operator can see that two devices are talking, but not what they exchange.",
  ],
  [
    "Direct only, unless stated",
    "By default there is no relay: if a direct connection can’t be made, the transfer fails rather than quietly routing through a server. If an operator enables a TURN relay, Origin shows RELAYED and says so. Files stay encrypted in transit, but the transfer is then no longer directly peer-to-peer.",
  ],
  [
    "Limits worth knowing",
    "Some corporate or carrier networks block direct connections. Anyone who has the QR code or code can join a waiting session, so only show it to the person you’re sending to. The receiver must explicitly accept before any file is saved.",
  ],
];

export default function Privacy() {
  return (
    <main className="stage-in relative z-10 mx-auto w-full max-w-[560px] flex-1 px-6 pt-6 pb-16 sm:pt-16">
      <h1 className="t-title">Direct transfer. No cloud upload.</h1>
      <p className="t-lede mt-4">Here is exactly what happens, including the parts that involve our server.</p>

      <dl className="mt-12 space-y-8">
        {POINTS.map(([title, body]) => (
          <div key={title}>
            <dt className="text-[17px] font-semibold tracking-[-0.015em]">{title}</dt>
            <dd className="t-meta mt-1.5">{body}</dd>
          </div>
        ))}
      </dl>
      <Link href="/" className="mt-12 inline-flex min-h-11 items-center text-[15px] text-foreground underline-offset-4 hover:underline">
        Back to transfer
      </Link>
    </main>
  );
}
