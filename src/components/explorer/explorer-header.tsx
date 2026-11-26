"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

import { NavLinks } from "@/components/explorer/nav-links";
import { Wordmark } from "@/components/explorer/brand";

/**
 * Four destinations, in the order a newcomer needs them. The intelligence
 * network (miners, intents, evaluators, validators) and the applications built
 * on it (assurance, the activity ledger) live under one roof: one bar, one
 * scrollable sub-tab row — the rest of the product stays reachable in one tap.
 */
const AREAS = [
  { href: "/minds", label: "Minds" },
  {
    href: "/intelligence",
    label: "Intelligence",
    activeFor: ["/miners", "/intents", "/evaluators", "/validators", "/assurance", "/activity"],
  },
  { href: "/signals", label: "Signals" },
  { href: "/funds", label: "Wallet" },
];

/** What the Intelligence section contains, in the network's own words. Every
    tab is a page of its own, so no tab ever drops you on a header-less page. */
const INTELLIGENCE_TABS = [
  { href: "/miners", label: "Miners" },
  { href: "/intents", label: "Intents" },
  { href: "/evaluators", label: "Evaluators" },
  { href: "/validators", label: "Validators" },
  { href: "/assurance", label: "Assurance" },
  { href: "/activity", label: "Activity" },
];

const INTELLIGENCE_PATHS = ["/miners", "/intents", "/evaluators", "/validators", "/assurance", "/activity"];

export function ExplorerHeader() {
  const pathname = usePathname();

  // The front page is a front page: it opens with a headline, not a menu.
  if (pathname === "/") return null;

  const inIntelligence = INTELLIGENCE_PATHS.some((p) => pathname.startsWith(p));

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

      {/* Intelligence sub-tabs: the section's own contents, one quiet scrollable row. */}
      {inIntelligence && (
        <div className="border-t border-edge/70 bg-panel/50">
          <nav
            aria-label="Intelligence"
            className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-4 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
          >
            <NavLinks items={INTELLIGENCE_TABS} variant="tab" />
          </nav>
        </div>
      )}
    </header>
  );
}
