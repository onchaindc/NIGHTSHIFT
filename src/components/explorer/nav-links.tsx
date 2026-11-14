"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation links. Client-side only for the active state: the current route is
 * marked with a real aria-current, so the navigation reads as tabs instead of a
 * row of identical links.
 *
 * `area` is the product's top level, set in a raised tab so "you are here" is
 * legible at a glance. `tab` is the Explorer's own contents, drawn as a lighter
 * underlined row so the two levels never look like one long menu.
 */
export function NavLinks({
  items,
  variant = "area",
}: {
  items: { href: string; label: string; activeFor?: string[] }[];
  variant?: "area" | "tab";
}) {
  const pathname = usePathname();

  const isActive = (item: { href: string; activeFor?: string[] }) =>
    (item.activeFor ?? [item.href]).some((href) =>
      href === "/" ? pathname === "/" : pathname.startsWith(href),
    );

  return (
    <>
      {items.map((l) => {
        const active = isActive(l);
        const className =
          variant === "tab"
            ? `-mb-px whitespace-nowrap border-b-2 px-0.5 pb-3 pt-3 text-[12.5px] transition-colors ${
                active
                  ? "border-teal font-semibold text-ink"
                  : "border-transparent text-ink-soft hover:border-edge-strong hover:text-ink"
              }`
            : `rounded-lg px-3 py-1.5 text-[13px] transition-all duration-150 ${
                active
                  ? "bg-panel font-medium text-ink shadow-[0_1px_2px_rgba(22,24,29,0.06)] ring-1 ring-edge"
                  : "text-ink-soft hover:bg-panel-3 hover:text-ink"
              }`;

        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={className}
          >
            {l.label}
          </Link>
        );
      })}
    </>
  );
}
