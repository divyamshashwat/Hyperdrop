import type { Metadata } from "next";
import { TransferShell } from "@/components/transfer/transfer-shell";

export const metadata: Metadata = { title: "Connecting — Origin", robots: { index: false } };

/** The QR code opens here: /r/<room>#<secret>. The secret is in the fragment, so no server ever sees it. */
export default async function JoinPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  return <TransferShell roomId={room} />;
}
