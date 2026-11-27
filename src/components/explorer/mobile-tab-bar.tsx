"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrainCircuit, FileSearch, Handshake, LayoutGrid, Wallet, type LucideIcon } from "lucide-react";

import { PRIMARY_NAV, navItemActive, type NavItem } from "@/lib/explorer/nav";

/**
 * The phone's map: the five primary destinations, driven by the one shared
 * navigation contract (src/lib/explorer/nav.ts) so the tab bar and the desktop
 * header can never drift apart. The header stays pinned to the top for
 * wayfinding and the global Ask action.
 */
const ICONS: Record<string, LucideIcon> = {
  "/overview": LayoutGrid,
  "/minds": BrainCircuit,
  "/investigations": FileSearch,
  "/buyer": Handshake,
  "/funds": Wallet,
};

function iconFor(item: NavItem): LucideIcon {
  return ICONS[item.href] ?? LayoutGrid;
}

export function MobileTabBar() {
  const pathname = usePathname();

  // The front page carries its own call to action, not a nav bar.
  if (pathname === "/") return null;

  return (
    <>
      {/* Keeps the last row of content clear of the fixed bar. */}
      <div aria-hidden className="h-[calc(4rem_+_env(safe-area-inset-bottom))] sm:hidden" />
      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-edge bg-night/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_30px_-24px_rgba(22,24,29,0.45)] backdrop-blur-md sm:hidden"
      >
        <div className="mx-auto flex max-w-md">
          {PRIMARY_NAV.map((item) => {
            const active = navItemActive(item, pathname);
            const Icon = iconFor(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-0.5 pb-1.5 pt-2 text-[10px] transition-colors active:bg-panel-3 ${
                  active ? "text-teal" : "text-ink-faint hover:text-ink"
                }`}
              >
                {active && (
                  <span aria-hidden className="absolute inset-x-0 top-0 mx-auto h-[2px] w-7 rounded-b-full bg-teal" />
                )}
                <Icon size={19} strokeWidth={active ? 2.1 : 1.6} aria-hidden />
                <span className={`w-full truncate text-center ${active ? "font-semibold" : "font-medium"}`}>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
