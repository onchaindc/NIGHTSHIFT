/**
 * One navigation contract for every chrome that renders primary or secondary
 * destinations (desktop header, mobile tab bar). Defined once so the two
 * surfaces can never drift into separate navigation systems.
 *
 * Five primary destinations:
 *   Overview · Minds · Investigations · Buyer Desk · Wallet
 *
 * `Investigations` is the umbrella for the two clearly distinct workspaces,
 * Deal Desk (/desk) and Assurance (/assurance). `Network` (the Telegraph
 * catalog and its family) is a secondary destination: its directories live as
 * a clearly marked section of Minds (/minds#network) and the header keeps a
 * quiet link into that section — never a primary tab.
 */
export type NavItem = {
  href: string;
  label: string;
  /** Extra path prefixes this item is the active tab for. */
  activeFor?: string[];
};

export const PRIMARY_NAV: NavItem[] = [
  { href: "/overview", label: "Overview" },
  { href: "/minds", label: "Minds" },
  {
    href: "/investigations",
    label: "Investigations",
    activeFor: ["/investigations", "/desk", "/assurance"],
  },
  { href: "/buyer", label: "Buyer Desk" },
  { href: "/funds", label: "Wallet" },
];

/** The six network directories that make up the Network family. */
export const NETWORK_DIRECTORIES: NavItem[] = [
  { href: "/miners", label: "Miners" },
  { href: "/intents", label: "Intents" },
  { href: "/validators", label: "Validators" },
  { href: "/evaluators", label: "Evaluators" },
  { href: "/signals", label: "Signals" },
  { href: "/developers", label: "Developers" },
];

export const SECONDARY_NAV: NavItem[] = [
  {
    href: "/minds#network",
    label: "Network",
    activeFor: NETWORK_DIRECTORIES.map((d) => d.href),
  },
];

/** Active-tab matching shared by every nav consumer. The landing page "/" is
 *  reachable through the wordmark; Overview is its own destination. */
export function navItemActive(item: NavItem, pathname: string): boolean {
  return (item.activeFor ?? [item.href]).some((href) => (href === "/" ? pathname === "/" : pathname.startsWith(href)));
}
