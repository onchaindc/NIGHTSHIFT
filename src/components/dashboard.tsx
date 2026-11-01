"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ChevronRight,
  Crosshair,
  Radar,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { ExecutionEvent, TaskRecord } from "@/lib/engine/types";
import {
  STATUS,
  StatusChip,
  clockOf,
  isLive,
  isOpen,
  isTestRun,
  money,
  FeedChip,
} from "@/components/taskParts";
import type { StatusBody } from "@/components/shell-types";
/**
 * Overview: the honest state of the system, drawn from real data only —
 * integration health from /api/status, live counts and spend from the task
 * store, watch coverage from the watch API, and an activity tape of real
 * events. No simulated numbers anywhere.
 */

/* ------------------------------------------------------------------ */
/* Metric tiles                                                        */
/* ------------------------------------------------------------------ */

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Metric {
  label: string;
  value: string;
  sub: string;
  href: string;
  tone?: string;
  icon: typeof ShieldCheck;
}

function buildMetrics(tasks: TaskRecord[], protocolWatch: number, watchAlerts: number): Metric[] {  const real = tasks.filter((t) => !isTestRun(t));
  const active = real.filter((t) => isOpen(t.state)).length;
  const approvals = real.filter((t) => t.state === "awaiting_approval").length;
  const since = startOfToday();
  let spendToday = 0;
  for (const t of real) {
    if (t.state === "blocked") continue; // blocked tasks are never charged, by design
    for (const e of t.spend.entries) if (e.ts >= since) spendToday += e.amountUsdCents;
  }
  return [
    {
      label: "Active operations",
      value: String(active),
      sub: "running or awaiting approval",
      href: "/operations",
      icon: Activity,
      tone: active > 0 ? "text-ink" : "text-ink-faint",
    },
    {
      label: "Pending approvals",
      value: String(approvals),
      sub: approvals > 0 ? "waiting on your decision" : "nothing waiting",
      href: "/approvals",
      tone: approvals > 0 ? "text-amber" : "text-ink-faint",
      icon: ShieldCheck,
    },
    {
      label: "Spend today",
      value: money(spendToday),
      sub: "recorded receipts only",
      href: "/history",
      icon: Wallet,
      tone: spendToday > 0 ? "text-amber" : "text-ink-faint",
    },
    {
      label: "Protocol Watch",
      value: String(watchAlerts),
      sub: protocolWatch === 0 ? "no watches configured" : `${protocolWatch} watch${protocolWatch === 1 ? "" : "es"} · ${watchAlerts} finding${watchAlerts === 1 ? "" : "s"}`,
      href: "/watch",
      icon: Radar,
      tone: watchAlerts > 0 ? "text-amber" : "text-ink-faint",
    },
  ];
}

function MetricCell({ m }: { m: Metric }) {
  return (
    <Link
      href={m.href}
      className={`group block px-5 py-5 transition-colors hover:bg-panel-2/60 ${
        m.tone?.startsWith("text-amber") ? "sm:border-l-2 sm:border-l-amber/60 sm:bg-amber/[0.03]" : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="x-label">{m.label}</p>
        {m.tone?.startsWith("text-amber") && (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
        )}
      </div>
      <p className={`mt-3 tabular text-[30px] font-semibold leading-none ${m.tone ?? "text-ink"}`}>{m.value}</p>
      <p className="mt-2 text-[11.5px] text-ink-faint">{m.sub}</p>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* System strip: real integration health from /api/status              */
/* ------------------------------------------------------------------ */

function SystemStrip({ status, down }: { status: StatusBody | null; down: boolean }) {
  const items = [
    { label: "Task store", ok: down ? null : status ? status.store === "ok" : null, detail: down ? "unreachable" : status ? (status.store === "ok" ? "reachable" : "unreachable") : "checking" },
    { label: "Telegraph (paid research)", ok: down ? null : status?.services.telegraph ?? null, detail: "paid intelligence network" },
    { label: "Telegram bot", ok: down ? null : status?.services.telegram ?? null, detail: "@nightshiftagent_bot" },
    { label: "Chain RPC", ok: down ? null : status?.services.chainRpc ?? null, detail: "read-only verification" },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-panel">
      <ul className="grid grid-cols-1 divide-y divide-edge sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        {items.map((s) => {
          const unknown = s.ok === null || s.ok === undefined;
          return (
            <li key={s.label} className="flex items-center gap-3 px-4 py-3">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  unknown ? "bg-ink-faint motion-safe:animate-pulse" : s.ok ? "bg-teal" : "bg-risk"
                }`}
              />
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-medium text-ink">{s.label}</p>
                <p className="truncate text-[10.5px] text-ink-faint">
                  {unknown ? "checking…" : s.ok ? s.detail : "not configured"}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Active operations with a real phase rail                            */
/* ------------------------------------------------------------------ */

function PhaseRail({ task }: { task: TaskRecord }) {
  const stopped = task.state === "failed" || task.state === "blocked" || task.state === "rejected";
  const p = { plan: task.events.some((e) => e.type === "plan_created"), buy: task.events.some((e) => e.type === "spend_recorded"), verify: task.events.some((e) => e.type === "verification_passed") };
  const steps = [
    { label: "Plan", done: p.plan, live: !p.plan && !p.buy && !stopped },
    { label: "Purchase", done: p.buy, live: p.plan && !p.buy && !stopped },
    { label: "Verify", done: p.verify, live: p.buy && !p.verify && !stopped, },
  ];
  return (
    <ol className="flex items-center gap-0" aria-label="Execution phases">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-stretch">
          {i > 0 && (
            <span
              aria-hidden
              className={`mx-2 self-center h-[2px] w-8 rounded-full ${s.live ? "rail-live bg-amber/20" : s.done ? "bg-teal/70" : "bg-edge"}`}
            />
          )}
          <span
            className={`rounded-sm px-2 py-0.5 text-[11.5px] ${
              s.live ? "font-medium text-amber" : s.done ? "text-ink-soft" : "text-ink-faint"
            }`}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ActiveOperation({
  task,
  onAction,
  busy,
  error,
}: {
  task: TaskRecord;
  onAction: (id: string, action: "approve" | "reject") => void;
  busy: boolean;
  error: string | null;
}) {
  const lastEvent = task.events[task.events.length - 1];
  const spent = task.spend.spentUsdCents;
  const limit = task.spend.limitUsdCents;
  const pct = Math.min(100, Math.round((spent / Math.max(limit, 1)) * 100));
  const elapsed = Math.max(1, Math.round((Date.now() - task.createdAt) / 1000));
  const elapsedLabel = elapsed < 120 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;

  return (
    <article data-task-id={task.id} data-state={task.state} className="rise-in rounded-lg border border-edge bg-panel transition-colors hover:border-edge-strong">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-edge px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip state={task.state} />
          {isTestRun(task) && (
            <span className="rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[11px] text-ink-faint">Test run</span>
          )}
        </div>
        <span className="tabular text-[11px] text-ink-faint">
          {task.origin.source === "telegram" ? "via Telegram" : "via web"} · {elapsedLabel}
        </span>
      </div>
      <div className="px-4 py-3.5">
        <Link href={`/tasks/${task.id}`} className="text-[14.5px] font-medium leading-snug text-ink transition-colors hover:text-amber">
          {task.goal}
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <PhaseRail task={task} />
          {spent > 0 && (
            <span className="tabular text-[11px] text-ink-faint">
              {money(spent)} of {money(limit)}
              <span className="ml-2 inline-block h-1 w-20 rounded-sm bg-edge align-middle">
                <span className="block h-full rounded-sm bg-amber" style={{ width: `${pct}%` }} />
              </span>
            </span>
          )}
        </div>
        {lastEvent && isLive(task.state) && (
          <p className="mt-2.5 line-clamp-2 text-[12.5px] leading-snug text-ink-soft">{lastEvent.message}</p>
        )}

        {task.state === "awaiting_approval" && (
          <div className="mt-3 rounded-lg border border-amber/40 bg-amber/5 p-3.5">
            <p className="text-[12.5px] leading-relaxed text-amber-soft">
              The plan is ready and nothing has been spent. Approving lets it purchase within the ceiling and run the checks.
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                onClick={() => onAction(task.id, "approve")}
                disabled={busy}
                className="btn-primary !min-h-9 !text-[12.5px] !px-4 disabled:opacity-50"
              >
                {busy ? "Approving…" : "Approve and continue"}
              </button>
              <button
                type="button"
                onClick={() => onAction(task.id, "reject")}
                disabled={busy}
                className="btn-quiet !min-h-9 !text-[12.5px] hover:border-risk/50 hover:text-risk disabled:opacity-50"
              >
                {busy ? "Working…" : "Reject"}
              </button>
            </div>
            {error && (
              <p role="alert" className="mt-2.5 rounded-md border border-risk/40 bg-risk/5 px-3 py-2 text-[12.5px] text-risk">
                {error}
              </p>
            )}
          </div>
        )}

        <p className="mt-3 text-right">
          <Link href={`/tasks/${task.id}`} className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-amber transition-colors hover:text-amber-soft">
            Open operation <ChevronRight size={12} aria-hidden />
          </Link>
        </p>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Live activity tape: real events, newest first                       */
/* ------------------------------------------------------------------ */

interface FeedRow {
  eventId: string;
  ts: number;
  agent: string;
  message: string;
  type: ExecutionEvent["type"];
  cost: number | null;
  taskId: string;
}

/** Agent attribution is derived from the task's real plan, never invented. */
function agentOf(t: TaskRecord): string {
  if ((t.plan ?? []).some((s) => s.kind === "telegraph_ask" || s.kind === "cross_check")) return "research";
  if (t.state === "verifying") return "research";
  if ((t.plan ?? []).some((s) => s.kind.startsWith("watch"))) return "watch";
  return "dispatch";
}

function ActivityFeed({ tasks, loading }: { tasks: TaskRecord[]; loading: boolean }) {
  const rows: FeedRow[] = tasks
    .filter((t) => !isTestRun(t))
    .flatMap((t) =>
      t.events.map((e) => ({
        eventId: e.id,
        ts: e.ts,
        agent: agentOf(t),
        message: e.message,
        type: e.type,
        cost: e.type === "spend_recorded" && typeof e.data?.amountUsdCents === "number" ? (e.data.amountUsdCents as number) : null,
        taskId: t.id,
      })),
    )
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-edge bg-panel/40 px-5 py-10 text-center">
        <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-ink-soft">
          {loading ? "Loading activity…" : "No activity yet. Launch an operation and every step, cost, and outcome will appear here as it happens."}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-panel">
      {/* Desktop table */}
      <table className="hidden w-full text-left md:table">
        <thead>
          <tr className="border-b border-edge">
            {["Time", "Agent", "Event", "Cost", "Kind"].map((h, i) => (
              <th
                key={h}
                className={`x-label px-4 py-2.5 ${i === 3 ? "text-right" : ""} ${i === 4 ? "" : "text-left"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.eventId} className="border-b border-edge/60 last:border-0 transition-colors hover:bg-panel-2/60">
              <td className="px-4 py-2.5 tabular text-[11.5px] text-ink-faint">{clockOf(r.ts)}</td>
              <td className="px-4 py-2.5 tabular text-[11.5px] text-ink-soft">{r.agent}</td>
              <td className="max-w-[52ch] truncate px-4 py-2.5 text-[12.5px]">
                <Link href={`/tasks/${r.taskId}`} className="text-ink transition-colors hover:text-amber" title={r.message}>
                  {r.message}
                </Link>
              </td>
              <td className="px-4 py-2.5 text-right tabular text-[11.5px] text-ink-soft">{r.cost != null ? money(r.cost) : ""}</td>
              <td className="px-4 py-2.5"><FeedChip type={r.type} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Mobile list */}
      <ul className="divide-y divide-edge md:hidden">
        {rows.map((r) => (
          <li key={r.eventId} className="px-4 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="tabular text-[11px] text-ink-faint">{clockOf(r.ts)} · {r.agent}</span>
              <FeedChip type={r.type} />
            </div>
            <Link href={`/tasks/${r.taskId}`} className="mt-1 block text-[12.5px] leading-snug text-ink">
              {r.message}
            </Link>
            {r.cost != null && <p className="mt-0.5 tabular text-[11px] text-ink-soft">{money(r.cost)}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Capability summary (detail lives on /agents, linked below)           */
/* ------------------------------------------------------------------ */

const CAPABILITIES = [
  { name: "Research & Verify", blurb: "Buys the best answer within your ceiling, then proves it against the chain.", status: "available" as const },
  { name: "Protocol Watch", blurb: "Monitors real protocol sources, detects changes, delivers verified alerts.", status: "available" as const },
  { name: "Code · Ops · Data", blurb: "Planned. Never displayed as active or simulated.", status: "planned" as const },
];

function CapabilityStrip() {
  return (
    <div className="overflow-hidden rounded-lg border border-edge">
      {CAPABILITIES.map((c, i) => (
        <div
          key={c.name}
          className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4 ${
            i > 0 ? "border-t border-edge" : ""
          } ${c.status === "planned" ? "bg-panel/40" : "bg-panel"}`}
        >
          <div className="flex min-w-[240px] flex-wrap items-center gap-3">
            <h3 className="text-[13.5px] font-semibold text-ink">{c.name}</h3>
            {c.status === "available" ? (
              <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-teal">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />
                Live
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-ink-faint">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                Planned
              </span>
            )}
          </div>
          <p className="max-w-[52ch] flex-1 text-[12.5px] leading-relaxed text-ink-soft">{c.blurb}</p>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Overview() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [statusDown, setStatusDown] = useState(false);
  const [watches, setWatches] = useState<number>(0);
  const [watchAlerts, setWatchAlerts] = useState<number>(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const [r, w] = await Promise.all([
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/watches", { cache: "no-store" }),
      ]);
      if (r.ok) {
        setTasks(((await r.json()) as { tasks: TaskRecord[] }).tasks);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
      if (w.ok) setWatches((((await w.json()) as { watches: Array<{ id: string }> }).watches ?? []).length);
    } catch {
      setLoadFailed(true);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const body = (await res.json()) as StatusBody;
        if (!cancelled) {
          setStatus(body);
          setStatusDown(false);
        }
      } catch {
        if (!cancelled) setStatusDown(true);
      }
    };
    void poll();
    const id = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Watch findings and alerts are counted from real task events: every
  // detected change is recorded as an event; a settled change carries
  // evidence in its task record. Only what the store shows is displayed.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/tasks", { cache: "no-store" });
        const body = (await res.json()) as { tasks: Array<{ events: Array<{ type: string }>; jobType?: string }> };
        if (cancelled) return;
        const events = body.tasks ?? [];
        const findings = events.reduce((n, t) => n + t.events.filter((e) => e.type === "watch_change_detected").length, 0);
        setWatchAlerts(findings);
      } catch {
        /* keep the previous count; the poll refreshes shortly */
      }
    }
    void load();
    const id = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function act(id: string, action: "approve" | "reject") {
    if (activating) return;
    setActivating(id);
    setActionError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(`/api/tasks/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError((prev) => ({
          ...prev,
          [id]: `Could not ${action} the task: ${body.error ?? `status ${res.status}`}`,
        }));
      }
    } catch (err) {
      setActionError((prev) => ({
        ...prev,
        [id]: `Could not ${action} the task: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setActivating(null);
      void refresh();
    }
  }

  const real = (tasks ?? []).filter((t) => !isTestRun(t));
  const active = real.filter((t) => isOpen(t.state));
  const metrics = buildMetrics(real, watches, watchAlerts);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      {/* Page head: editorial statement, no chrome */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="x-tag">NS-CNS/00 · WORKSPACE</p>
          <h1 className="x-display-1 mt-3 text-ink">Overview</h1>
          <p className="mt-3 max-w-[58ch] text-[13.5px] leading-relaxed text-ink-soft">
            The real state of this workspace: what is running, what is verified, and what it actually cost. Every number
            comes from the task store — nothing is estimated or simulated.
          </p>
        </div>
        <p className="x-tag hidden lg:block">DATED · {new Date().toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}</p>
      </div>

      {tasks !== null && loadFailed && (
        <p aria-live="assertive" role="alert" className="mt-6 rounded-lg border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not load the task list. The overview keeps retrying every few seconds.
        </p>
      )}

      {tasks === null && !loadFailed && (
        <div aria-live="polite" className="mt-8 grid gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[118px] bg-panel-2 motion-safe:animate-pulse" />
          ))}
        </div>
      )}

      {tasks !== null && !loadFailed && (
        <div className="mt-8 space-y-10">
          <section aria-label="Metrics">
            <div className="grid gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-2 xl:grid-cols-4">
              {metrics.map((m) => (
                <MetricCell key={m.label} m={m} />
              ))}
            </div>
          </section>

          {status !== null || statusDown ? (
            <section aria-label="Connected services">
              <div className="mb-3 flex items-baseline justify-between gap-2">
              <p className="x-label"><span className="text-amber">01</span> · CONNECTED SERVICES</p>
              </div>
              <SystemStrip status={status} down={statusDown} />
            </section>
          ) : null}

          <section aria-label="Active operations">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="x-label"><span className="text-amber">02</span> · ACTIVE OPERATIONS</h2>
              <span className="tabular text-[11px] text-ink-faint">{active.length} running</span>
            </div>
            {active.length === 0 ? (
              <div className="rounded-lg border border-dashed border-edge bg-panel/40 px-5 py-10 text-center">
                <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-ink-soft">
                  Nothing is running right now. Hand off a goal and it will appear here with live progress.
                </p>
                <Link href="/operations" className="btn-signal mt-5">
                  <Crosshair size={13} aria-hidden /> Launch an operation
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {active.slice(0, 4).map((t) => (
                  <ActiveOperation
                    key={t.id}
                    task={t}
                    onAction={act}
                    busy={activating === t.id}
                    error={actionError[t.id] ?? null}
                  />
                ))}
                {active.length > 4 && (
                  <p className="pt-1 text-right">
                    <Link href="/operations" className="inline-flex items-center gap-1 text-[12px] font-medium text-amber hover:text-amber-soft">
                      All {active.length} active operations <ChevronRight size={12} aria-hidden />
                    </Link>
                  </p>
                )}
              </div>
            )}
          </section>

          <section aria-label="Live activity">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="x-label"><span className="text-amber">03</span> · LIVE ACTIVITY</h2>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber motion-safe:animate-pulse" />
                refreshes every 2.5 s
              </span>
            </div>
            <ActivityFeed tasks={tasks ?? []} loading={tasks === null} />
          </section>

          <section aria-label="Capabilities">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="x-label"><span className="text-amber">04</span> · CAPABILITIES</h2>
          <Link href="/agents" className="inline-flex min-h-8 items-center gap-1 text-[11.5px] font-medium text-amber hover:text-amber-soft">
                Full capability matrix <ChevronRight size={12} aria-hidden />
              </Link>
            </div>
            <CapabilityStrip />
          </section>
        </div>
      )}
    </div>
  );
}
