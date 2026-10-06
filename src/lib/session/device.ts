export interface DeviceInfo {
  label: string;
  webkit: boolean;
  ios: boolean;
  platform: string;
}

export function detectDevice(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): DeviceInfo {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|Android/.test(ua);
  let label = "Device";
  if (/iPhone/.test(ua)) label = "iPhone";
  else if (/iPad/.test(ua) || (ios && !/iPhone/.test(ua))) label = "iPad";
  else if (/Android/.test(ua)) label = "Android";
  else if (/Windows/.test(ua)) label = "Windows";
  else if (/Macintosh/.test(ua)) label = "Mac";
  else if (/Linux|CrOS/.test(ua)) label = "Linux";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : webkit ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return { label, webkit: webkit || ios, ios, platform: `${label} · ${browser}` };
}

/** Human-readable device name for the UI. */
export function friendlyDevice(label: string | null): string {
  if (!label || label === "Device") return "the other device";
  return label === "Windows" ? "Windows PC" : label;
}

/** Same, for the start of a sentence. Never "IPhone": only the generic fallback gets a capital. */
export function friendlyDeviceStart(label: string | null): string {
  const d = friendlyDevice(label);
  return d === "the other device" ? "The other device" : d;
}

export function supportsRequiredApis(): boolean {
  return (
    typeof window !== "undefined" &&
    "RTCPeerConnection" in window &&
    "ReadableStream" in window &&
    typeof Blob !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  );
}
