"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Explorer tabs. Client-side only for the active state: the current route is
 * marked with a real aria-current and a filled pill, so the primary navigation
 * reads as tabs instead of eight identical links.
 */
export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      {items.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={isActive(l.href) ? "page" : undefined}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] leading-5 transition-colors ${
            isActive(l.href)
              ? "bg-panel text-ink shadow-[0_1px_2px_rgba(22,24,29,0.08)] ring-1 ring-edge"
              : "text-ink-soft hover:bg-panel-3 hover:text-ink"
          }`}
        >
          {l.label}
        </Link>
      ))}
    </>
  );
}
