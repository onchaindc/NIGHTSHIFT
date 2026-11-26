"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

import { NavLinks } from "@/components/explorer/nav-links";
import { Wordmark } from "@/components/explorer/brand";

/**
 * Four destinations, named the way a customer names them: Minds (ask),
 * Network (who answers), Deal Desk (verify before you settle), Wallet.
 * No sub-tabs: every destination is one tap from anywhere, and the old
 * jargon strip (miners/intents/evaluators/validators/...) is gone.
 */
const AREAS = [
  { href: "/minds", label: "Minds" },
  {
    href: "/miners",
    label: "Network",
    activeFor: ["/miners", "/intents", "/evaluators", "/validators", "/signals", "/developers", "/activity", "/intelligence"],
  },
  { href: "/desk", label: "Deal Desk", activeFor: ["/desk", "/assurance"] },
  { href: "/funds", label: "Wallet" },
];

export function ExplorerHeader() {
  const pathname = usePathname();

  // The front page is a front page: it opens with a headline, not a menu.
  if (pathname === "/") return null;

  return (
    /* Opaque on purpose: translucent headers let scrolling text bleed through
       on mobile, which read as broken rendering. */
    <header className="sticky top-0 z-40 border-b border-edge bg-night">
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
    </header>
  );
}
