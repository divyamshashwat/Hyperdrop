import Link from "next/link";

const link =
  "relative py-3 text-[15px] text-muted-foreground transition-colors duration-200 hover:text-foreground after:absolute after:inset-x-0 after:bottom-2 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 hover:after:scale-x-100";

export function SiteHeader() {
  return (
    <header className="relative z-20 flex h-14 items-center justify-between px-6 sm:h-20 sm:px-10">
      <Link href="/" className="text-[17px] font-semibold tracking-[-0.03em] transition-opacity hover:opacity-70" aria-label="Origin, home">
        Origin
      </Link>
      <nav aria-label="Primary" className="flex items-center gap-6">
        <Link href="/how-it-works" className={link}>
          How it works
        </Link>
        <Link href="/privacy" className={link}>
          Privacy
        </Link>
      </nav>
    </header>
  );
}
