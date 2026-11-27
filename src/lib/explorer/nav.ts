/**
 * One navigation contract for every chrome that renders primary or secondary
 * destinations (desktop header, mobile tab bar). Defined once so the two
 * surfaces can never drift into separate navigation systems.
 *
 * Five primary destinations:
 *   Overview · Minds · Work · Buyer Desk · Wallet
 *
 * `Work` is the umbrella for the two clearly distinct workspaces, Deal Desk
 * (/desk) and Assurance (/assurance). `Network` (the Telegraph catalog and
 * its family) is a secondary destination: reachable from the header's quiet
 * link, never a primary tab.
 */
export type NavItem = {
  href: string;
  label: string;
  /** Extra path prefixes this item is the active tab for. */
  activeFor?: string[];
};

export const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/minds", label: "Minds" },
  { href: "/work", label: "Work", activeFor: ["/work", "/desk", "/assurance"] },
  { href: "/buyer", label: "Buyer Desk" },
  { href: "/funds", label: "Wallet" },
];

export const SECONDARY_NAV: NavItem[] = [
  {
    href: "/miners",
    label: "Network",
    activeFor: ["/miners", "/intents", "/evaluators", "/validators", "/signals", "/developers", "/activity", "/intelligence"],
  },
];

/** Active-tab matching shared by every nav consumer. "/" matches exactly. */
export function navItemActive(item: NavItem, pathname: string): boolean {
  return (item.activeFor ?? [item.href]).some((href) => (href === "/" ? pathname === "/" : pathname.startsWith(href)));
}
