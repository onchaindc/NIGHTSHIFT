"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Command Center shell: minimal sidebar, header with NIGHTSHIFT branding +
 * PENNYWISE attribution + truthful system status, mobile top-tab navigation.
 * Every page of the app renders inside this shell.
 */

const NAV = [
  { href: "/", label: "Dashboard", icon: "▤" },
  { href: "/agents", label: "Agents", icon: "λ" },
  { href: "/operations", label: "Operations", icon: "◫" },
  { href: "/watch", label: "Watch", icon: "◉" },
  { href: "/approvals", label: "Approvals", icon: "✉" },
  { href: "/history", label: "History", icon: "⧖" },
  { href: "/settings", label: "Settings", icon: "$" },
];

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
    const id = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return { status, down };
}

function StatusPill({ status, down }: { status: StatusBody | null; down: boolean }) {
  let label = "Checking";
  let tone = "text-ink-faint";
  if (down) {
    label = "API unreachable";
    tone = "text-risk";
  } else if (status) {
    const core = status.store === "ok" && status.services.telegraph;
    if (core) {
      label = "Operational";
      tone = "text-teal";
    } else if (status.store === "ok") {
      label = "Degraded";
      tone = "text-gold";
    } else {
      label = "Store unavailable";
      tone = "text-risk";
    }
  }
  const dot = tone.replace("text-", "bg-");
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${tone}`} title="Live status from the real task store and configured integrations">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { status, down } = useSystemStatus();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[60px] flex-col items-center border-r border-edge bg-panel py-4 md:flex">
        <Link href="/" aria-label="NIGHTSHIFT dashboard" className="flex h-9 w-9 items-center justify-center rounded-md border border-edge bg-panel-2">
          <span aria-hidden className="tabular text-[14px] font-bold text-teal">N</span>
        </Link>
        <nav aria-label="Main" className="mt-8 flex flex-1 flex-col items-center gap-2">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? "page" : undefined}
              title={n.label}
              className={`min-h-11 min-w-11 rounded-md p-2.5 text-center text-[15px] transition-colors ${
                isActive(n.href)
                  ? "bg-panel-2 text-ink"
                  : "text-ink-faint hover:bg-panel-2 hover:text-ink"
              }`}
            >
              <span aria-hidden>{n.icon}</span>
              <span className="sr-only">{n.label}</span>
            </Link>
          ))}
        </nav>
      </aside>

      {/* Content column */}
      <div className="flex flex-1 flex-col md:pl-[60px]">
        <header className="sticky top-0 z-20 border-b border-edge bg-night/85 backdrop-blur">
          <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <Link href="/" className="flex h-8 w-8 items-center justify-center rounded-md border border-edge bg-panel md:hidden">
                <span aria-hidden className="tabular text-[12px] font-bold text-teal">N</span>
              </Link>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-tight">NIGHTSHIFT</span>
                  <span className="hidden rounded-sm border border-edge px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-ink-faint sm:inline">
                    by PENNYWISE
                  </span>
                </div>
              </div>
            </div>
            <StatusPill status={status} down={down} />
          </div>

          {/* Mobile navigation tabs */}
          <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(n.href) ? "page" : undefined}
                className={`shrink-0 rounded-sm px-3 py-1.5 text-[12.5px] transition-colors ${
                  isActive(n.href)
                    ? "bg-panel-2 font-medium text-ink"
                    : "text-ink-faint hover:text-ink"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-edge px-4 py-5 sm:px-6">
          <p className="mx-auto max-w-6xl text-[11px] leading-relaxed text-ink-faint">
            NIGHTSHIFT buys intelligence through the Telegraph network, verifies every outcome against independent
            evidence, and never spends beyond the ceiling you set. The same engine runs on Telegram as{" "}
            <a
              href="https://t.me/nightshiftagent_bot"
              className="text-ink-soft underline decoration-edge underline-offset-2 transition-colors hover:text-ink"
            >
              @nightshiftagent_bot
            </a>
            .
          </p>
        </footer>
      </div>
    </div>
  );
}
