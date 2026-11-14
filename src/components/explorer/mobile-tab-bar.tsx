"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Code2, Compass, Radar, ReceiptText, type LucideIcon } from "lucide-react";

/**
 * The phone's map. The old header stacked the areas and the Explorer tabs on top
 * of the page; this puts the four areas within thumb reach and lets the header
 * scroll away, so only one bar ever costs vertical space.
 */
type Item = { href: string; label: string; icon: LucideIcon; activeFor?: string[] };

const ITEMS: Item[] = [
  { href: "/miners", label: "Explorer", icon: Compass, activeFor: ["/miners", "/intents", "/evaluators", "/validators"] },
  { href: "/signals", label: "Signals", icon: Radar },
  { href: "/activity", label: "Activity", icon: ReceiptText },
  { href: "/developers", label: "Developers", icon: Code2 },
];

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
          {ITEMS.map((item) => {
            const active = (item.activeFor ?? [item.href]).some((href) =>
              href === "/" ? pathname === "/" : pathname.startsWith(href),
            );
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 pb-1.5 pt-2 text-[10px] transition-colors active:bg-panel-3 ${
                  active ? "text-teal" : "text-ink-faint hover:text-ink"
                }`}
              >
                {active && (
                  <span aria-hidden className="absolute inset-x-0 top-0 mx-auto h-[2px] w-7 rounded-b-full bg-teal" />
                )}
                <Icon size={19} strokeWidth={active ? 2.1 : 1.6} aria-hidden />
                <span className={active ? "font-semibold" : "font-medium"}>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
