"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

import { NavLinks } from "@/components/explorer/nav-links";
import { Wordmark } from "@/components/explorer/brand";

/** The product's areas, in the order a newcomer needs them. */
const AREAS = [
  { href: "/miners", label: "Explorer", activeFor: ["/miners", "/intents", "/evaluators", "/validators"] },
  { href: "/counterparty", label: "Intel" },
  { href: "/signals", label: "Signals" },
  { href: "/activity", label: "Activity" },
  { href: "/funds", label: "Wallet" },
  { href: "/developers", label: "Developers" },
];

/** What the Explorer contains, in the network's own words. Every tab is a
    page of its own, so no tab ever drops you on the header-less front page. */
const EXPLORER_TABS = [
  { href: "/miners", label: "Miners" },
  { href: "/intents", label: "Intents" },
  { href: "/evaluators", label: "Evaluators" },
  { href: "/validators", label: "Validators" },
];

const EXPLORER_PATHS = ["/miners", "/intents", "/evaluators", "/validators"];

export function ExplorerHeader() {
  const pathname = usePathname();

  // The front page is a front page: it opens with a headline, not a menu.
  if (pathname === "/") return null;

  const inExplorer = EXPLORER_PATHS.some((p) => pathname.startsWith(p));

  return (
    /* Keep the wayfinding and the Ask action available on every screen. The
       mobile tab bar owns the bottom edge; the header owns the top. */
    <header className="sticky top-0 z-40 border-b border-edge bg-night/90 backdrop-blur-md">
      <div className="mx-auto grid h-14 max-w-6xl grid-cols-[1fr_auto] items-center gap-4 px-4 sm:grid-cols-[1fr_auto_1fr] sm:px-6">
        <div className="justify-self-start">
          <Wordmark />
        </div>

        <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex sm:justify-self-center">
          <NavLinks items={AREAS} />
        </nav>

        <div className="flex items-center gap-2 justify-self-end">
          <ThemeToggle />
          <Link
            href="/terminal"
            aria-label="Ask the network"
            className="group inline-flex min-h-9 items-center gap-2 rounded-full bg-ink px-4 text-[12.5px] font-semibold text-night shadow-[0_1px_2px_rgba(22,24,29,0.18)] ring-1 ring-ink/10 transition-all duration-200 hover:-translate-y-px hover:shadow-[0_4px_14px_-4px_rgba(22,24,29,0.4)] active:translate-y-0"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-teal transition-colors group-hover:bg-amber" />
            Ask
            <ArrowRight
              size={13}
              aria-hidden
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>
        </div>
      </div>

      {/* Explorer sub-tabs: the section's own contents, one quiet scrollable row. */}
      {inExplorer && (
        <div className="border-t border-edge/70 bg-panel/50">
          <nav
            aria-label="Explorer"
            className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-4 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
          >
            <NavLinks items={EXPLORER_TABS} variant="tab" />
          </nav>
        </div>
      )}
    </header>
  );
}
