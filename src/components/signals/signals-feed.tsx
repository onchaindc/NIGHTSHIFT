"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";

import type { SignalRow } from "@/lib/daemon/client";

const PAGE = 40;
type FeedStatus = "pending" | "ok" | "unavailable";
type WsStatus = "connecting" | "live" | "reconnecting" | "off";

function fmtUtc(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19).replace("T", " ") + " UTC";
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${M[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function friendlyIntent(intent: string | null): string {
  if (!intent) return "unrouted";
  return intent.toLowerCase().replaceAll("_general", "").replaceAll(/_/g, " ").trim();
}

function titleCase(s: string): string {
  return s ? s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()) : s;
}

function matches(r: SignalRow, qLower: string): boolean {
  if (!qLower) return true;
  return (
    r.text.toLowerCase().includes(qLower) ||
    r.source.toLowerCase().includes(qLower) ||
    r.category.toLowerCase().includes(qLower) ||
    (r.intent ?? "").toLowerCase().includes(qLower) ||
    (r.miner ?? "").toLowerCase().includes(qLower)
  );
}

/* ------------------------------------------------------------------ */
/* Live connection over the official Daemon WebSocket (anonymous)      */
/* ------------------------------------------------------------------ */

function useLiveWs(wsUrl: string) {
  const [status, setStatus] = useState<WsStatus>("connecting");
  useEffect(() => {
    if (!wsUrl) {
      setStatus("off");
      return;
    }
    let ws: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let unmounted = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (unmounted) return;
      setStatus("reconnecting");
      attempt += 1;
      retry = setTimeout(connect, Math.min(16_000, 1_000 * 2 ** Math.min(attempt, 4)));
    };

    const connect = () => {
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        // Anonymous connections may ping. Signal pushes require wallet
        // authentication with escrow and stay deliberately unused.
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: "ping" }));
        }, 25_000);
      };
      // Official protocol: match messages by their "type" field, never by
      // arrival order — the server greets unprompted on open.
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { type?: string };
          if (msg.type === "connected") {
            attempt = 0;
            setStatus("live");
          }
        } catch {
          /* non-JSON frames are ignored */
        }
      };
      ws.onerror = () => {
        /* the close handler decides the next step */
      };
      ws.onclose = () => {
        if (ping) clearInterval(ping);
        ping = null;
        if (!unmounted) scheduleReconnect();
      };
    };

    connect();
    return () => {
      unmounted = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      ws?.close();
    };
  }, [wsUrl]);
  return status;
}

/* ------------------------------------------------------------------ */

function WsBadge({ status }: { status: WsStatus }) {
  const map: Record<WsStatus, { label: string; cls: string; dot: string }> = {
    live: { label: "LIVE CONNECTION", cls: "text-teal border-teal/40", dot: "bg-teal" },
    connecting: { label: "CONNECTING", cls: "text-ink-faint border-edge", dot: "bg-ink-faint" },
    reconnecting: { label: "RECONNECTING", cls: "text-amber border-amber/40", dot: "bg-amber" },
    off: { label: "OFFLINE", cls: "text-ink-faint border-edge", dot: "bg-ink-faint" },
  };
  const s = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border bg-panel px-2.5 py-1 text-[11px] font-medium ${s.cls}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

const FEED_NOTES: Record<FeedStatus, string> = {
  pending: "Reading the Daemon feed…",
  ok: "Feed refreshed from the Daemon.",
  unavailable: "The Daemon feed could not be read. Retry in a moment.",
};

export function SignalsFeed({
  initialRows,
  initialTotal,
  wsUrl,
  categories,
  filters,
}: {
  initialRows: SignalRow[];
  initialTotal: number;
  wsUrl: string;
  categories: { category: string; count: number }[];
  filters: { type: string; category: string; hours: string };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [feed, setFeed] = useState<FeedStatus>("ok");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [q, setQ] = useState("");
  const wsStatus = useLiveWs(wsUrl);

  const filterQs = useCallback(() => {
    const qs = new URLSearchParams();
    if (filters.type) qs.set("type", filters.type);
    if (filters.category) qs.set("category", filters.category);
    if (filters.hours) qs.set("hours", filters.hours);
    qs.set("limit", String(PAGE));
    return qs.toString();
  }, [filters]);

  const mergeResults = useCallback((fresh: SignalRow[], feedTotal: number) => {
    setTotal(feedTotal);
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...fresh.filter((r) => !seen.has(r.id)), ...prev];
    });
  }, []);

  // Live updates: read the free feed every 30 s and prepend anything new.
  // The interval skips ticks while the tab is hidden and resumes by itself.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/daemon/signals?${filterQs()}`, { cache: "no-store" });
        const body = (await res.json()) as
          | { status: "ok"; payload: { results: SignalRow[]; total: number } }
          | { status: "unavailable" };
        if (!alive) return;
        if (body.status === "ok") {
          mergeResults(body.payload.results, body.payload.total);
          setFeed("ok");
        } else {
          setFeed("unavailable");
        }
      } catch {
        if (alive) setFeed("unavailable");
      }
    };
    const id = setInterval(tick, 30_000);
    tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [filterQs, mergeResults]);

  const loadOlder = async () => {
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/daemon/signals?${filterQs()}&offset=${rows.length}`, { cache: "no-store" });
      const body = (await res.json()) as
        | { status: "ok"; payload: { results: SignalRow[]; total: number } }
        | { status: "unavailable" };
      if (body.status === "ok") {
        setTotal(body.payload.total);
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...body.payload.results.filter((r) => !seen.has(r.id))];
        });
        setFeed("ok");
      } else {
        setFeed("unavailable");
      }
    } catch {
      setFeed("unavailable");
    } finally {
      setLoadingOlder(false);
    }
  };

  const setFilter = (key: "type" | "category" | "hours", value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push({ pathname: "/signals", query: Object.fromEntries(next) } as never);
  };

  const qLower = q.trim().toLowerCase();
  const visible = rows.filter((r) => matches(r, qLower));
  const hasMore = rows.length < Math.min(total, 200);

  return (
    <div>
      {/* Connection + refresh state */}
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2">
        <WsBadge status={wsStatus} />
        <p className="text-[12px] text-ink-faint" role="status" aria-live="polite">
          {FEED_NOTES[feed]}
        </p>
      </div>

      {/* Filters */}
      <form className="mt-6 flex flex-wrap items-center gap-2" role="search" aria-label="Signal filters" onSubmit={(e) => e.preventDefault()}>
        <div className="relative">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search loaded signals…"
            aria-label="Search signals"
            className="min-h-10 w-[13.5rem] rounded-lg border border-edge bg-panel pl-9 pr-3 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal sm:w-64"
          />
        </div>
        <Select label="Source" value={filters.type} onChange={(v) => setFilter("type", v)} width="w-28">
          <option value="">All</option>
          <option value="daemon">Daemon</option>
          <option value="direct">Direct</option>
        </Select>
        <Select label="Category" value={filters.category} onChange={(v) => setFilter("category", v)} width="w-44">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.category} value={c.category.toLowerCase()}>
              {titleCase(c.category)} · {c.count.toLocaleString()}
            </option>
          ))}
        </Select>
        <Select label="Window" value={filters.hours} onChange={(v) => setFilter("hours", v)} width="w-32">
          <option value="">All time</option>
          <option value="24">Last 24 h</option>
          <option value="168">Last 7 d</option>
        </Select>
      </form>

      {/* Search meta */}
      {qLower && (
        <p className="x-label mt-3">
          SEARCH: “{q.trim()}” · {visible.length} OF {rows.length} LOADED MATCH{visible.length === 1 ? "" : "ES"}
          <button type="button" onClick={() => setQ("")} className="ml-3 underline decoration-dotted hover:text-amber">
            clear
          </button>
        </p>
      )}
      {qLower && visible.length === 0 && rows.length > 0 && (
        <div className="mt-6 rounded-lg border border-edge bg-panel p-8">
          <p className="x-tag">NO MATCHES</p>
          <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
            Nothing among the loaded signals matches. Search covers what this page has read, not the full archive of
            {" "}{total.toLocaleString()} signals.
          </p>
        </div>
      )}

      {/* Feed */}
      {rows.length === 0 && feed !== "unavailable" ? (
        <div className="mt-6 rounded-lg border border-edge bg-panel p-8">
          <p className="x-tag">FEED EMPTY</p>
          <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
            The Daemon has not produced signals matching these filters yet. It works in batches on its own schedule,
            so an empty feed is not an outage.
          </p>
        </div>
      ) : (
        feed === "unavailable" && rows.length === 0 ? (
          <div className="mt-6 rounded-lg border border-edge bg-panel p-8">
            <p className="x-tag">FEED UNAVAILABLE</p>
            <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
              The feed could not be read just now. New attempts run every 30 seconds.
            </p>
          </div>
        ) : (
          <ul className="mt-6 divide-y divide-edge border-y border-edge">
            {visible.map((r) => (
              <li key={r.id} className="rise-in-item">
                <Link href={`/signals/${r.hash}`} className="group block px-1 py-4 transition-colors sm:px-2 sm:hover:rounded-lg sm:hover:bg-panel">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="rounded-full border border-edge bg-panel px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-soft">
                      {r.kind}
                    </span>
                    {r.status !== "success" && (
                      <span className="rounded-full border border-amber/40 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-amber">
                        {r.status}
                      </span>
                    )}
                    <span className="text-[13px] font-medium text-teal underline-offset-4 group-hover:underline">
                      {friendlyIntent(r.intent)}
                    </span>
                    {r.category && <span className="text-[12px] text-ink-faint">{titleCase(r.category)}</span>}
                    <span className="tabular ml-auto shrink-0 text-[11.5px] text-ink-faint">{fmtUtc(r.at)}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[14px] leading-snug text-ink">
                    {r.text || "Signal with an empty question text."}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[11.5px] text-ink-faint">
                    <span>
                      Source: <span className="text-ink-soft">{r.source}</span>
                    </span>
                    {r.miner && (
                      <span>
                        Miner: <span className="text-ink-soft">{r.miner}</span>
                      </span>
                    )}
                    <span>
                      Hash: <span className="tabular text-ink-soft">{r.hash.slice(0, 10)}…{r.hash.slice(-6)}</span>
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )
      )}

      {/* Older entries */}
      {rows.length > 0 && (
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <p className="x-label">
            SHOWING {rows.length.toLocaleString()} OF {total.toLocaleString()} SIGNALS{qLower ? " · SEARCH SCOPE: LOADED" : ""}
          </p>
          {hasMore ? (
            <button type="button" onClick={loadOlder} disabled={loadingOlder} className="btn-quiet !min-h-9 disabled:opacity-50">
              {loadingOlder ? "Loading…" : "Load older"}
            </button>
          ) : (
            <p className="text-[12px] text-ink-faint">Reached the explorer&apos;s read limit — narrow with filters.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
  width,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  width: string;
}) {
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${width} min-h-10 appearance-none rounded-lg border border-edge bg-panel pl-3.5 pr-9 text-[12.5px] text-ink outline-none transition-colors focus:border-teal`}
      >
        {children}
      </select>
      <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-3 text-ink-faint" />
    </label>
  );
}
