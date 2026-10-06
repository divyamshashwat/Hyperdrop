"use client";

import type { NearbyUi } from "@/hooks/use-nearby";
import { Dots, Lede, PrimaryButton, Screen, SecondaryButton, TextButton, Title } from "./ui";

/**
 * The phone's Nearby screen. Users never see the word "ultrasonic", a waveform,
 * a confidence number or a distance: only what is happening, in plain words.
 */
export function NearbyView({ state, onRetry, onClose }: { state: NearbyUi; onRetry: () => void; onClose: () => void }) {
  const s = state.status;
  const external = "externalMic" in state && state.externalMic;

  if (s === "starting" || s === "listening" || s === "signal" || s === "validating") {
    const heard = s === "signal" || s === "validating";
    return (
      <Screen
        label="Nearby"
        actions={
          <div className="flex justify-center gap-2">
            <TextButton onClick={onClose}>Use QR or a code</TextButton>
          </div>
        }
      >
        <Title>{heard ? "Device found." : "Bring your phone near the computer."}</Title>
        <Lede>
          {s === "starting" ? "Getting ready" : heard ? "Connecting" : "Listening"}
          <Dots />
        </Lede>
        {!heard && (
          <p className="t-small mt-8">
            On the computer, tap Start Nearby. The microphone is used only to find it. Nothing is recorded or sent.
          </p>
        )}
        {external && !heard && <p className="t-small mt-3">For Nearby, use the phone&apos;s built-in microphone, not headphones.</p>}
      </Screen>
    );
  }

  const copy: Record<string, { title: string; body: string; retry: boolean }> = {
    denied: {
      title: "Nearby needs the microphone.",
      body: "Allow microphone access for this site, then try again. It is only used to hear the nearby computer.",
      retry: true,
    },
    "no-mic": { title: "No microphone found.", body: "Nearby needs this device's microphone. Use the QR code or the six-digit code instead.", retry: false },
    "mic-busy": { title: "The microphone is busy.", body: "Another app is using it. Close it and try again, or use the QR code.", retry: true },
    timeout: {
      title: "Couldn't find the computer.",
      body: "Hold your phone close to it, and make sure it says Nearby is on.",
      retry: true,
    },
    error: { title: "Nearby didn't start.", body: "Try again, or use the QR code.", retry: true },
  };

  let c = copy[s] ?? copy.error;
  if (s === "unsupported") {
    const reason = "reason" in state ? state.reason : undefined;
    c = {
      title: "Nearby isn't available here.",
      body:
        reason === "insecure"
          ? "Nearby needs a secure (https) page to use the microphone. Scan the QR code on the computer with your camera instead."
          : reason === "filtered"
            ? "This browser filters out the frequencies Nearby uses. Scan the QR code on the computer instead."
            : "This browser can't hear the Nearby signal. Scan the QR code on the computer instead.",
      retry: false,
    };
  }

  return (
    <Screen
      label={c.title}
      actions={
        c.retry ? (
          <>
            <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
            <SecondaryButton onClick={onClose}>Use QR instead</SecondaryButton>
          </>
        ) : (
          <PrimaryButton onClick={onClose}>Use QR or a code</PrimaryButton>
        )
      }
    >
      <div role="alert">
        <Title>{c.title}</Title>
        <Lede>{c.body}</Lede>
      </div>
    </Screen>
  );
}
