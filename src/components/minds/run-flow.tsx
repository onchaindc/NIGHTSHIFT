"use client";

/**
 * RunFlow — the state-first presentation of one Mind investigation.
 *
 * The whole execution lifecycle lives in ONE panel with a fixed skeleton, so
 * the reader always knows where they are without scrolling or guessing:
 *
 *   a five-stage tracker (Plan → Approval → Run → Verify → Report) driven by
 *   the task state machine, one plain-language headline per state ("Waiting
 *   for your approval", "Report ready", "The run failed"), the action for
 *   THIS state directly beneath it (approve / resume / read the report /
 *   run again — no dead ends), stall warnings as proper banners, and a short
 *   human-word timeline. Machine evidence stays in the report's drawer.
 */

import { Check, ChevronDown, CircleAlert, LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";

import type { ExecutionEvent, TaskRecord } from "@/lib/engine/types";
import type { useRunWatchdog } from "@/components/minds/run-watchdog";

type Watchdog = ReturnType<typeof useRunWatchdog>;

export function fmtUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const STAGES = [
  { key: "plan", label: "Plan" },
  { key: "approval", label: "Approval" },
  { key: "run", label: "Run" },
  { key: "verify", label: "Verify" },
  { key: "report", label: "Report" },
] as const;

type StageStatus = "done" | "active" | "failed" | "pending" | "skipped";

/** Which stage the task is sitting at (or stopped at), from the state machine. */
function stageIndex(state: TaskRecord["state"]): number {
  switch (state) {
    case "created":
    case "planning":
      return 0;
    case "awaiting_approval":
      return 1;
    case "executing":
      return 2;
    case "verifying":
      return 3;
    case "completed":
      return 4;
    default:
      return -1; // failed / rejected / blocked — derived from the event trail
  }
}

/** The stage a dead run actually stopped at, from what the events recorded. */
function stoppedStage(events: ExecutionEvent[], plan: TaskRecord["plan"]): number {
  const types = new Set(events.map((e) => e.type));
  if (types.has("verification_started") || types.has("verification_passed")) return 3;
  if (types.has("plan_approved")) return plan ? 2 : 1;
  if (types.has("plan_created")) return 1;
  return 0;
}

function stageStatuses(state: TaskRecord["state"], events: ExecutionEvent[], plan: TaskRecord["plan"], mode: "free" | "intel"): StageStatus[] {
  const idx = stageIndex(state);
  const dead = idx === -1;
  const stop = dead ? stoppedStage(events, plan) : idx;
  const statuses: StageStatus[] = STAGES.map((_, i) => {
    if (dead) return i < stop ? "done" : i === stop ? "failed" : "pending";
    if (i < idx) return "done";
    if (i === idx) return "active";
    return "pending";
  });
  // Free runs never touch the approval gate; approved runs have it behind them.
  const approved = events.some((e) => e.type === "plan_approved");
  if (mode === "free") statuses[1] = stop > 1 || approved ? "skipped" : stop === 1 && dead ? "failed" : "skipped";
  else if (!dead && idx > 1) statuses[1] = "done";
  else if (dead && stop > 1) statuses[1] = "done";
  else if (dead && stop === 1 && state === "rejected") statuses[1] = "failed";
  return statuses;
}

/** Reader-facing status words for the header chip. */
export function stateWord(state: TaskRecord["state"] | null): string {
  switch (state) {
    case "created":
    case "planning":
      return "Planning";
    case "awaiting_approval":
      return "Awaiting approval";
    case "executing":
      return "Running";
    case "verifying":
      return "Verifying";
    case "completed":
      return "Report ready";
    case "rejected":
      return "Rejected";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    default:
      return "Run";
  }
}

type Tone = "working" | "attention" | "done" | "failed" | "stopped";

const TONE_CARD: Record<Tone, string> = {
  working: "border-teal/30 bg-teal/5",
  attention: "border-amber/40 bg-amber-soft/40",
  done: "border-teal/30 bg-teal/5",
  failed: "border-risk/30 bg-risk/5",
  stopped: "border-edge bg-panel-2",
};

/** One plain-language headline per state — what is happening and what it means. */
function headlineFor(task: TaskRecord, mode: "free" | "intel", redacted: boolean, routableCount: number): { tone: Tone; title: string; sub: string } {
  const state = task.state;
  const spent = fmtUsd(task.spend.spentUsdCents / 100);
  const limit = fmtUsd(task.spend.limitUsdCents / 100);
  const planLen = task.plan?.length ?? 0;
  const done = task.progress?.completedSteps ?? 0;
  if (redacted && state === "completed") {
    return {
      tone: "attention",
      title: "Report ready — sign in to read it",
      sub: "The findings are withheld from anonymous readers. Sign in with the owner wallet or the operator account.",
    };
  }
  switch (state) {
    case "created":
    case "planning":
      return { tone: "working", title: "Planning your investigation…", sub: "Pricing every route against its live offer. Nothing is spent yet." };
    case "awaiting_approval":
      return {
        tone: "attention",
        title: "Waiting for your approval",
        sub: `${routableCount} route${routableCount === 1 ? "" : "s"} priced at up to ${limit}. Nothing is bought until you approve.`,
      };
    case "executing":
      return {
        tone: "working",
        title: "Running the plan",
        sub: mode === "free"
          ? "Free run — public sources and read-only chain reads, no spend path."
          : `Step ${Math.min(done + 1, Math.max(planLen, 1))} of ${Math.max(planLen, 1)} · paid ${spent} of up to ${limit}.`,
      };
    case "verifying":
      return {
        tone: "working",
        title: "Verifying the answers",
        sub: "Every purchased answer is re-derived against the network signal before the report is written.",
      };
    case "completed": {
      const report = task.result?.capabilityReport as { counts?: Record<string, number>; spendUsdCents?: number } | undefined;
      const answers = report?.counts ? report.counts.verified + report.counts.recorded + report.counts.unverified : 0;
      const verified = report?.counts?.verified ?? 0;
      return {
        tone: "done",
        title: "Report ready",
        sub: answers > 0
          ? `${answers} answer${answers === 1 ? "" : "s"} returned${verified > 0 ? `, ${verified} re-verified against the network signal` : ""} · spent ${fmtUsd(report?.spendUsdCents ?? task.spend.spentUsdCents / 100)}.`
          : `No answers were purchased on this run · spent ${fmtUsd(report?.spendUsdCents ?? task.spend.spentUsdCents / 100)}.`,
      };
    }
    case "failed":
      return {
        tone: "failed",
        title: "The run failed",
        sub: task.error
          ? task.error.length > 240 ? `${task.error.slice(0, 240)}…` : task.error
          : "The server stopped the run before it finished.",
      };
    case "rejected":
      return { tone: "stopped", title: "You rejected the plan", sub: "Nothing was spent. Adjust the inputs and run again when ready." };
    case "blocked":
      return {
        tone: "failed",
        title: "The run was blocked",
        sub: task.error ? (task.error.length > 240 ? `${task.error.slice(0, 240)}…` : task.error) : "The plan could not be carried out as priced.",
      };
    default:
      return { tone: "working", title: "Preparing…", sub: "" };
  }
}

const EVENT_WORDS: Record<string, string> = {
  plan_created: "Plan ready",
  plan_approved: "Plan approved",
  plan_rejected: "Plan rejected",
  capability_baseline_ready: "Route prices recorded",
  step_started: "Step started",
  spend_recorded: "Provider paid",
  spend_denied: "Spend refused",
  step_failed: "Step failed",
  verification_started: "Verification started",
  verification_passed: "Answers verified",
  task_completed: "Report written",
};

const BAD_EVENTS = new Set(["step_failed", "spend_denied", "plan_rejected"]);
const GOOD_EVENTS = new Set(["verification_passed", "task_completed"]);

function eventWord(e: ExecutionEvent): string {
  return EVENT_WORDS[e.type] ?? (e.type.charAt(0).toUpperCase() + e.type.slice(1).replace(/_/g, " "));
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export interface RunFlowProps {
  task: TaskRecord;
  mode: "free" | "intel";
  routableCount: number;
  ceilingUsdCents: number;
  canAct: boolean;
  signedIn: boolean;
  acting: "approve" | "reject" | null;
  actionError: string | null;
  onApprove: () => void;
  onReject: () => void;
  onResume: () => void;
  resuming: boolean;
  onRunAgain: () => void;
  onSignIn: () => void;
  onReadReport: () => void;
  redacted: boolean;
  watchdog: Watchdog;
}

export default function RunFlow({
  task,
  mode,
  routableCount,
  ceilingUsdCents,
  canAct,
  signedIn,
  acting,
  actionError,
  onApprove,
  onReject,
  onResume,
  resuming,
  onRunAgain,
  onSignIn,
  onReadReport,
  redacted,
  watchdog,
}: RunFlowProps) {
  const state = task.state;
  const statuses = stageStatuses(state, task.events, task.plan, mode);
  const head = headlineFor(task, mode, redacted, routableCount);
  const dead = state === "failed" || state === "rejected" || state === "blocked";
  const resumable =
    state === "failed" && (task.progress?.completedSteps ?? 0) > 0 && !!task.plan && (task.progress?.completedSteps ?? 0) < task.plan.length;
  const awaiting = state === "awaiting_approval";
  const running = state === "created" || state === "planning" || state === "executing" || state === "verifying";
  const latest = task.events.length > 0 ? task.events[task.events.length - 1] : null;
  const tail = task.events.slice(-4);
  const earlier = Math.max(task.events.length - tail.length, 0);
  const Icon = head.tone === "working" ? LoaderCircle : head.tone === "done" ? Check : head.tone === "attention" ? ShieldCheck : head.tone === "failed" ? ShieldAlert : CircleAlert;

  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-label="Run flow">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3 sm:px-5">
        <p className="x-label !mt-0">Run flow</p>
        <span className="flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="rounded-full border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] text-ink-soft">{stateWord(state)}</span>
          <span className="tabular">
            {mode === "free" && task.spend.limitUsdCents === 0
              ? "free run · no spend"
              : `paid ${fmtUsd(task.spend.spentUsdCents / 100)} of up to ${fmtUsd(task.spend.limitUsdCents / 100)}`}
          </span>
        </span>
      </div>

      <div className="space-y-3.5 px-4 py-4 sm:px-5">
        {/* Where you are — five fixed stages */}
        <ol className="flex items-center gap-1" aria-label="Execution stages">
          {STAGES.map((s, i) => {
            const st = statuses[i];
            const dot =
              st === "done"
                ? "border-teal bg-teal text-panel"
                : st === "active"
                  ? "border-teal bg-teal/10 text-teal animate-pulse"
                  : st === "failed"
                    ? "border-risk bg-risk text-panel"
                    : st === "skipped"
                      ? "border-edge bg-panel-2 text-ink-faint"
                      : "border-edge bg-panel-2 text-ink-faint/60";
            const labelTone =
              st === "active"
                ? "text-teal font-medium"
                : st === "done"
                  ? "text-ink-soft"
                  : st === "failed"
                    ? "text-risk font-medium"
                    : st === "skipped"
                      ? "text-ink-faint line-through decoration-edge"
                      : "text-ink-faint/80";
            return (
              <li key={s.key} className="flex min-w-0 items-center gap-1" aria-current={st === "active" ? "step" : undefined}>
                {i > 0 && <span aria-hidden className={`h-px w-2.5 shrink-0 sm:w-4 ${statuses[i - 1] === "done" || statuses[i - 1] === "skipped" ? "bg-teal/40" : "bg-edge"}`} />}
                <span className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${dot}`} aria-hidden>
                  {st === "done" && <Check size={9} strokeWidth={3} />}
                  {st === "skipped" && <span className="text-[9px] leading-none">–</span>}
                  {st === "active" && <span className="size-1.5 rounded-full bg-teal" />}
                  {st === "failed" && <span className="text-[9px] font-bold leading-none">!</span>}
                </span>
                <span className={`truncate text-[10px] tracking-wide ${labelTone}`}>
                  {s.label}
                  {st === "active" && s.key === "approval" ? " — you" : ""}
                </span>
              </li>
            );
          })}
        </ol>

        {/* What is happening — one headline per state */}
        <div className={`rounded-lg border px-3.5 py-3 ${TONE_CARD[head.tone]}`} role="status">
          <p className="flex items-center gap-2 text-[14px] font-medium leading-snug text-ink">
            <Icon size={15} aria-hidden className={`shrink-0 ${head.tone === "working" ? "animate-spin text-teal" : head.tone === "attention" ? "text-amber-deep" : head.tone === "done" ? "text-teal" : head.tone === "failed" ? "text-risk" : "text-ink-faint"}`} />
            {head.title}
          </p>
          {head.sub && <p className="mt-1 text-[12px] leading-relaxed text-ink-soft break-words [overflow-wrap:anywhere]">{head.sub}</p>}

          {/* The action for THIS state — no dead ends */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {awaiting && (
              <>
                <button type="button" onClick={onApprove} disabled={!!acting || !canAct} className="btn-primary !min-h-9">
                  {acting === "approve" ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
                  Approve — spend up to {fmtUsd(ceilingUsdCents / 100)}
                </button>
                <button type="button" onClick={onReject} disabled={!!acting || !canAct} className="btn-secondary !min-h-9">
                  Reject
                </button>
              </>
            )}
            {awaiting && !canAct && (
              <p className="w-full text-[11.5px] leading-relaxed text-ink-faint">
                {signedIn
                  ? "This run answers to its owner's wallet or the operator — this session can't release its spend."
                  : "Sign in to approve or reject — the run's owner wallet or the operator."}
              </p>
            )}
            {resumable && (
              <button type="button" onClick={onResume} disabled={resuming} className="btn-primary !min-h-9">
                {resuming ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <ChevronDown size={13} aria-hidden />}
                {resuming ? "Resuming…" : `Resume from step ${(task.progress?.completedSteps ?? 0) + 1}`}
              </button>
            )}
            {dead && (
              <button type="button" onClick={onRunAgain} className="btn-secondary !min-h-9">
                Run a new investigation
              </button>
            )}
            {resumable && (
              <p className="w-full text-[11.5px] leading-relaxed text-ink-soft">
                {(task.progress?.completedSteps ?? 0)} completed step{(task.progress?.completedSteps ?? 0) === 1 ? " is" : "s are"} kept — already paid for, nothing re-charged. The run continues with the remaining budget.
              </p>
            )}
            {state === "completed" && !redacted && (
              <button type="button" onClick={onReadReport} className="btn-secondary !min-h-9">
                <ChevronDown size={13} aria-hidden />
                Read the report
              </button>
            )}
            {redacted && state === "completed" && (
              <button type="button" onClick={onSignIn} className="btn-secondary !min-h-9">
                Sign in to read the report
              </button>
            )}
            {actionError && <p className="w-full text-[12px] text-risk">{actionError}</p>}
          </div>
        </div>

        {/* Warnings — proper banners, not buried footnotes */}
        {running && watchdog.silent && (
          <div className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber-soft/40 px-3.5 py-2.5" role="alert">
            <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-amber-deep" />
            <p className="text-[12px] leading-relaxed text-ink-soft">
              No server update for {Math.floor(watchdog.secondsSinceUpdate / 60)}m {watchdog.secondsSinceUpdate % 60}s — the run may have been interrupted. The server fails it cleanly on its next check; nothing after the last recorded step is invented.
            </p>
          </div>
        )}
        {running && watchdog.longRun && !watchdog.silent && (
          <div className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber-soft/40 px-3.5 py-2.5" role="alert">
            <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-amber-deep" />
            <p className="text-[12px] leading-relaxed text-ink-soft">
              Unusually long run — each run is capped at 4 minutes of execution budget, so it will finish or fail shortly.
            </p>
          </div>
        )}

        {/* What just happened — human words, newest last */}
        {tail.length > 0 && (
          <div>
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Latest activity</p>
            <ol className="mt-1.5 space-y-1">
              {tail.map((e) => (
                <li key={e.id} className="grid grid-cols-[56px_1fr] gap-2 text-[11.5px] leading-relaxed">
                  <span className="tabular text-ink-faint">{new Date(e.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    <span className={`font-medium ${BAD_EVENTS.has(e.type) ? "text-risk" : GOOD_EVENTS.has(e.type) ? "text-teal" : "text-ink"}`}>{eventWord(e)}</span>
                    {e.message && <span className="text-ink-soft"> — {truncate(e.message, 160)}</span>}
                  </span>
                </li>
              ))}
            </ol>
            {earlier > 0 && (
              <p className="mt-1 text-[10.5px] text-ink-faint">
                {earlier} earlier entr{earlier === 1 ? "y" : "ies"} — the full history lives on this run's task page.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
