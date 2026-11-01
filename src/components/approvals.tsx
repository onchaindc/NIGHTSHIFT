"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronRight, ShieldCheck, Wallet } from "lucide-react";
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

  const pending = (tasks ?? []).filter((t) => t.state === "awaiting_approval" && !isTestRun(t));
  const totalCeiling = pending.reduce((n, t) => n + t.spend.limitUsdCents, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="x-tag">NS-WSP/13 · GATES</p>
          <h1 className="x-display-1 mt-3 text-ink">Approvals</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            Operations whose plans are ready but not yet paid for. Approving lets the agent make its planned purchase
            within the ceiling; rejecting stops the task with nothing spent.
          </p>
        </div>
        {pending.length > 0 && (
          <div className="rounded-lg border border-amber/40 bg-amber/5 px-4 py-3">
            <p className="x-label !text-amber/80">Exposure if all approved</p>
            <p className="mt-1 tabular text-[20px] font-semibold leading-none text-amber">{money(totalCeiling)}</p>
            <p className="mt-1 text-[10.5px] text-ink-faint">
              {pending.length} plan{pending.length === 1 ? "" : "s"} · each task spends at most its own limit
            </p>
          </div>
        )}
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
        </div>
      )}

      {tasks !== null && !loadFailed && (
        pending.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-edge bg-panel/40 px-5 py-10 text-center">
            <span aria-hidden className="mx-auto grid h-10 w-10 place-items-center rounded-lg border border-edge bg-panel-2 text-teal">
              <ShieldCheck size={18} strokeWidth={1.8} />
            </span>
            <p className="mx-auto mt-4 max-w-sm text-[13.5px] leading-relaxed text-ink-soft">
              Nothing is waiting for approval. Operations with approval required will appear here before any money moves.
            </p>
            <Link href="/operations" className="btn-quiet mt-5">
              Open the launcher <ArrowRight size={13} aria-hidden />
            </Link>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {pending.map((t) => (
              <article key={t.id} className="rise-in rounded-lg border border-amber/40 bg-panel">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-edge px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip state={t.state} />
                    <span className="inline-flex items-center gap-1.5 tabular text-[11px] text-ink-faint">
                      <Wallet size={11} strokeWidth={1.8} aria-hidden />
                      ceiling {money(t.spend.limitUsdCents)}
                    </span>
                  </div>
                  <span className="tabular text-[11px] text-ink-faint">
                    {t.origin.source === "telegram" ? "via Telegram" : "via web"}
                  </span>
                </div>
                <div className="px-4 py-3.5">
                  <p className="text-[14.5px] font-medium leading-snug text-ink">{t.goal}</p>
                  {t.plan && t.plan.length > 0 && (
                    <ol className="mt-2.5 space-y-1.5 border-l-2 border-amber/25 pl-3">
                      {t.plan.map((s, i) => (
                        <li key={s.id} className="flex gap-2 text-[12px] leading-snug text-ink-soft">
                          <span className="tabular shrink-0 text-[10.5px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
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
                      The outcome checks were fixed before this plan was started; the full list is in the operation detail.
                    </p>
                  )}
                  <div className="mt-3.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => act(t.id, "approve")}
                      disabled={activating === t.id}
                      className="btn-primary disabled:opacity-50"
                    >
                      {activating === t.id ? "Approving…" : "Approve and continue"}
                    </button>
                    <button
                      type="button"
                      onClick={() => act(t.id, "reject")}
                      disabled={activating === t.id}
                      className="btn-quiet !min-h-[40px] hover:border-risk/50 hover:text-risk disabled:opacity-50"
                    >
                      {activating === t.id ? "Working…" : "Reject"}
                    </button>
                    <Link
                      href={`/tasks/${t.id}`}
                      className="ml-auto inline-flex min-h-10 items-center gap-1 text-[12px] font-medium text-amber transition-colors hover:text-amber-soft"
                    >
                      Inspect plan <ChevronRight size={12} aria-hidden />
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
