"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardList, Receipt } from "lucide-react";
import type { TaskRecord } from "@/lib/engine/types";
import {
  ActivityLog,
  Disclose,
  EvidenceList,
  OutcomeBlock,
  StatusChip,
  AUDIT_LABEL,
  isTestRun,
  money,
} from "@/components/taskParts";

/**
 * Task Details: one task, addressed by its real id. The full timeline, current
 * status, spending against the ceiling, the outcome, and recorded verification
 * evidence. Polls the single-task API; still operable while the work runs.
 */

function SpendMeter({ task }: { task: TaskRecord }) {
  const spent = task.spend.spentUsdCents;
  const limit = task.spend.limitUsdCents;
  const pct = Math.min(100, Math.round((spent / Math.max(limit, 1)) * 100));
  return (
    <div className="rounded-md border border-edge bg-panel-2 p-4">
      <div className="flex items-baseline justify-between">
        <p className="inline-flex items-center gap-2 x-label">
          <Receipt size={11} strokeWidth={1.8} aria-hidden /> Spending
        </p>
        <p className="tabular text-[12.5px] text-ink">
          {money(spent)} <span className="text-ink-faint">of {money(limit)}</span>
        </p>
      </div>
      <div className="mt-2.5 h-1 w-full rounded-sm bg-edge">
        <div className="h-full rounded-sm bg-amber transition-all" style={{ width: `${pct}%` }} />
      </div>
      {task.spend.entries.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-edge pt-2.5">
          {task.spend.entries.map((e, i) => (
            <li key={i} className="tabular text-[11.5px] leading-relaxed text-ink-faint">
              {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
              {e.description}, {money(e.amountUsdCents)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApproveReject({ task, onAction, busy, actionError }: {
  task: TaskRecord;
  onAction: (id: string, action: "approve" | "reject") => void;
  busy: boolean;
  actionError: string | null;
}) {
  const awaiting = task.state === "awaiting_approval";
  if (!awaiting) return null;
  return (
    <div className="rise-in mt-4 rounded-lg border border-amber/40 bg-amber/5 p-3.5">
      <p className="text-[13px] leading-relaxed text-amber-soft">
        The plan is ready and nothing has been spent yet. Approving lets the agent make its purchase and run the checks.
      </p>
      <div className="mt-3 flex gap-2.5">
        <button
          type="button"
          onClick={() => onAction(task.id, "approve")}
          disabled={busy}
          className="btn-primary !min-h-9 !text-[12.5px] flex-1 sm:flex-none disabled:opacity-50"
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
      {actionError && (
        <p role="alert" className="mt-3 rounded-md border border-risk/40 bg-risk/5 px-3 py-2 text-[12.5px] text-risk">
          {actionError}
        </p>
      )}
    </div>
  );
}

export default function TaskDetails({ id }: { id: string }) {
  const [task, setTask] = useState<TaskRecord | null | "missing">(null);
  const [activating, setActivating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${id}`, { cache: "no-store" });
      if (res.status === 404) {
        setTask("missing");
        return;
      }
      if (res.ok) setTask(((await res.json()) as { task: TaskRecord }).task);
    } catch {
      // retry on the next tick
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [load]);

  async function act(action: "approve" | "reject") {
    if (activating) return;
    setActivating(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/tasks/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(
          `Could not ${action} the task: ` + (body.error ?? `status ${res.status}`),
        );
      }
      await load();
    } catch (err) {
      setActionError(`Could not ${action} the task: ` + (err instanceof Error ? err.message : String(err)));
      await load();
    } finally {
      setActivating(false);
    }
  }

  if (task === "missing") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Task not found</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
          There is no task with the id{" "}
          <span className="break-all tabular text-[12px] text-ink-faint">{id}</span>. The link may be old, or the
          record never existed. History always lists the real ids.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/" className="btn-quiet">
            <ChevronLeft size={13} aria-hidden /> Overview
          </Link>
          <Link href="/history" className="btn-quiet">
            Open History
          </Link>
        </div>
      </div>
    );
  }

  if (task === null) {
    return (
      <div className="mx-auto max-w-3xl px-4 pt-16 sm:px-6">
        <div aria-live="polite" className="space-y-3">
          <div className="h-8 w-2/3 rounded-md bg-panel-2 motion-safe:animate-pulse" />
          <div className="h-40 rounded-md bg-panel-2 motion-safe:animate-pulse" />
          <p className="text-[13px] text-ink-faint">Loading the task…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6 sm:pt-10">
      <nav aria-label="Breadcrumb" className="flex items-center justify-between gap-3">
        <Link href="/history" className="inline-flex min-h-10 items-center gap-1 text-[12.5px] font-medium text-amber transition-colors hover:text-amber-soft">
          <ChevronLeft size={13} aria-hidden /> History
        </Link>
        <Link href="/" className="inline-flex min-h-10 items-center text-[12.5px] font-medium text-amber transition-colors hover:text-amber-soft">
          Overview <ChevronRight size={13} aria-hidden />
        </Link>
      </nav>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip state={task.state} />
          {isTestRun(task) && (
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[11px] text-ink-faint">
              <span aria-hidden className="tabular text-[10px]">{AUDIT_LABEL}</span>
              Test run
            </span>
          )}
        </div>
        <span className="tabular text-[11px] text-ink-faint">
          {task.origin.source === "telegram" ? "via Telegram" : "via web"} · {new Date(task.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <h1 className="mt-4 text-[19px] font-semibold leading-snug tracking-tight text-ink">{task.goal}</h1>
      <p className="mt-1.5 break-all tabular text-[11px] text-ink-faint">task {task.id}</p>

      <ApproveReject task={task} onAction={(_, action) => act(action)} busy={activating} actionError={actionError} />

      {/* Outcome first, always */}
      {(task.state === "completed" || task.state === "failed" || task.state === "blocked" || task.state === "rejected") && (
        <section className="mt-6">
          <p className="x-label mb-2.5">Result</p>
          <OutcomeBlock task={task} />
        </section>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <SpendMeter task={task} />

        <div className="rounded-md border border-edge bg-panel-2 p-4">
          <p className="inline-flex items-center gap-2 x-label mb-2.5">
            <ClipboardList size={11} strokeWidth={1.8} aria-hidden /> Plan
          </p>
          {task.plan && task.plan.length > 0 ? (
            <ol className="space-y-1.5 border-l-2 border-amber/25 pl-3">
              {task.plan.map((s, i) => (
                <li key={s.id} className="flex gap-2 text-[12.5px] leading-snug text-ink-soft">
                  <span className="tabular shrink-0 text-[11px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    {s.description}
                    {s.maxCostUsdCents != null && <span className="text-ink-faint"> (at most {money(s.maxCostUsdCents)})</span>}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[12.5px] text-ink-soft">No plan recorded.</p>
          )}
        </div>
      </div>

      {task.result && task.result.evidence.length > 0 && (
        <div className="mt-4">
          <Disclose title="Verification evidence" meta={`${task.result.evidence.length} items`}>
            <EvidenceList evidence={task.result.evidence} />
          </Disclose>
        </div>
      )}

      <div className="mt-4">
        <Disclose title="Activity log" meta={`${task.events.length} entries`}>
          <ActivityLog events={task.events} />
        </Disclose>
      </div>

      <p className="mt-3 text-center text-[11px] text-ink-faint">Updated live every 2.5 seconds.</p>
    </div>
  );
}
