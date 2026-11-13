"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NavLinks } from "@/components/explorer/nav-links";

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

/**
 * The explorer's navigation bar, mounted on every page except the front page.
 * The front page is a front page: it opens the product with a headline and two
 * actions instead of a menu, so the bar is deliberately absent there.
 */
export function ExplorerHeader() {
  const pathname = usePathname();
  if (pathname === "/") return null;

  return (
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
  );
}
