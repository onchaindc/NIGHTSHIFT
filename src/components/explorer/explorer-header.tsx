"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

import { NavLinks } from "@/components/explorer/nav-links";
import { Wordmark } from "@/components/explorer/brand";
import { PRIMARY_NAV, SECONDARY_NAV, navItemActive } from "@/lib/explorer/nav";

/**
 * Five primary destinations, named the way a customer names them: Overview,
 * Minds, Investigations (Deal Desk + Assurance), Buyer Desk, Wallet. The
 * Network catalog and its family stay reachable as the quiet secondary link in
 * the right cluster — it lands on the Network section of Minds, not on a
 * competing tab row.
 */
export function ExplorerHeader() {
  const pathname = usePathname();

  // The front page is a front page: it opens with a headline, not a menu.
  if (pathname === "/") return null;

  return (
    /* Opaque on purpose: translucent headers let scrolling text bleed through
       on mobile, which read as broken rendering. */
    <header className="sticky top-0 z-40 border-b border-edge bg-night">
      <div className="mx-auto grid h-14 max-w-6xl grid-cols-[1fr_auto] items-center gap-3 px-4 sm:grid-cols-[auto_1fr_auto] sm:gap-4 sm:px-6">
        <div className="justify-self-start">
          <Wordmark hideTextBelow="lg" />
        </div>

        <nav aria-label="Primary" className="hidden min-w-0 items-center gap-0.5 justify-self-center sm:flex md:gap-1">
          <NavLinks items={PRIMARY_NAV} />
        </nav>

        <div className="flex items-center gap-2 justify-self-end">
          {SECONDARY_NAV.map((item) => {
            const active = navItemActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`items-center whitespace-nowrap text-[12px] transition-colors max-md:hidden md:inline-flex ${
                  active ? "font-semibold text-ink" : "text-ink-faint hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
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
    </header>
  );
}
