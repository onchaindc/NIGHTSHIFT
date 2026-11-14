"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { NavLinks } from "@/components/explorer/nav-links";

/** The product's areas, in the order a newcomer needs them. */
const AREAS = [
  { href: "/", label: "Explorer", activeFor: ["/", "/miners", "/intents", "/evaluators", "/validators"] },
  { href: "/watch", label: "Watch" },
  { href: "/signals", label: "Signals" },
  { href: "/activity", label: "Activity" },
  { href: "/developers", label: "Developers" },
];

/** What the Explorer contains, said without the protocol's own words. */
const EXPLORER_TABS = [
  { href: "/", label: "Overview" },
  { href: "/miners", label: "Answer services" },
  { href: "/intents", label: "Question types" },
  { href: "/evaluators", label: "Quality" },
  { href: "/validators", label: "Validators" },
];

const EXPLORER_PATHS = ["/miners", "/intents", "/evaluators", "/validators"];

export function ExplorerHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // The front page is a front page: it opens with a headline, not a menu.
  if (pathname === "/") return null;

  const inExplorer = EXPLORER_PATHS.some((p) => pathname.startsWith(p));

  return (
    <header className="sticky top-0 z-40 max-h-dvh overflow-y-auto border-b border-edge bg-night/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="text-[13px] font-bold tracking-[0.22em] text-ink">
          NIGHTSHIFT
        </Link>
        <span aria-hidden className="hidden h-3.5 w-px bg-edge-strong sm:block" />

        {/* Desktop: the areas, inline. */}
        <nav aria-label="Primary" className="order-3 hidden min-w-0 flex-wrap gap-1 sm:order-2 sm:flex">
          <NavLinks items={AREAS} />
        </nav>

        <div className="ml-auto order-2 flex items-center gap-2 sm:order-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded-full border border-edge px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:text-ink sm:hidden"
          >
            {open ? "Close" : "Menu"}
          </button>
          <Link href="/terminal" className="btn-primary !min-h-9 !px-4 !text-[12.5px]">
            Ask
          </Link>
        </div>

        {/* Mobile: one disclosed panel instead of two wrapped rows of links. */}
        {open && (
          <nav aria-label="Menu" className="order-4 w-full space-y-3 border-t border-edge pt-3 sm:hidden">
            <div className="flex flex-wrap gap-1">
              <NavLinks items={AREAS} />
            </div>
            {inExplorer && (
              <div className="flex flex-wrap gap-1">
                <NavLinks items={EXPLORER_TABS} />
              </div>
            )}
          </nav>
        )}
      </div>

      {/* Explorer sub-tabs: the section's own contents, on every page of it. */}
      {inExplorer && (
        <div className="hidden border-t border-edge/70 sm:block">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 py-1.5 sm:px-6">
            <NavLinks items={EXPLORER_TABS} />
          </div>
        </div>
      )}
    </header>
  );
}
