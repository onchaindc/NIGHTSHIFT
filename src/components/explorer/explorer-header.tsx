"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

export function ExplorerHeader() {
  const pathname = usePathname();

  // The front page is a front page: it opens with a headline, not a menu.
  if (pathname === "/") return null;

  const inExplorer = EXPLORER_PATHS.some((p) => pathname.startsWith(p));

  return (
    /* Sticky only where there is room for it. On a phone the bar scrolls away
       and the persistent map is the bottom tab bar, so the page keeps its height. */
    <header className="z-40 border-b border-edge bg-night/95 backdrop-blur sm:sticky sm:top-0">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-5 px-4 sm:px-6">
        <Link href="/" className="text-[13px] font-bold tracking-[0.22em] text-ink">
          NIGHTSHIFT
        </Link>

        <nav aria-label="Primary" className="hidden min-w-0 items-center gap-1 sm:flex">
          <NavLinks items={AREAS} />
        </nav>

        <Link
          href="/terminal"
          className="btn-primary ml-auto !min-h-9 !px-4 !text-[12.5px]"
        >
          Ask
        </Link>
      </div>

      {/* Explorer sub-tabs: the section's own contents, one quiet scrollable row. */}
      {inExplorer && (
        <div className="border-t border-edge/70">
          <nav
            aria-label="Explorer"
            className="mx-auto flex max-w-6xl gap-5 overflow-x-auto px-4 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
          >
            <NavLinks items={EXPLORER_TABS} variant="tab" />
          </nav>
        </div>
      )}
    </header>
  );
}
