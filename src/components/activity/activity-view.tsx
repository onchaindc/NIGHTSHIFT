"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReceiptText, Search, X } from "lucide-react";

import type { TaskRecord } from "@/lib/engine/types";
import { isTestRun, money, StatusChip, timeOf } from "@/components/taskParts";

/**
 * Activity (Phase 5): the workspace's recorded requests, newest first, with
 * what each one cost and how it ended. Reads the SAME task records every
 * other surface uses (GET /api/tasks, unchanged contract) and links each row
 * to an /activity/[id] detail page. Nothing is invented here: every count,
 * spend and receipt comes from a persisted record.
 */

type StatusFilter = "all" | "completed" | "failed" | "running" | "awaiting" | "rejected" | "test";
type IntentFilter = "all" | "information" | "preparation" | "execution";
type DateFilter = "all" | "24h" | "7d" | "30d";

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed or blocked" },
  { id: "running", label: "In progress" },
  { id: "awaiting", label: "Needs approval" },
  { id: "rejected", label: "Rejected" },
  { id: "test", label: "Test runs" },
];

const INTENT_LABELS: Record<Exclude<IntentFilter, "all">, string> = {
  information: "Information",
  preparation: "Preparation",
  execution: "Execution",
};

const DATE_FILTERS: Array<{ id: DateFilter; label: string; ms: number }> = [
  { id: "all", label: "All time", ms: 0 },
  { id: "24h", label: "Last 24 h", ms: 24 * 3_600_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 3_600_000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 24 * 3_600_000 },
];

function stateFor(t: TaskRecord) {
  return t.state === "failed" || t.state === "blocked"
    ? "failed"
    : t.state === "awaiting_approval"
      ? "awaiting"
      : t.state === "planning" || t.state === "executing" || t.state === "verifying" || t.state === "created"
        ? "running"
        : t.state;
}

function inWindow(t: TaskRecord, f: DateFilter, now: number) {
  const ms = DATE_FILTERS.find((d) => d.id === f)?.ms ?? 0;
  return ms === 0 || now - t.createdAt <= ms;
}

export default function ActivityView({ persistenceMode }: { persistenceMode: string }) {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [intent, setIntent] = useState<IntentFilter>("all");
  const [date, setDate] = useState<DateFilter>("all");
  const [query, setQuery] = useState("");
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
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const real = (tasks ?? []).filter((t) => !isTestRun(t));
  const testRuns = (tasks ?? []).filter(isTestRun);
  const total = tasks?.length ?? 0;

  // Overview: truth from the records only. Test runs are excluded from the
  // business counts (they are labeled and kept separately, like History does).
  const spentReal = real.reduce((acc, t) => acc + t.spend.spentUsdCents, 0);
  const receiptCount = real.reduce((acc, t) => acc + (t.spend.entries?.length ?? 0), 0);
  const outcomeText =
    [
      `${real.filter((t) => t.state === "completed").length} completed`,
      `${real.filter((t) => stateFor(t) === "failed").length} failed/blocked`,
      `${real.filter((t) => stateFor(t) === "running").length} in progress`,
      `${real.filter((t) => stateFor(t) === "awaiting").length} awaiting approval`,
    ].join(" · ") || "nothing recorded yet";

  const now = Date.now();
  const q = query.trim().toLowerCase();
  const textMatches = (t: TaskRecord) =>
    q === "" ||
    t.goal.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q) ||
    (t.result?.summary ?? "").toLowerCase().includes(q);
  const intentMatches = (t: TaskRecord) => intent === "all" || (t.criteria.goalIntent ?? "?") === intent;

  const filtered = [...real, ...testRuns]
    .filter((t) => (status === "all" ? true : status === "test" ? isTestRun(t) : !isTestRun(t) && stateFor(t) === status))
    .filter(intentMatches)
    .filter((t) => inWindow(t, date, now))
    .filter(textMatches)
    .sort((a, b) => b.createdAt - a.createdAt);

  const looking = q !== "" || status !== "all" || intent !== "all" || date !== "all";

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <p className="x-tag">CONSOLE · ACTIVITY</p>
      <h1 className="x-display-1 mt-3 text-ink">Activity centre</h1>
      {persistenceMode === "ephemeral" ? (
        <p className="mt-3 max-w-[70ch] rounded-lg border border-amber/40 bg-amber/5 px-4 py-3 text-[13px] leading-relaxed text-amber">
          This deployment has no durable database, so records live in a per-instance /tmp directory. What you see is
          real activity from this instance only, and it does not survive restarts or cold starts.
        </p>
      ) : null}

      {/* Overview */}
      <section className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-y border-edge py-5" aria-label="Activity overview">
        <Stat label="REQUESTS" value={real.length.toLocaleString()} />
        <Stat label="OUTCOMES" value={outcomeText} wide />
        <Stat label="SPENT (PAID STEPS)" value={money(spentReal)} />
        <Stat label="RECEIPTS ON FILE" value={receiptCount.toLocaleString()} />
      </section>

      {/* Search + filters */}
      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full max-w-md">
          <Search size={14} strokeWidth={1.8} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by request text, id or result"
            aria-label="Search activity"
            className="min-h-10 w-full rounded-md border border-edge bg-panel-2 pl-9 pr-9 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
          />
          {q !== "" && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-ink-faint transition-colors hover:text-ink"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          <FilterGroup label="Status" value={status} options={STATUS_FILTERS.map((s) => ({ id: s.id, label: s.label, count: countFor(s.id) }))} onChange={(v) => setStatus(v as StatusFilter)} />
          <FilterGroup
            label="Intent"
            value={intent}
            options={(["all", "information", "preparation", "execution"] as const).map((id) => ({
              id,
              label: id === "all" ? "All intents" : INTENT_LABELS[id],
              count: (tasks ?? []).filter((t) => t.criteria.goalIntent === id).length,
            }))}
            onChange={(v) => setIntent(v as IntentFilter)}
          />
          <FilterGroup label="Window" value={date} options={DATE_FILTERS.map((d) => ({ id: d.id, label: d.label, count: 0 }))} onChange={(v) => setDate(v as DateFilter)} />
        </div>
      </div>

      {tasks === null && !loadFailed && (
        <div aria-live="polite" className="mt-8 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-md bg-panel-2 motion-safe:animate-pulse" />
          ))}
          <p className="pt-2 text-[13px] text-ink-faint">Loading activity…</p>
        </div>
      )}

      {loadFailed && (
        <p aria-live="assertive" className="mt-8 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          The activity store could not be read. This is not an empty history; the view keeps retrying every few
          seconds.
        </p>
      )}

      {tasks !== null && !loadFailed && total === 0 && (
        <div className="mt-8 rounded-lg border border-dashed border-edge bg-panel/40 px-6 py-12 text-center">
          <p className="mx-auto max-w-md text-[13.5px] leading-relaxed text-ink-soft">
            Nothing has been recorded yet. Console operations and watch checks are recorded here with their payments
            and outcomes; interactive Terminal requests run in their session and only become part of this history when
            they are carried out as console tasks.
          </p>
          <Link href="/terminal" className="btn-quiet mt-5 !min-h-9">
            Open the Terminal
          </Link>
        </div>
      )}

      {tasks !== null && !loadFailed && total > 0 && filtered.length === 0 && (
        <p className="mt-8 rounded-lg border border-dashed border-edge bg-panel/40 px-5 py-8 text-center text-[13.5px] text-ink-soft">
          No records match {q !== "" ? <>the search <span className="tabular text-ink">“{query.trim()}”</span></> : "these filters"}.
        </p>
      )}

      {/* History, newest first */}
      {filtered.length > 0 && (
        <section className="mt-8" aria-label="Request history">
          <p className="x-label">REQUEST HISTORY · {looking ? `${filtered.length} match` : "newest first"}</p>
          <div className="x-rule mb-0 mt-1" />
          {filtered.map((t) => (
            <Link
              key={t.id}
              href={`/activity/${t.id}`}
              className="history-row group grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-edge px-1 py-3.5 transition-colors hover:bg-panel sm:grid-cols-[150px_minmax(0,1fr)_auto_auto] sm:gap-x-5"
            >
              <StatusChip state={t.state} />
              <span className="min-w-0">
                <span className={`${isTestRun(t) ? "text-ink-soft" : "text-ink"} block truncate text-[13.5px] transition group-hover:text-amber`}>{t.goal}</span>
                {t.criteria.goalIntent ? (
                  <span className="block text-[11px] text-ink-faint">{INTENT_LABELS[t.criteria.goalIntent]}</span>
                ) : t.terminal?.intent ? (
                  <span className="block text-[11px] text-ink-faint">terminal ask · {t.terminal.intent.toLowerCase()}</span>
                ) : null}
              </span>
              <span className="hidden items-baseline gap-3 tabular text-[11px] text-ink-faint sm:flex">
                {(t.spend.entries?.length ?? 0) > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <ReceiptText size={11} strokeWidth={1.8} aria-hidden />
                    {t.spend.entries.length}
                  </span>
                )}
                <span>{t.spend.spentUsdCents > 0 ? `${money(t.spend.spentUsdCents)} spent` : "no spend"}</span>
              </span>
              <span className="tabular text-[11px] text-ink-faint">{timeOf(t.createdAt)}</span>
            </Link>
          ))}
        </section>
      )}
    </div>
  );

  function countFor(f: StatusFilter) {
    return (tasks ?? []).filter((t) =>
      f === "all" ? true : f === "test" ? isTestRun(t) : !isTestRun(t) && stateFor(t) === f,
    ).length;
  }
}

function Stat({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div>
      <p className="x-label">{label}</p>
      <p className={`${wide ? "max-w-[42ch] text-[13px]" : "text-[19px] font-semibold"} mt-1 tabular leading-snug text-ink`}>{value}</p>
    </div>
  );
}

function FilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string; count?: number }>;
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="x-label !mt-0">{label}</span>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-8 appearance-none rounded-md border border-edge bg-panel-2 px-2 py-1 text-[12px] text-ink focus:border-amber/50 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {typeof o.count === "number" && o.count > 0 ? ` (${o.count})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
