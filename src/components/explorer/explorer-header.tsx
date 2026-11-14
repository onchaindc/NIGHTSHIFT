"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { NavLinks } from "@/components/explorer/nav-links";

/** The product's areas, in the order a newcomer needs them. */
const AREAS = [
  { href: "/miners", label: "Explorer", activeFor: ["/miners", "/intents", "/evaluators", "/validators"] },
  { href: "/signals", label: "Signals" },
  { href: "/activity", label: "Activity" },
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

/** The mark: a moon in an ink tile. Small enough to read as a logo, not a badge. */
function Mark() {
  return (
    <span
      aria-hidden
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-ink text-night"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
    </span>
  );
}

export function ExplorerHeader() {
  const pathname = usePathname();

  // The front page is a front page: it opens with a headline, not a menu.
  if (pathname === "/") return null;

  const inExplorer = EXPLORER_PATHS.some((p) => pathname.startsWith(p));

  return (
    /* Sticky only where there is room for it. On a phone the bar scrolls away
       and the persistent map is the bottom tab bar, so the page keeps its height. */
    <header className="z-40 border-b border-edge bg-night/90 backdrop-blur-md sm:sticky sm:top-0">
      <div className="mx-auto grid h-14 max-w-6xl grid-cols-[1fr_auto] items-center gap-4 px-4 sm:grid-cols-[1fr_auto_1fr] sm:px-6">
        <Link href="/" aria-label="NIGHTSHIFT home" className="flex items-center gap-2.5 justify-self-start">
          <Mark />
          <span className="text-[12.5px] font-bold tracking-[0.22em] text-ink">NIGHTSHIFT</span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex sm:justify-self-center">
          <NavLinks items={AREAS} />
        </nav>

        <Link
          href="/terminal"
          className="btn-primary !min-h-9 !px-4 !text-[12.5px] justify-self-end"
        >
          Ask
          <ArrowRight size={13} aria-hidden />
        </Link>
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
