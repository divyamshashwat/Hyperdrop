import type { Metadata } from "next";
import { ProximityLab } from "@/components/dev/proximity-lab";

export const metadata: Metadata = { title: "Nearby calibration — Origin", robots: { index: false, follow: false } };

/** Developer-only hardware calibration for Nearby pairing. Not linked from the product. */
export default function ProximityTestPage() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-[560px] flex-1 px-6 pt-6 pb-16">
      <ProximityLab />
    </main>
  );
}
