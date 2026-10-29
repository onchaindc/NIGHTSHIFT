"use client";

import type { ExecutionEvent, TaskRecord } from "@/lib/engine/types";

/**
 * Shared task UI: status vocabulary, evidence, activity log, outcome blocks.
 * Used by the Dashboard, Operations, Approvals, Work History, and Task Details
 * views so every screen presents the same state in the same words. All data
 * comes from the task engine; nothing is invented here.
 */

export const AUDIT_LABEL = "audit-rehearsal"; // keep in sync with scripts/tag-audit-records.mjs

export type Tone = "neutral" | "info" | "good" | "bad";

export const STATUS: Record<TaskRecord["state"], { label: string; icon: string; tone: Tone }> = {
  created: { label: "Queued", icon: "○", tone: "neutral" },
  planning: { label: "Planning", icon: "◐", tone: "info" },
  awaiting_approval: { label: "Needs approval", icon: "?", tone: "info" },
  executing: { label: "Working", icon: "◐", tone: "info" },
  verifying: { label: "Verifying", icon: "◐", tone: "info" },
  completed: { label: "Completed", icon: "✓", tone: "good" },
  failed: { label: "Failed", icon: "✕", tone: "bad" },
  rejected: { label: "Rejected", icon: "○", tone: "neutral" },
  blocked: { label: "Blocked", icon: "!", tone: "bad" },
};

export const TONE_CHIP: Record<Tone, string> = {
  neutral: "text-ink-soft border-edge bg-panel-2",
  info: "text-blue border-blue/40 bg-blue/10",
  good: "text-teal border-teal/40 bg-teal/10",
  bad: "text-risk border-risk/40 bg-risk/10",
};

/** Activity-feed vocabulary: event type → short, truthful chip label + tone. */
const FEED_TYPE: Partial<Record<ExecutionEvent["type"], { label: string; tone: Tone }>> = {
  goal_accepted: { label: "goal", tone: "neutral" },
  plan_created: { label: "plan", tone: "neutral" },
  criteria_defined: { label: "criteria", tone: "neutral" },
  approval_required: { label: "approval", tone: "info" },
  plan_approved: { label: "approved", tone: "good" },
  plan_rejected: { label: "rejected", tone: "neutral" },
  step_started: { label: "action", tone: "info" },
  step_succeeded: { label: "action", tone: "good" },
  step_failed: { label: "error", tone: "bad" },
  step_retried: { label: "retry", tone: "info" },
  recovery_selected: { label: "recovery", tone: "info" },
  action_started: { label: "action", tone: "info" },
  permission_denied: { label: "denied", tone: "bad" },
  spend_denied: { label: "budget", tone: "bad" },
  spend_recorded: { label: "cost", tone: "good" },
  telegraph_challenge: { label: "price", tone: "info" },
  verification_started: { label: "verify", tone: "info" },
  verification_passed: { label: "verified", tone: "good" },
  criteria_failed: { label: "failed", tone: "bad" },
  criteria_check_passed: { label: "verified", tone: "good" },
  task_completed: { label: "completion", tone: "good" },
  task_failed: { label: "error", tone: "bad" },
  task_blocked: { label: "blocked", tone: "bad" },
};

export function feedType(type: ExecutionEvent["type"]): { label: string; tone: Tone } {
  return FEED_TYPE[type] ?? { label: type, tone: "neutral" };
}

export function isLive(s: TaskRecord["state"]) {
  return s === "planning" || s === "executing" || s === "verifying";
}

export function isOpen(s: TaskRecord["state"]) {
  return isLive(s) || s === "awaiting_approval";
}

export function isTestRun(t: TaskRecord) {
  return (t.labels ?? []).includes(AUDIT_LABEL);
}

export function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function timeOf(ts: number) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function clockOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function cleanReason(e: string) {
  return e.replace(/^(blocked|failed): /, "");
}

export function compactAnswer(summary: string) {
  // The engine summary starts with a miner status line, then the answer.
  const payload = summary.split("\n").slice(1).join("\n").trim();
  return payload.length > 500 ? payload.slice(0, 500) + "… (the rest is in the activity log)" : payload;
}

export function StatusChip({ state }: { state: TaskRecord["state"] }) {
  const st = STATUS[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-medium ${TONE_CHIP[st.tone]}`}>
      <span aria-hidden className="tabular text-[10px]">{st.icon}</span>
      {st.label}
      {isLive(state) && (
        <span className="relative ml-0.5 inline-flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-50 motion-safe:animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
    </span>
  );
}

export function FeedChip({ type }: { type: ExecutionEvent["type"] }) {
  const ft = feedType(type);
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10.5px] font-medium tabular ${TONE_CHIP[ft.tone]}`}>
      <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current" />
      {ft.label}
    </span>
  );
}

/** Execution phases computed from the real event log (never guessed). */
export function phaseState(task: TaskRecord) {
  const has = (type: ExecutionEvent["type"]) => task.events.some((e) => e.type === type);
  const plan = has("plan_created");
  const buy = has("step_started") || has("action_started");
  const paid = has("spend_recorded");
  const verified = has("verification_passed");
  const stopped = task.state === "failed" || task.state === "blocked" || task.state === "rejected";
  return { plan, buy, paid, verified, stopped };
}

export function EvidenceList({ evidence }: { evidence: NonNullable<TaskRecord["result"]>["evidence"] }) {
  return (
    <table className="w-full">
      <tbody>
        {evidence.map((ev, i) => (
          <tr key={i}>
            <td className="py-1.5 pr-3 align-top text-[12px] text-ink-soft">
              {ev.kind === "telegraph_signal" && "Purchased answer"}
              {ev.kind === "telegraph_receipt" && "Payment receipt"}
              {ev.kind === "on_chain_settlement" && "Settlement on chain"}
              {ev.kind === "chain_gas_crosscheck" && "Independent check"}
              {ev.kind === "watch_finding" && `Source read: ${ev.sourceLabel}`}
            </td>
            <td className="break-all py-1.5 tabular text-[11px] leading-relaxed text-ink-faint">
              {ev.kind === "telegraph_signal" && ev.signalHash}
              {ev.kind === "telegraph_receipt" && (
                <>
                  {ev.receiptHash}
                  {ev.txHash ? `, tx ${ev.txHash}` : ""}, charged {money(ev.amountUsdCents)}
                </>
              )}
              {ev.kind === "on_chain_settlement" && `${ev.txHash}, status ${ev.status}, block ${ev.blockNumber} (${ev.rpcUrl})`}
              {ev.kind === "chain_gas_crosscheck" &&
                `${ev.answerGasGwei} gwei purchased vs ${ev.chainGasGwei.toFixed(6)} gwei from our own node read on ${ev.chain}, agreed: ${ev.agreed ? "yes" : "no"} (${ev.rpcUrl})`}
              {ev.kind === "watch_finding" &&
                `${ev.findingKind} from a real source read, confidence ${ev.confidence}${ev.corroboratedBy?.length ? `, corroborated by ${ev.corroboratedBy.join(", ")}` : ""}${ev.url ? ` — ${ev.url}` : ""}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Disclose({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <details className="x-disc group rounded-md border border-edge bg-panel-2">
      <summary className="flex cursor-pointer select-none items-center justify-between px-3.5 py-2.5 text-[13px] text-ink-soft transition hover:text-ink">
        {title}
        <span className="flex items-center gap-2">
          {meta && <span className="tabular text-[11px] text-ink-faint">{meta}</span>}
          <span aria-hidden className="x-chev" />
        </span>
      </summary>
      <div className="border-t border-edge px-3.5 py-3">{children}</div>
    </details>
  );
}

export function ActivityLog({ events }: { events: ExecutionEvent[] }) {
  return (
    <ol>
      {[...events].reverse().map((e) => (
        <li key={e.id} className="flex items-start gap-2.5 py-1.5">
          <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-faint" aria-hidden />
          <span className="mt-0.5 shrink-0 tabular text-[10.5px] text-ink-faint">
            {clockOf(e.ts)}
          </span>
          <span className="text-[12.5px] leading-snug text-ink-soft">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

export function OutcomeBlock({ task }: { task: TaskRecord }) {
  const done = task.state === "completed" && task.result;
  if (done) {
    return (
      <div className="rounded-md border border-teal/30 bg-teal/5 p-4">
        <p className="mb-1.5 text-[13px] text-ink-soft">{task.result!.summary.split("\n")[0]}</p>
        <pre className="whitespace-pre-wrap tabular text-[12.5px] leading-relaxed text-ink">
          {compactAnswer(task.result!.summary)}
        </pre>
      </div>
    );
  }
  if (task.state === "failed") {
    return (
      <div className="rounded-md border border-risk/30 bg-risk/5 p-4">
        <p className="text-[14px] leading-relaxed text-ink">The goal was not met, so nothing is claimed.</p>
        {task.error && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{cleanReason(task.error)}</p>}
      </div>
    );
  }
  if (task.state === "blocked") {
    return (
      <div className="rounded-md border border-risk/30 bg-risk/5 p-4">
        <p className="text-[14px] leading-relaxed text-ink">Stopped before it could finish. Nothing was charged.</p>
        {task.error && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{cleanReason(task.error)}</p>}
      </div>
    );
  }
  if (task.state === "rejected") {
    return <p className="text-[14px] leading-relaxed text-ink-soft">You rejected the plan. Nothing happened and nothing was charged.</p>;
  }
  return null;
}
