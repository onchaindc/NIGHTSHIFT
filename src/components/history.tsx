"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@/lib/engine/types";
import {

  StatusChip,
  isTestRun,
  money,
  timeOf,
} from "@/components/taskParts";

/**
 * Work History: every finished task as a compact row, grouped by status, with
 * test records (created by the automated audit) separated and labeled. Rows
 * navigate to the task's own detail route. Polls the same task API.
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
  const countFor = (f: Filter) =>
    f === "all" ? real.length : f === "test" ? testRuns.length : real.filter((t) => matchesFilter(t, f)).length;
  const total = tasks?.length ?? 0;

  return (
    <div>
      
      <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
        <div className="pt-10 sm:pt-14">
          <h1 className="text-[22px] font-semibold tracking-tight">Work history</h1>
          <p className="mt-2 max-w-[64ch] text-sm leading-relaxed text-ink-soft">
            Every task this workspace has run, newest first. Open one to see its timeline, spending, and recorded
            evidence.
          </p>
        </div>

        <div role="group" aria-label="Filter by status" className="mt-6 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`min-h-11 rounded-sm border px-3.5 py-2 text-[13px] transition-colors ${
                filter === f.id
                  ? "border-ink bg-ink font-medium text-background"
                  : "border-edge bg-panel-2 text-ink-soft hover:border-ink hover:text-ink"
              }`}
            >
              {f.label}
              <span className={`ml-2 tabular text-[11px] ${filter === f.id ? "text-background/70" : "text-ink-faint"}`}>
                {countFor(f.id)}
              </span>
            </button>
          ))}
        </div>

        {tasks === null && !loadFailed && (
          <div aria-live="polite" className="mt-6 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="history-row h-14 motion-safe:animate-pulse rounded-sm bg-panel-2" />
            ))}
            <p className="pt-2 text-[13px] text-ink-faint">Loading…</p>
          </div>
        )}

        {tasks !== null && loadFailed && (
          <p aria-live="assertive" className="mt-6 rounded-sm border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
            Could not load the task list. It keeps retrying every few seconds.
          </p>
        )}

        {tasks !== null && !loadFailed && total === 0 && (
          <div className="mt-6 rounded-sm border border-dashed border-edge px-6 py-12 text-center">
            <p className="mx-auto max-w-sm text-[13.5px] leading-relaxed text-ink-soft">
              No tasks yet. Hand off a goal from the workspace and its progress will show up here.
            </p>
            <Link
              href="/"
              className="mt-5 inline-flex min-h-11 items-center rounded-sm bg-ink px-5 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-ink-soft"
            >
              Go to the workspace
            </Link>
          </div>
        )}

        {tasks !== null && !loadFailed && filter !== "all" && filter !== "test" && countFor(filter) === 0 && (
          <p className="mt-6 text-[13.5px] text-ink-soft">No tasks match this filter yet.</p>
        )}

        {tasks !== null && !loadFailed && real.length > 0 && (
          <section className="mt-6" aria-label="Work">
            {["all", "completed", "failed", "rejected"]
              .filter((f) => countFor(f as Filter) > 0 && (filter === "all" || filter === (f as Filter)))
              .map((f) => {
                const group = real.filter((t) => matchesFilter(t, f as Filter));
                return (
                  <div key={f} className="mb-8">
                    <p className="x-label mb-1">
                      {f === "all" ? "All work" : f === "failed" ? "Failed or blocked" : f}
                      <span className="ml-2 font-mono text-[11px] normal-case tracking-normal">{group.length}</span>
                    </p>
                    <div className="x-rule mb-1" />
                    {group.map((t) => (
                      <Link
                        key={t.id}
                        href={`/tasks/${t.id}`}
                        className="history-row group grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-edge py-3.5 pr-1 transition-colors hover:bg-panel sm:grid-cols-[150px_minmax(0,1fr)_auto_auto] sm:gap-x-5"
                      >
                        <StatusChip state={t.state} />
                        <span className="truncate text-[13.5px] text-ink transition group-hover:text-accent">{t.goal}</span>
                        <span className="hidden tabular text-[11px] text-ink-faint sm:block">
                          {t.spend.spentUsdCents > 0 ? `${money(t.spend.spentUsdCents)} spent` : "no spend"}
                        </span>
                        <span className="tabular text-[11px] text-ink-faint">{timeOf(t.createdAt)}</span>
                      </Link>
                    ))}
                  </div>
                );
              })}
          </section>
        )}

        {filter === "test" && tasks !== null && !loadFailed && (
          <section className="mt-6" aria-label="Test runs">
            <p className="x-label mb-2">Test runs</p>
            <p className="mb-4 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-faint">
              These tasks were created by the automated interaction audit, not by a person. They are kept because they
              are real records, but they are labeled and separated. Nothing was spent on any of them.
            </p>
            <div className="x-rule mb-1" />
            {testRuns.length === 0 ? (
              <p className="py-4 text-[13px] text-ink-soft">No test runs recorded.</p>
            ) : (
              testRuns.map((t) => (
                <Link
                  key={t.id}
                  href={`/tasks/${t.id}`}
                  className="history-row group grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-edge py-3.5 pr-1 transition-colors hover:bg-panel sm:grid-cols-[150px_minmax(0,1fr)_auto_auto] sm:gap-x-5"
                >
                  <StatusChip state={t.state} />
                  <span className="truncate text-[13.5px] text-ink-soft transition group-hover:text-accent">{t.goal}</span>
                  <span className="hidden tabular text-[11px] text-ink-faint sm:block">test run</span>
                  <span className="tabular text-[11px] text-ink-faint">{timeOf(t.createdAt)}</span>
                </Link>
              ))
            )}
          </section>
        )}

    
      </div>
    </div>
  );
}
