"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "lucide-react";

import { Wordmark } from "@/components/explorer/brand";

/** A reference that leaves the app gets an arrow; an internal page does not. */
function Ref({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  const className =
    "inline-flex items-center gap-1 text-ink-soft underline-offset-4 transition-colors hover:text-ink hover:underline";
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <ArrowUpRight size={11} aria-hidden className="shrink-0 text-ink-faint" />
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

/**
 * The front page's closing band. Inside the app this is not rendered: the
 * bottom tab bar already sits at the end of every page, and a second row of
 * navigation directly above it read as clutter rather than as a footer.
 */
export function SiteFooter() {
  const pathname = usePathname();
  if (pathname !== "/") return null;

  return (
    <footer className="border-t border-edge bg-panel/50">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-7 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <Wordmark />
          <p className="text-[11.5px] text-ink-faint sm:hidden">© 2026 NIGHTSHIFT</p>
        </div>

        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] sm:ml-auto"
        >
          <Ref href="https://docs.telegraphprotocol.com">Documentation</Ref>
          <Ref href="/api/status">Status API</Ref>
          <Ref href="/developers">Developers</Ref>
          <Ref href="/terminal">Terminal</Ref>
        </nav>

        <p className="hidden text-[11.5px] text-ink-faint sm:block">© 2026 NIGHTSHIFT</p>
      </div>
    </footer>
  );
}
