import { detectDevice } from "./device";

/**
 * What this browser can do. Never shown to the user: it only decides which
 * experience to offer (folder saving vs. download, wake lock vs. a "keep Safari
 * open" reminder, and so on).
 */
export interface Capabilities {
  webrtc: boolean;
  folderWrite: boolean;
  wakeLock: boolean;
  /** iPhone/iPad Safari: the strictest lifecycle, so it gets the clearest guidance. */
  ios: boolean;
  /** Name of the browser to use in "Keep ___ open". */
  browserName: string;
}

export function detectCapabilities(): Capabilities {
  if (typeof window === "undefined") {
    return { webrtc: false, folderWrite: false, wakeLock: false, ios: false, browserName: "this page" };
  }
  const d = detectDevice();
  return {
    webrtc: "RTCPeerConnection" in window,
    folderWrite: "showDirectoryPicker" in window,
    wakeLock: "wakeLock" in navigator && window.isSecureContext,
    ios: d.ios,
    browserName: d.ios ? "Safari" : "this page",
  };
}
