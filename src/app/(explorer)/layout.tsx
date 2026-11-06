import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { NavLinks } from "@/components/explorer/nav-links";

export const metadata: Metadata = {
  title: {
    default: "NIGHTSHIFT Explorer",
    template: "%s · NIGHTSHIFT",
  },
  description:
    "A clear, real-time view of the Telegraph network: who the participants are, what they do, and how to engage with them.",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/miners", label: "Miners" },
  { href: "/evaluators", label: "Evaluators" },
  { href: "/validators", label: "Validators" },
  { href: "/intents", label: "Intents" },
  { href: "/signals", label: "Signals" },
  { href: "/activity", label: "Activity" },
  { href: "/developers", label: "Developers" },
];

/** Footer link: a plain reference, marked as leaving the app only when it does. */
function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="inline-flex items-center gap-1 text-ink-soft underline-offset-4 transition-colors hover:text-amber hover:underline"
    >
      {children}
      {external && <ArrowUpRight size={11} aria-hidden className="shrink-0 text-ink-faint" />}
    </a>
  );
}

export default function ExplorerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-night">
      <header className="sticky top-0 z-40 max-h-dvh overflow-y-auto border-b border-edge bg-night/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/" className="text-[13px] font-bold tracking-[0.22em] text-ink">
            NIGHTSHIFT
          </Link>
          <span aria-hidden className="hidden h-3.5 w-px bg-edge-strong sm:block" />
          {/* Mobile: the items WRAP into clean rows instead of scrolling sideways.
              No negative margins here: w-full plus -mx made every page 8px wider
              than the viewport, which is what pulled the layout left on phones. */}
          <nav aria-label="Primary" className="order-3 flex w-full min-w-0 flex-wrap gap-1 sm:order-2 sm:w-auto">
            <NavLinks items={NAV} />
          </nav>
          <div className="ml-auto order-2 sm:order-3">
            <Link href="/terminal" className="btn-primary !min-h-9 !px-4 !text-[12.5px]">
              Ask the network
            </Link>
          </div>
        </div>
      </header>
      <main className="x-page flex-1">{children}</main>
      {/* One slim band, the same on every page: brand, the few links worth
          repeating, and a live-data note. Anything longer competes with the
          page it sits under. */}
      <footer className="border-t border-edge bg-panel/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-4 px-4 py-7 sm:px-6">
          <div className="flex items-center gap-3">
            <p className="text-[12.5px] font-bold tracking-[0.2em] text-ink">NIGHTSHIFT</p>
            <span aria-hidden className="h-3 w-px bg-edge-strong" />
            <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-faint">
              <span aria-hidden className="x-live-dot h-1.5 w-1.5 rounded-full bg-teal" />
              Data read live
            </p>
          </div>

          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
            <Ext href="https://docs.telegraphprotocol.com">Documentation</Ext>
            <Link href="/developers" className="text-ink-soft underline-offset-4 transition-colors hover:text-amber hover:underline">
              Developers
            </Link>
            <Ext href="/api/status">Status API</Ext>
            <Link href="/terminal" className="text-ink-soft underline-offset-4 transition-colors hover:text-amber hover:underline">
              Terminal
            </Link>
          </nav>

          <p className="ml-auto text-[12px] text-ink-faint">© 2026 NIGHTSHIFT</p>
        </div>
      </footer>
    </div>
  );
}
