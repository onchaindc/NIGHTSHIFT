"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@/lib/engine/types";
import { StatusChip, isTestRun, money } from "@/components/taskParts";

/**
 * Approvals view. Lists only real awaiting-approval tasks (test records
 * excluded) and drives the existing POST /api/tasks/:id/action flow. No
 * approval is ever created or resolved automatically here.
 */

export default function Approvals() {
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

  const pending = (tasks ?? []).filter((t) => t.state === "awaiting_approval" && !isTestRun(t));

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="max-w-2xl">
        <h1 className="text-[22px] font-semibold tracking-tight">Approvals</h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          Operations whose plans are ready but not yet paid for. Approving lets the agent make its planned purchase
          within the ceiling; rejecting stops the task with nothing spent.
        </p>
      </div>

      {tasks !== null && loadFailed && (
        <p aria-live="assertive" role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not load the task list. The view keeps retrying every few seconds.
        </p>
      )}

      {tasks === null && !loadFailed && (
        <div aria-live="polite" className="mt-6 space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-28 rounded-lg bg-panel-2 motion-safe:animate-pulse" />
          ))}
          <p className="text-[13px] text-ink-faint">Loading…</p>
        </div>
      )}

      {tasks !== null && !loadFailed && (
        pending.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-edge bg-panel/50 px-5 py-10 text-center">
            <p className="mx-auto max-w-sm text-[13px] text-ink-soft">
              Nothing is waiting for approval. Operations with approval required will appear here before any money moves.
            </p>
            <Link
              href="/operations"
              className="mt-4 inline-flex min-h-10 items-center rounded-md border border-edge bg-panel px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:border-edge-strong"
            >
              Open the launcher
            </Link>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {pending.map((t) => (
              <article key={t.id} className="rounded-lg border border-gold/40 bg-panel">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-edge px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip state={t.state} />
                    <span className="tabular text-[11px] text-ink-faint">ceiling {money(t.spend.limitUsdCents)}</span>
                  </div>
                  <span className="tabular text-[11px] text-ink-faint">
                    {t.origin.source === "telegram" ? "via Telegram" : "via web"}
                  </span>
                </div>
                <div className="px-4 py-3.5">
                  <p className="text-[14px] font-medium leading-snug text-ink">{t.goal}</p>
                  {t.plan && t.plan.length > 0 && (
                    <ol className="mt-2 space-y-1">
                      {t.plan.map((s, i) => (
                        <li key={s.id} className="flex gap-2 text-[12px] leading-snug text-ink-soft">
                          <span className="tabular text-[10.5px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                          <span>
                            {s.description}
                            {s.maxCostUsdCents != null && <span className="text-ink-faint"> (at most {money(s.maxCostUsdCents)})</span>}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {t.events.some((e) => e.type === "criteria_defined") && (
                    <p className="mt-2 text-[11.5px] text-ink-faint">
                      Success criteria are fixed by the planner before execution; see the operation detail for the full list.
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => act(t.id, "approve")}
                      disabled={activating === t.id}
                      className="min-h-10 rounded-md bg-ink px-5 py-2 text-[13px] font-medium text-night transition-colors hover:bg-ink/85 disabled:opacity-50"
                    >
                      {activating === t.id ? "Approving…" : "Approve and continue"}
                    </button>
                    <button
                      type="button"
                      onClick={() => act(t.id, "reject")}
                      disabled={activating === t.id}
                      className="min-h-10 rounded-md border border-edge bg-panel-2 px-5 py-2 text-[13px] text-ink-soft transition-colors hover:border-risk/50 hover:text-risk disabled:opacity-50"
                    >
                      {activating === t.id ? "Working…" : "Reject"}
                    </button>
                    <Link
                      href={`/tasks/${t.id}`}
                      className="ml-auto inline-flex min-h-10 items-center text-[12px] font-medium text-blue hover:underline underline-offset-2"
                    >
                      Inspect plan →
                    </Link>
                  </div>
                  {actionError[t.id] && (
                    <p role="alert" className="mt-2.5 rounded-md border border-risk/40 bg-risk/5 px-3 py-2 text-[12.5px] text-risk">
                      {actionError[t.id]}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        )
      )}
    </div>
  );
}
