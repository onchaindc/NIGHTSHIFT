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
            <Link href="/terminal" className="btn-quiet !min-h-8 !px-3 !text-[12px] !text-amber">
              Terminal
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      {/* Footer is a colophon, not a second navigation bar: brand and what this
          deployment is, the protocol's real published surfaces, and the
          machine-readable endpoints this app actually exposes. */}
      <footer className="border-t border-edge bg-panel/50">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
          <div className="grid gap-8 sm:grid-cols-[1.5fr_1fr_1fr] sm:gap-10">
            <div>
              <p className="text-[13px] font-bold tracking-[0.22em] text-ink">NIGHTSHIFT</p>
              <p className="mt-3 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-soft">
                A clear view of the Telegraph network — who is on it, what they answer, and what an ask costs today.
                Every figure is read from the public registries; nothing is cached into a claim.
              </p>
              <p className="mt-4 inline-flex items-center gap-2">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />
                <span className="x-label">Registries read live</span>
              </p>
            </div>

            <div>
              <p className="x-label">Protocol</p>
              <ul className="mt-3 space-y-2.5 text-[12.5px]">
                <li>
                  <Ext href="https://docs.telegraphprotocol.com">Official documentation</Ext>
                </li>
                <li>
                  <Ext href="https://devnode.telegraphprotocol.com/engine/v1/intents">Node API · testnet</Ext>
                </li>
                <li>
                  <Ext href="https://devnode.telegraphprotocol.com/daemon/health">Daemon health</Ext>
                </li>
              </ul>
            </div>

            <div>
              <p className="x-label">Machine-readable</p>
              <ul className="mt-3 space-y-2.5 text-[12.5px]">
                <li>
                  <Ext href="/api/status">Integration & store status</Ext>
                </li>
                <li>
                  <Ext href="/api/network">Registry aggregates</Ext>
                </li>
                <li>
                  <Link href="/terminal" className="text-ink-soft underline-offset-4 transition-colors hover:text-amber hover:underline">
                    Run an ask in the Terminal
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-edge pt-5">
            <p className="x-tag">© 2026 NIGHTSHIFT</p>
            <p className="x-tag">PUBLIC TELEGRAPH REGISTRIES · NO OPERATOR DATA</p>
            <p className="x-tag sm:ml-auto">x402 SETTLEMENT · TESTNET</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
