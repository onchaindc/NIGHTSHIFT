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
    <footer className="border-t border-edge bg-panel/40">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid gap-9 sm:grid-cols-[1.25fr_0.75fr_0.75fr] sm:gap-10">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-[30ch] text-[12.5px] leading-relaxed text-ink-soft">
              The public view of Telegraph. Browse who answers, see the price, and verify the settlement behind each
              answer.
            </p>
            <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-edge bg-panel px-3 py-1.5 text-[11px] text-ink-faint">
              <span aria-hidden className="size-1.5 rounded-full bg-teal" />
              Sepolia testnet
            </p>
          </div>

          <nav aria-label="Product">
            <p className="x-label">Product</p>
            <ul className="mt-3 space-y-2.5 text-[12.5px]">
              <li>
                <Ref href="/terminal">Ask the network</Ref>
              </li>
              <li>
                <Ref href="/miners">Miner catalog</Ref>
              </li>
              <li>
                <Ref href="/signals">Signals</Ref>
              </li>
              <li>
                <Ref href="/activity">Your activity</Ref>
              </li>
            </ul>
          </nav>

          <nav aria-label="Network">
            <p className="x-label">Network</p>
            <ul className="mt-3 space-y-2.5 text-[12.5px]">
              <li>
                <Ref href="/intents">Intents</Ref>
              </li>
              <li>
                <Ref href="/validators">Validators</Ref>
              </li>
              <li>
                <Ref href="/developers">Developers</Ref>
              </li>
              <li>
                <Ref href="https://docs.telegraphprotocol.com">Documentation</Ref>
              </li>
              <li>
                <Ref href="/api/status">Status API</Ref>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-9 flex flex-col gap-2 border-t border-edge pt-5 text-[11.5px] text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 NIGHTSHIFT</p>
          <p>Built on Telegraph · x402 settlement</p>
        </div>
      </div>
    </footer>
  );
}
