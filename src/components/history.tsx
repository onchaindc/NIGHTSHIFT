"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { TaskRecord } from "@/lib/engine/types";
import {
  StatusChip,
  isTestRun,
  money,
  timeOf,
} from "@/components/taskParts";

/**
 * History: every task this workspace has run, searchable and grouped by
 * status, with test records (created by the automated audit) separated and
 * labeled. Rows navigate to the task's own detail route. Polls the same task
 * API.
 */

type Filter = "all" | "completed" | "failed" | "rejected" | "test";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed or blocked" },
  { id: "rejected", label: "Rejected" },
  { id: "test", label: "Test runs" },
];

function matchesFilter(t: TaskRecord, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "completed":
      return t.state === "completed";
    case "failed":
      return t.state === "failed" || t.state === "blocked";
    case "rejected":
      return t.state === "rejected";
    case "test":
      return isTestRun(t);
  }
}

/** Records shown under the ordinary sections; test runs are handled separately. */
export default function HistoryView() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
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
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh]);

  const real = (tasks ?? []).filter((t) => !isTestRun(t));
  const testRuns = (tasks ?? []).filter(isTestRun);
  const q = query.trim().toLowerCase();
  const textMatches = (t: TaskRecord) =>
    q === "" ||
    t.goal.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q) ||
    (t.result?.summary ?? "").toLowerCase().includes(q);
  const countFor = (f: Filter) =>
    f === "all"
      ? real.filter(textMatches).length
      : f === "test"
        ? testRuns.filter(textMatches).length
        : real.filter((t) => matchesFilter(t, f) && textMatches(t)).length;
  const total = tasks?.length ?? 0;
  const searching = q !== "";

  const visibleGroups = useMemo(
    () =>
      (["all", "completed", "failed", "rejected"] as const)
        .filter((f) => countFor(f) > 0 && (filter === "all" || filter === f))
        .map((f) => ({
          id: f,
          label: f === "all" ? "All work" : f === "failed" ? "Failed or blocked" : f,
          rows: real.filter((t) => matchesFilter(t, f) && textMatches(t)),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, filter, q],
  );
  const visibleTests = testRuns.filter(textMatches);

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
      <div className="pt-8 sm:pt-10">
        <p className="x-label">The record of record</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink">History</h1>
        <p className="mt-2 max-w-[64ch] text-[13px] leading-relaxed text-ink-soft">
          Every task this workspace has run, newest first. Open one to see its timeline, spending, and recorded
          evidence.
        </p>
      </div>

      {/* Search + status filters */}
      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full max-w-md">
          <Search size={14} strokeWidth={1.8} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by goal, id or result text"
            aria-label="Search operations"
            className="min-h-10 w-full rounded-md border border-edge bg-panel-2 pl-9 pr-9 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
          />
          {searching && (
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

        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`min-h-10 rounded-md border px-3.5 py-2 text-[12.5px] transition-colors ${
                filter === f.id
                  ? "border-ink bg-ink font-medium text-night"
                  : "border-edge bg-panel-2 text-ink-soft hover:border-edge-strong hover:text-ink"
              }`}
            >
              {f.label}
              <span className={`ml-2 tabular text-[11px] ${filter === f.id ? "text-night/60" : "text-ink-faint"}`}>
                {countFor(f.id)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {tasks === null && !loadFailed && (
        <div aria-live="polite" className="mt-6 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-md bg-panel-2 motion-safe:animate-pulse" />
          ))}
          <p className="pt-2 text-[13px] text-ink-faint">Loading…</p>
        </div>
      )}

      {tasks !== null && loadFailed && (
        <p aria-live="assertive" className="mt-6 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not load the task list. It keeps retrying every few seconds.
        </p>
      )}

      {tasks !== null && !loadFailed && total === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-edge bg-panel/40 px-6 py-12 text-center">
          <p className="mx-auto max-w-sm text-[13.5px] leading-relaxed text-ink-soft">
            No tasks yet. Hand off a goal and its progress will show up here.
          </p>
          <Link href="/operations" className="btn-primary mt-5">
            Launch an operation
          </Link>
        </div>
      )}

      {tasks !== null && !loadFailed && total > 0 && visibleGroups.length === 0 && visibleTests.length === 0 && (
        <p className="mt-8 rounded-lg border border-dashed border-edge bg-panel/40 px-5 py-8 text-center text-[13.5px] text-ink-soft">
          No tasks match {searching ? <>the search <span className="tabular text-ink">“{query.trim()}”</span></> : "this filter"}.
        </p>
      )}

      {tasks !== null && !loadFailed && (
        <section className="mt-6" aria-label="Work">
          {visibleGroups.map(({ id, label, rows }) => (
            <div key={id} className="mb-8">
              <p className="x-label mb-1">
                {label}
                <span className="ml-2 font-mono text-[11px] tracking-normal">{rows.length}</span>
              </p>
              <div className="x-rule mb-1" />
              {rows.map((t) => (
                <Link
                  key={t.id}
                  href={`/tasks/${t.id}`}
                  className="history-row group grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-edge px-1 py-3.5 transition-colors hover:bg-panel sm:grid-cols-[150px_minmax(0,1fr)_auto_auto] sm:gap-x-5"
                >
                  <StatusChip state={t.state} />
                  <span className="truncate text-[13.5px] text-ink transition group-hover:text-amber">{t.goal}</span>
                  <span className="hidden tabular text-[11px] text-ink-faint sm:block">
                    {t.spend.spentUsdCents > 0 ? `${money(t.spend.spentUsdCents)} spent` : "no spend"}
                  </span>
                  <span className="tabular text-[11px] text-ink-faint">{timeOf(t.createdAt)}</span>
                </Link>
              ))}
            </div>
          ))}

          {filter === "test" && (
            <div>
              <p className="x-label mb-1">Test runs</p>
              <p className="mb-4 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-faint">
                These tasks were created by the automated interaction audit, not by a person. They are kept because they
                are real records, but they are labeled and separated. Nothing was spent on any of them.
              </p>
              <div className="x-rule mb-1" />
              {visibleTests.length === 0 ? (
                <p className="py-4 text-[13px] text-ink-soft">No test runs recorded.</p>
              ) : (
                visibleTests.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tasks/${t.id}`}
                    className="history-row group grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-edge px-1 py-3.5 transition-colors hover:bg-panel sm:grid-cols-[150px_minmax(0,1fr)_auto_auto] sm:gap-x-5"
                  >
                    <StatusChip state={t.state} />
                    <span className="truncate text-[13.5px] text-ink-soft transition group-hover:text-amber">{t.goal}</span>
                    <span className="hidden tabular text-[11px] text-ink-faint sm:block">test run</span>
                    <span className="tabular text-[11px] text-ink-faint">{timeOf(t.createdAt)}</span>
                  </Link>
                ))
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
