import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { TransferField } from "@/components/visual/transfer-field";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Origin — move your photos, keep the original",
  description:
    "Send original HEIC photos directly from iPhone to Android or Windows. No upload, no compression, no conversion, no account.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Origin" },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}>
      <body className="min-h-dvh">
        <TransferField />
        <div className="relative z-10 flex min-h-dvh flex-col pt-[env(safe-area-inset-top)]">
          <SiteHeader />
          {children}
        </div>
        <Toaster theme="dark" position="top-center" />
      </body>
    </html>
  );
}
