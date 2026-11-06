import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: {
    default: "Telegraph Explorer",
    template: "%s · Telegraph",
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
];

export default function ExplorerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-night">
      <header className="sticky top-0 z-40 border-b border-edge bg-night/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/" className="text-[13px] font-bold tracking-[0.22em] text-ink">
            TELEGRAPH
          </Link>
          <span aria-hidden className="hidden h-3.5 w-px bg-edge-strong sm:block" />
          <nav aria-label="Primary" className="order-3 -mx-1.5 flex w-full gap-1 overflow-x-auto sm:order-2 sm:mx-0 sm:w-auto">
            {NAV.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-panel-3 hover:text-ink"
              >
                {l.label}
              </Link>
            ))}
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
          <p className="x-tag">TELEGRAPH · PUBLIC EXPLORER</p>
          <div className="ml-auto flex items-center gap-5">
            {NAV.slice(1).map((l) => (
              <Link key={l.href} href={l.href} className="text-[12px] text-ink-soft transition-colors hover:text-amber">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
