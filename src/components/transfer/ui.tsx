"use client";

import { forwardRef, useState } from "react";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { friendlyDevice, friendlyDeviceStart } from "@/lib/session/device";
import type { Role, Route } from "@/lib/webrtc/connection-state";
import { cn } from "@/lib/utils";

/**
 * The building blocks of every screen. Phone first: content reads from the
 * top, the decision sits in a thumb-reach bar at the bottom. On wider screens
 * the same column simply centres itself.
 */
export function Screen({
  children,
  actions,
  label,
  align = "center",
  wide = false,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  label?: string;
  align?: "center" | "start" | "end";
  wide?: boolean;
}) {
  return (
    <section
      aria-label={label}
      className={cn("stage-in mx-auto flex w-full flex-1 flex-col sm:flex-none sm:py-16", wide ? "max-w-[660px]" : "max-w-[440px]")}
    >
      <div
        className={cn(
          "flex flex-1 flex-col px-6 pt-4 pb-6 sm:flex-none",
          align === "center" && "justify-center",
          align === "end" && "justify-end",
        )}
      >
        {children}
      </div>
      {actions && (
        <div className="sticky bottom-0 z-10 flex flex-col gap-2.5 bg-[linear-gradient(to_top,var(--background)_55%,transparent)] px-5 pt-8 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:static sm:bg-none sm:px-6 sm:pt-2">
          {actions}
        </div>
      )}
    </section>
  );
}

const press =
  "group relative h-14 w-full gap-2.5 rounded-[14px] text-[17px] font-medium tracking-[-0.012em] transition-[background-color,color,box-shadow,transform,opacity] duration-200 ease-[var(--ease-out)] active:scale-[0.985] disabled:opacity-35 [&_svg]:size-[18px]";

type ButtonProps = React.ComponentProps<typeof Button> & { arrow?: boolean };

/** The one decision on a screen. Warm white; on hover it brightens and a quiet halo appears. */
export const PrimaryButton = forwardRef<HTMLButtonElement, ButtonProps>(function PrimaryButton(
  { children, arrow = false, className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      className={cn(
        press,
        "bg-[#efeeea] text-[#0b0b0a] hover:bg-white hover:shadow-[0_0_0_6px_rgba(255,255,250,0.06)]",
        className,
      )}
      {...props}
    >
      {children}
      {arrow && <ArrowRight aria-hidden="true" className="-mr-1 transition-transform duration-200 ease-[var(--ease-out)] group-hover:translate-x-1" />}
    </Button>
  );
});

/** The alternative. A soft tonal surface, never an outline pill. */
export const SecondaryButton = forwardRef<HTMLButtonElement, ButtonProps>(function SecondaryButton(
  { children, className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      className={cn(press, "bg-white/[0.07] text-foreground hover:bg-white/[0.11] hover:text-foreground", className)}
      {...props}
    >
      {children}
    </Button>
  );
});

/** Low-stakes actions: plain text with an underline that draws in on hover. */
export const TextButton = forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(function TextButton(
  { children, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "relative inline-flex min-h-11 items-center justify-center px-3 text-[15px] text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-40",
        "after:absolute after:inset-x-3 after:bottom-2.5 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 after:ease-[var(--ease-out)] hover:after:scale-x-100",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export function Title({ children, as: As = "h2", className }: { children: React.ReactNode; as?: "h1" | "h2"; className?: string }) {
  return <As className={cn("t-title", className)}>{children}</As>;
}

export function Lede({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("t-lede mt-3", className)}>{children}</p>;
}

/** Quiet facts with a hairline check: used for verification and readiness, never as decoration. */
export function Facts({ items, className }: { items: Array<{ text: string; done?: boolean }>; className?: string }) {
  return (
    <ul className={cn("space-y-2", className)}>
      {items.map((i) => (
        <li key={i.text} className={cn("flex items-center gap-3 text-[15px] transition-colors duration-500", i.done === false ? "text-ink-3" : "text-muted-foreground")}>
          <Check aria-hidden="true" strokeWidth={2} className={cn("size-4 shrink-0 transition-opacity duration-500", i.done === false ? "opacity-25" : "opacity-90")} />
          {i.text}
          {i.done === false && <span className="sr-only">(in progress)</span>}
        </li>
      ))}
    </ul>
  );
}

/** Animated ellipsis for "in progress" text. No spinners. */
export function Dots() {
  return (
    <span aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="[animation:ellipsis_1.4s_infinite]" style={{ animationDelay: `${i * 0.18}s` }}>
          .
        </span>
      ))}
    </span>
  );
}

/**
 * Who you're connected to, in words. Tapping it explains the connection in plain
 * language. Direct and relayed are never conflated.
 */
export function StatusLine({
  route,
  peer,
  role,
  pending = false,
  className,
}: {
  route: Route;
  peer: string | null;
  role: Role;
  pending?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const who = friendlyDevice(peer);
  const main = pending
    ? `Connecting to ${who}`
    : role === "receiver"
      ? `${friendlyDeviceStart(peer)} is connected`
      : `Connected to ${who}`;
  const kind = pending ? null : route === "relayed" ? "relayed" : route === "direct" ? "direct" : null;
  const detail = pending
    ? "Setting up a direct connection in the background. You can keep going."
    : route === "relayed"
      ? "This connection is relayed through a server. Files are encrypted in transit, but it is not device-to-device."
      : "Device to device, encrypted in transit. Nothing is uploaded to our servers.";

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 min-h-11 px-1 text-left text-[15px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
      >
        <span className="text-foreground">{main}</span>
        {pending && <Dots />}
        {kind && <span> · {kind}</span>}
      </button>
      <p
        role="status"
        className={cn(
          "t-small grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-out)]",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <span className="overflow-hidden">{detail}</span>
      </p>
    </div>
  );
}

export function RelayNotice() {
  return (
    <p className="mt-4 flex gap-3 text-[14px] leading-relaxed text-muted-foreground">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      Relayed connection. Files stay encrypted in transit, but this transfer is no longer directly device-to-device.
    </p>
  );
}
