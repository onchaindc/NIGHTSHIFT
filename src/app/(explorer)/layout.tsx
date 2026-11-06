import type { Metadata } from "next";
import Link from "next/link";

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
            <Link href="/terminal" className="btn-quiet !min-h-8 !px-3 !text-[12px] !text-amber">
              Terminal
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-edge">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-3 px-4 py-6 sm:px-6">
          <p className="x-tag">NIGHTSHIFT · TELEGRAPH NETWORK EXPLORER</p>
          {/* Seven links cannot sit on one phone row: they wrap instead of widening the page. */}
          <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 sm:ml-auto sm:w-auto">
            <NavLinks items={NAV.slice(1)} variant="footer" />
          </div>
        </div>
      </footer>
    </div>
  );
}
