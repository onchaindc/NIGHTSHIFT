"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionEvent, TaskRecord } from "@/lib/engine/types";
import {
  phaseState,
  StatusChip,
  clockOf,
  isLive,
  isOpen,
  isTestRun,
  money,
  FeedChip,
} from "@/components/taskParts";

/**
 * Command Center dashboard. Every number here is computed from the real task
 * store: active operations, pending approvals, actual spend recorded today,
 * completed tasks, and the live activity feed built from real task events.
 */

/* ------------------------------------------------------------------ */
/* Metric cards                                                        */
/* ------------------------------------------------------------------ */

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function Metrics({ tasks }: { tasks: TaskRecord[] }) {
  const real = tasks.filter((t) => !isTestRun(t));
  const active = real.filter((t) => isOpen(t.state)).length;
  const approvals = real.filter((t) => t.state === "awaiting_approval").length;
  const completed = real.filter((t) => t.state === "completed").length;
  const since = startOfToday();
  let spendToday = 0;
  for (const t of real) {
    if (t.state === "blocked") continue; // blocked tasks are never charged, by design
    for (const e of t.spend.entries) if (e.ts >= since) spendToday += e.amountUsdCents;
  }

  const cards = [
    { label: "Active operations", value: String(active), sub: "running or awaiting approval", href: "/operations" },
    { label: "Pending approvals", value: String(approvals), sub: approvals > 0 ? "needs your decision" : "nothing waiting", href: "/approvals", tone: approvals > 0 ? "text-gold" : "" },
    { label: "Spend today", value: money(spendToday), sub: "actual recorded amounts", href: "/history" },
    { label: "Completed tasks", value: String(completed), sub: "all verified, none assumed", href: "/history" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c) => (
        <Link
          key={c.label}
          href={c.href}
          className="group rounded-lg border border-edge bg-panel p-4 transition-colors hover:border-edge-strong"
        >
          <div className="flex items-start justify-between">
            <p className="x-label">{c.label}</p>
            <span aria-hidden className="text-ink-faint transition-colors group-hover:text-ink-soft">→</span>
          </div>
          <p className={`mt-2 tabular text-[26px] font-semibold leading-none ${c.tone ?? "text-ink"}`}>{c.value}</p>
          <p className="mt-1.5 text-[11.5px] text-ink-faint">{c.sub}</p>
        </Link>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Your Agents: capability, honestly                                   */
/* ------------------------------------------------------------------ */

const AGENTS = [
  {
    id: "research",
    name: "Research & Verify",
    blurb: "Pays for intelligence, then proves it: settlement on chain, ledger reconciliation, independent reads.",
    status: "available" as const,
  },
  {
    id: "code",
    name: "Code Agent",
    blurb: "Read/write repository work. Capability not implemented yet.",
    status: "planned" as const,
  },
  {
    id: "ops",
    name: "Ops Agent",
    blurb: "Deployments and infrastructure actions. Capability not implemented yet.",
    status: "planned" as const,
  },
  {
    id: "data",
    name: "Data Agent",
    blurb: "Analytics pipelines over real exports. Capability not implemented yet.",
    status: "planned" as const,
  },
];

function AgentCards() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {AGENTS.map((a) => (
        <div key={a.id} className="rounded-lg border border-edge bg-panel p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13.5px] font-semibold text-ink">{a.name}</h3>
            {a.status === "available" ? (
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-teal/40 bg-teal/10 px-2 py-0.5 text-[10.5px] font-medium text-teal">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />
                Available
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-faint">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                Planned
              </span>
            )}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{a.blurb}</p>
          {a.status === "available" ? (
            <Link href="/operations" className="mt-3 inline-flex min-h-8 items-center text-[11.5px] font-medium text-teal hover:underline underline-offset-2">
              Launch an operation →
            </Link>
          ) : (
            <p className="mt-3 text-[11.5px] text-ink-faint">Shown here only as planned. Never displayed as active.</p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Active operations + approval actions                                */
/* ------------------------------------------------------------------ */

function PhaseDots({ task }: { task: TaskRecord }) {
  const p = phaseState(task);
  const steps = [
    { label: "Plan", done: p.plan, live: p.plan && !p.buy && !p.stopped },
    { label: "Buy", done: p.paid, live: p.buy && !p.paid && !p.stopped },
    { label: "Verify", done: p.verified, live: p.paid && !p.verified && !p.stopped },
  ];
  return (
    <ol className="flex items-center gap-1.5" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5">
          {i > 0 && <span className="h-px w-4 bg-edge" aria-hidden />}
          <span
            className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[12px] ${
              s.live ? "font-medium text-ink" : s.done ? "text-ink-soft" : "text-ink-faint"
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                s.live ? "bg-teal motion-safe:animate-pulse" : s.done ? "bg-teal" : "bg-edge-strong"
              }`}
              aria-hidden
            />
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ApprovalActions({
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
  const awaiting = task.state === "awaiting_approval";
  if (!awaiting) return null;
  return (
    <div className="mt-3 rounded-md border border-gold/40 bg-gold/5 p-3">
      <p className="text-[12.5px] leading-relaxed text-gold">
        The plan is ready. Nothing has been spent yet. Approving lets it purchase within the ceiling and run the checks.
      </p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => onAction(task.id, "approve")}
          disabled={busy}
          className="min-h-10 flex-1 rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-night transition-colors hover:bg-ink/85 disabled:opacity-50 sm:flex-none sm:px-5"
        >
          {busy ? "Approving…" : "Approve and continue"}
        </button>
        <button
          type="button"
          onClick={() => onAction(task.id, "reject")}
          disabled={busy}
          className="min-h-10 rounded-md border border-edge bg-panel px-4 py-2 text-[13px] text-ink-soft transition-colors hover:border-risk/50 hover:text-risk disabled:opacity-50"
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
  const startedAt = task.createdAt;
  const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const elapsedLabel = elapsed < 120 ? `${elapsed}s elapsed` : `${Math.round(elapsed / 60)}m elapsed`;

  return (
    <article data-task-id={task.id} data-state={task.state} className="rounded-lg border border-edge bg-panel">
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
        <p className="text-[14px] font-medium leading-snug text-ink">{task.goal}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <PhaseDots task={task} />
          {spent > 0 && (
            <span className="tabular text-[11px] text-ink-faint">
              {money(spent)} of {money(limit)}
              <span className="ml-2 inline-block h-1 w-20 rounded-sm bg-edge align-middle">
                <span className="block h-full rounded-sm bg-teal" style={{ width: `${pct}%` }} />
              </span>
            </span>
          )}
        </div>
        {lastEvent && isLive(task.state) && (
          <p className="mt-2.5 text-[12.5px] leading-snug text-ink-soft">{lastEvent.message}</p>
        )}
        <ApprovalActions task={task} onAction={onAction} busy={busy} error={error} />
        <p className="mt-3 text-right">
          <Link href={`/tasks/${task.id}`} className="text-[12px] font-medium text-blue hover:underline underline-offset-2">
            Open operation →
          </Link>
        </p>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Live activity feed                                                  */
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
      <div className="rounded-lg border border-edge bg-panel px-5 py-8 text-center">
        <p className="mx-auto max-w-sm text-[13px] text-ink-soft">
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
          <tr className="border-b border-edge text-[10.5px] uppercase tracking-wider text-ink-faint">
            <th className="px-4 py-2.5 font-medium">Time</th>
            <th className="px-4 py-2.5 font-medium">Agent</th>
            <th className="px-4 py-2.5 font-medium">Message</th>
            <th className="px-4 py-2.5 text-right font-medium">Cost</th>
            <th className="px-4 py-2.5 font-medium">Type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.eventId} className="border-b border-edge/60 last:border-0 hover:bg-panel-2/60">
              <td className="px-4 py-2.5 tabular text-[11.5px] text-ink-faint">{clockOf(r.ts)}</td>
              <td className="px-4 py-2.5 tabular text-[11.5px] text-ink-soft">{r.agent}</td>
              <td className="max-w-[52ch] truncate px-4 py-2.5 text-[12.5px] text-ink" title={r.message}>
                <Link href={`/tasks/${r.taskId}`} className="transition-colors hover:text-teal">{r.message}</Link>
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
            <p className="mt-1 text-[12.5px] leading-snug text-ink">{r.message}</p>
            {r.cost != null && <p className="mt-0.5 tabular text-[11px] text-ink-soft">{money(r.cost)}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      if (res.ok) {
        setTasks(((await res.json()) as { tasks: TaskRecord[] }).tasks);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
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
        const text = action === "approve" ? "Could not approve the task: " : "Could not reject the task: ";
        setActionError((prev) => ({ ...prev, [id]: text + (body.error ?? `status ${res.status}`) }));
      }
    } catch (err) {
      const text = action === "approve" ? "Could not approve the task: " : "Could not reject the task: ";
      setActionError((prev) => ({ ...prev, [id]: text + (err instanceof Error ? err.message : String(err)) }));
    } finally {
      setActivating(null);
      void refresh();
    }
  }

  const real = (tasks ?? []).filter((t) => !isTestRun(t));
  const active = real.filter((t) => isOpen(t.state));

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Page head */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            Live view of every operation, drawn from the real task store. Nothing here is simulated.
          </p>
        </div>
        <Link
          href="/operations"
          className="inline-flex min-h-10 items-center rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-night transition-colors hover:bg-ink/85"
        >
          Launch Operation
        </Link>
      </div>

      {tasks !== null && loadFailed && (
        <p aria-live="assertive" role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not load the task list. The dashboard keeps retrying every few seconds.
        </p>
      )}

      {tasks === null && !loadFailed && (
        <div aria-live="polite" className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[104px] rounded-lg bg-panel-2 motion-safe:animate-pulse" />
          ))}
          <p className="col-span-full pt-2 text-[13px] text-ink-faint">Loading metrics…</p>
        </div>
      )}

      {tasks !== null && !loadFailed && (
        <div className="mt-5 space-y-7">
          <section aria-label="Metrics">
            <Metrics tasks={real} />
          </section>

          <section aria-label="Your Agents">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-[14px] font-semibold">Your Agents</h2>
              <Link href="/agents" className="text-[11.5px] font-medium text-blue hover:underline underline-offset-2">
                View all →
              </Link>
            </div>
            <AgentCards />
          </section>

          <section aria-label="Active operations">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-[14px] font-semibold">Active Operations</h2>
              <span className="tabular text-[11px] text-ink-faint">{active.length} running</span>
            </div>
            {active.length === 0 ? (
              <div className="rounded-lg border border-dashed border-edge bg-panel/50 px-5 py-8 text-center">
                <p className="mx-auto max-w-sm text-[13px] text-ink-soft">
                  Nothing is running right now. Launch an operation to see it here with live progress.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {active.map((t) => (
                  <ActiveOperation
                    key={t.id}
                    task={t}
                    onAction={act}
                    busy={activating === t.id}
                    error={actionError[t.id] ?? null}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-label="Live activity">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-[14px] font-semibold">Live Activity</h2>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-teal motion-safe:animate-pulse" />
                Live · refreshes every 2.5s
              </span>
            </div>
            <ActivityFeed tasks={tasks ?? []} loading={tasks === null} />
          </section>
        </div>
      )}
    </div>
  );
}
