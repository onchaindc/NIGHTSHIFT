"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Compass,
  Menu,
  Radar,
  ShieldCheck,
  Settings as SettingsIcon,
  Terminal,
  History as HistoryIcon,
  X,
} from "lucide-react";

/**
 * Operations console shell. Desktop: branded left sidebar with six named
 * destinations and a truthful status block. Mobile: compact top bar with a
 * navigation drawer. Header carries the current context and one primary
 * action. No footer navigation.
 */

const NAV = [
  { href: "/console", label: "Overview", icon: Compass },
  { href: "/operations", label: "Operations", icon: Terminal },
  { href: "/watch", label: "Protocol Watch", icon: Radar },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/history", label: "History", icon: HistoryIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

interface StatusBody {
  ok: boolean;
  store: "ok" | "unavailable";
  services: { telegraph: boolean; telegram: boolean; chainRpc: boolean };
}

function useSystemStatus() {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const body = (await res.json()) as StatusBody;
        if (!cancelled) {
          setStatus(body);
          setDown(false);
        }
      } catch {
        if (!cancelled) setDown(true);
      }
    }
    void poll();
    const id = setInterval(poll, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return { status, down };
}

type SystemState = {
  label: string;
  tone: string;
  dot: string;
  note: string;
};

function systemState(status: StatusBody | null, down: boolean): SystemState {
  if (down) return { label: "API unreachable", tone: "text-risk", dot: "bg-risk", note: "Retrying every minute" };
  if (!status) return { label: "Checking", tone: "text-ink-faint", dot: "bg-ink-faint", note: "…" };
  const core = status.store === "ok" && status.services.telegraph;
  if (core) return { label: "Operational", tone: "text-teal", dot: "bg-teal", note: "Store and integrations reachable" };
  if (status.store === "ok") return { label: "Degraded", tone: "text-amber", dot: "bg-amber", note: "An integration is unconfigured" };
  return { label: "Store unavailable", tone: "text-risk", dot: "bg-risk", note: "The task store is unreachable" };
}

/** Contextual header: section label on the left, one primary action on the right. */
const CONTEXT: Record<string, string> = {
  "/console": "Overview",
  "/operations": "Operations",
  "/watch": "Protocol Watch",
  "/approvals": "Approvals",
  "/history": "History",
  "/settings": "Settings",
  "/agents": "Agents",
};

function contextLabel(pathname: string): string {
  const normalized = "/" + pathname.split("/").slice(1).join("/");
  if (CONTEXT[normalized]) return CONTEXT[normalized];
  if (normalized.startsWith("/tasks/")) return CONTEXT["operations"];
  return CONTEXT["/console"];
}

function NavLink({ href, label, icon: Icon, active, onClick }: {
  href: string;
  label: string;
  icon: typeof Compass;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`group flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] transition-colors ${
        active
          ? "bg-panel-3 text-ink"
          : "text-ink-faint hover:bg-panel-2 hover:text-ink"
      }`}
    >
      <span
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border transition-colors ${
          active
            ? "border-amber/50 bg-amber/10 text-amber"
            : "border-edge bg-panel-2 text-ink-faint group-hover:text-ink-soft"
        }`}
        aria-hidden
      >
        <Icon size={14} strokeWidth={1.8} />
      </span>
      {label}
      {active && <span aria-hidden className="ml-auto h-4 w-[2px] rounded-full bg-amber" />}
    </Link>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { status, down } = useSystemStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isActive = (href: string) => (href === "/console" ? pathname === "/console" : pathname.startsWith(href));
  const state = systemState(status, down);

  // The drawer is a real navigation state, not decoration: route changes close it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-edge bg-panel lg:flex">
        <div className="flex items-center gap-3 px-5 pb-6 pt-6">
          <Link href="/" aria-label="NIGHTSHIFT overview" className="group flex items-center gap-3">
            <span aria-hidden className="grid h-9 w-9 place-items-center rounded-lg border border-amber/40 bg-amber/10">
              <Terminal size={15} strokeWidth={2} className="text-amber" />
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-[13.5px] font-bold tracking-[0.18em] text-ink">NIGHTSHIFT</span>
              <span className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.2em] text-ink-faint">
                by Pennywise
              </span>
            </span>
          </Link>
        </div>

        <nav aria-label="Main" className="flex-1 space-y-1 px-3">
          {NAV.map((n) => (
            <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} active={isActive(n.href)} />
          ))}
        </nav>

        <div className="px-5 pb-5 pt-2">
          <div className="x-rule mb-3" />
          <div className="flex items-start gap-2.5" title="Live status from the real task store and configured integrations">
            <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${state.dot}`} />
            <div className="min-w-0">
              <p className={`text-[12px] font-medium ${state.tone}`}>{state.label}</p>
              <p className="mt-0.5 text-[10.5px] leading-snug text-ink-faint">{state.note}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Content column */}
      <div className="flex min-h-dvh flex-col lg:pl-[236px]">
        {/* Top bar: context + one primary action (desktop); brand + actions on mobile */}
        <header className="sticky top-0 z-30 border-b border-edge bg-night/85 backdrop-blur">
          <div className="flex min-h-[60px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              {/* Mobile: burger + wordmark. Desktop: section context. */}
              <button
                type="button"
                onClick={() => setDrawerOpen((v) => !v)}
                aria-expanded={drawerOpen}
                aria-controls="mobile-nav"
                aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-edge bg-panel-2 text-ink-soft transition-colors hover:text-ink lg:hidden"
              >
                {drawerOpen ? <X size={17} strokeWidth={1.8} /> : <Menu size={17} strokeWidth={1.8} />}
              </button>
              <Link
                href="/"
                aria-label="NIGHTSHIFT overview"
                className="shrink-0 text-[12.5px] font-bold tracking-[0.18em] text-ink lg:hidden"
              >
                NIGHTSHIFT
              </Link>
              <span aria-hidden className="hidden h-5 w-px bg-edge lg:block" />
              <div className="hidden min-w-0 items-baseline gap-3 lg:flex">
                <p className="truncate text-[14.5px] font-semibold tracking-tight text-ink">{contextLabel(pathname)}</p>
                <p className="truncate text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                  Autonomous intelligence operations
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {!drawerOpen && (
                <span className={`hidden items-center gap-2 text-[12px] lg:flex ${state.tone}`}>
                  <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${state.dot}`} />
                  {state.label}
                </span>
              )}
              {/* One primary action. Icon-only on small screens, icon + label from sm up.
                  (Responsive display lives on the inner nodes: the unlayered
                  .btn-primary display would override Tailwind's hidden/sm:inline-flex.) */}
              <Link
                href="/operations"
                aria-label="New operation"
                className="btn-primary max-lg:!min-h-10 max-lg:!px-3 !min-h-9"
              >
                <Terminal size={15} strokeWidth={2} aria-hidden className="sm:hidden" />
                <Terminal size={13} strokeWidth={2} aria-hidden className="hidden sm:block" />
                <span className="hidden sm:inline">New operation</span>
              </Link>
            </div>
          </div>

          {/* Mobile drawer */}
          <div
            id="mobile-nav"
            hidden={!drawerOpen}
            className="border-t border-edge bg-panel px-3 pb-4 pt-3 lg:hidden"
          >
            <nav aria-label="Main" className="space-y-1">
              {NAV.map((n) => (
                <NavLink
                  key={n.href}
                  href={n.href}
                  label={n.label}
                  icon={n.icon}
                  active={isActive(n.href)}
                  onClick={() => setDrawerOpen(false)}
                />
              ))}
            </nav>
            <div className="x-rule my-3" />
            <div className="flex items-center gap-2.5 px-1" title="Live status from the real task store and configured integrations">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
              <p className={`text-[12px] ${state.tone}`}>{state.label}</p>
              <p className="ml-auto text-right text-[10.5px] text-ink-faint">{state.note}</p>
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        {/* Minimal, single-line sign-off: not navigation */}
        <div className="border-t border-edge px-4 py-4 sm:px-6">
          <p className="mx-auto max-w-6xl text-center text-[10.5px] tracking-wide text-ink-faint">
            The same engine runs on Telegram as{" "}
            <a
              href="https://t.me/nightshiftagent_bot"
              className="underline decoration-edge underline-offset-2 transition-colors hover:text-ink-soft"
            >
              @nightshiftagent_bot
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
