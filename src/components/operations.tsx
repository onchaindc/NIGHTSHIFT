"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@/lib/engine/types";
import {
  ActivityLog,
  EvidenceList,
  OutcomeBlock,
  StatusChip,
  clockOf,
  isOpen,
  isTestRun,
  money,
  phaseState,
} from "@/components/taskParts";
import { buildTaskRequest, cleanLimit, FORM_ERROR_COPY, type ModeOption } from "@/lib/ui/taskForm";

/**
 * Operations launcher. Research & Verify and Custom Operation launch through
 * the real task engine (Telegraph purchase, verification, budget, approvals).
 * Monitor & Alert and Investigate & Report are honestly marked Planned until
 * executable capabilities exist; they never pretend to run.
 */

type JobId = "research" | "monitor" | "investigate" | "custom";

const JOBS: Array<{
  id: JobId;
  name: string;
  blurb: string;
  status: "available" | "planned";
  examples?: string[];
}> = [
  {
    id: "research",
    name: "Research & Verify",
    blurb:
      "Asks a question worth paying for, buys the best answer on the Telegraph network within your ceiling, then verifies it against chain data before showing a result.",
    status: "available",
    examples: [
      "Is the gas price on Base right now under $0.50 for a 21000-gas transfer?",
      "What is the current BTC price in USD?",
      "What is the current ETH price in USD?",
    ],
  },
  {
    id: "monitor",
    name: "Monitor & Alert",
    blurb:
      "Watches a value over time and alerts on thresholds. Requires a scheduler the engine does not have today, so it stays planned instead of pretending.",
    status: "planned",
  },
  {
    id: "investigate",
    name: "Investigate & Report",
    blurb:
      "Multi-source investigation with a written report. The engine currently answers and verifies one question at a time, so this is planned, not faked.",
    status: "planned",
  },
  {
    id: "custom",
    name: "Custom Operation",
    blurb:
      "Free-form goal for the same engine. The planner decides which steps are needed, always within the ceiling and approval rules you set.",
    status: "available",
    examples: [],
  },
];

/* ------------------------------------------------------------------ */
/* Job configuration panel                                             */
/* ------------------------------------------------------------------ */

function JobConfig({
  job,
  activeGoals,
  onStarted,
  onLaunched,
}: {
  job: JobId;
  activeGoals: string[];
  onStarted: () => void;
  onLaunched?: (task: TaskRecord) => void;
}) {
  const [goal, setGoal] = useState("");
  const [limit, setLimit] = useState("1.00");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How the operation may answer. Free is the default: it never spends.
  const [mode, setMode] = useState<ModeOption>("free");
  const liveGoalsRef = useRef(activeGoals);
  liveGoalsRef.current = activeGoals;
  const def = JOBS.find((j) => j.id === job)!;
  const examples = def.examples ?? [];

  async function submit() {
    const built = buildTaskRequest({
      goal,
      limitRaw: limit,
      requiresApproval,
      mode,
      liveGoals: liveGoalsRef.current,
    });
    if (!built.ok) {
      setError(FORM_ERROR_COPY[built.error]);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; task?: TaskRecord };
      if (!res.ok) {
        setError(body.error ?? `The request failed with status ${res.status}. Nothing was started, try again.`);
      } else if (body.task?.state === "blocked" && body.task.error) {
        // The engine blocked this operation honestly (no free capability,
        // missing credentials, unsupported action): surface the named reason.
        setError(body.task.error);
      } else if (body.task) {
        setGoal("");
        onLaunched?.(body.task);
        onStarted();
      }
    } catch (err) {
      setError(`Could not reach the server. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const limitValid = cleanLimit(limit).valid;

  return (
    <div className="rounded-lg border border-edge bg-panel">
      <div className="border-b border-edge px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold">{def.name}</h2>
            <p className="mt-0.5 max-w-[70ch] text-[12px] leading-relaxed text-ink-faint">{def.blurb}</p>
          </div>
          <span className="shrink-0 rounded-sm border border-teal/40 bg-teal/10 px-2 py-0.5 text-[10.5px] font-medium text-teal">
            Available
          </span>
        </div>
      </div>

      <form
        aria-label={`Configure ${def.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="px-4 py-4 sm:px-5"
      >
        <label htmlFor="goal" className="x-label mb-2 block">Goal</label>
        <textarea
          id="goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe the question to answer, precisely enough that the answer can be checked."
          rows={3}
          disabled={submitting}
          className="min-h-24 w-full resize-none rounded-md border border-edge bg-panel-2 px-3.5 py-3 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-blue/60 focus:outline-none disabled:opacity-60"
        />
        <p className="mt-1.5 text-[11px] text-ink-faint">Enter submits, Shift+Enter makes a new line.</p>

        {examples.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] text-ink-faint">Or start from one of these, and edit it:</p>
            <div className="flex flex-wrap gap-2">
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setGoal(ex)}
                  className="min-h-10 rounded-sm border border-edge bg-panel-2 px-3 py-1.5 text-left text-[12px] text-ink-soft transition-colors hover:border-blue/50 hover:text-ink active:opacity-80"
                >
                  {ex.length > 44 ? ex.slice(0, 44) + "…" : ex}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="x-rule my-4" />

        {/* How the operation may answer: free vs paid, chosen explicitly. */}
        <fieldset className="mb-5">
          <legend className="mb-2 block text-xs font-medium text-ink-soft">How this operation may answer</legend>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Answer source">
            {(
              [
                {
                  id: "free" as const,
                  title: "Free sources",
                  price: "$0.00",
                  blurb: "Public chain RPC and public price APIs. Gas and single-asset price questions only; never signs a payment.",
                },
                {
                  id: "paid" as const,
                  title: "Paid research",
                  price: "up to your ceiling",
                  blurb: "Buys an answer on the Telegraph network. Requires the paid-research wallet configured first — check Settings.",
                },
                {
                  id: "auto" as const,
                  title: "Planner decides",
                  price: "$0.00 or your ceiling",
                  blurb: "Free sources when the question fits them, otherwise a clearly labeled paid purchase.",
                },
              ]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={mode === opt.id}
                onClick={() => setMode(opt.id)}
                className={`rounded-md border px-3 py-2.5 text-left transition-colors ${
                  mode === opt.id ? "border-blue/60 bg-panel" : "border-edge bg-panel-2 hover:border-edge-strong"
                }`}
              >
                <p className="text-[12.5px] font-medium text-ink">{opt.title}</p>
                <p className="mt-0.5 tabular text-[11px] font-medium text-gold">{opt.price}</p>
                <p className="mt-1 text-[11px] leading-snug text-ink-faint">{opt.blurb}</p>
              </button>
            ))}
          </div>
          {mode === "free" && (
            <p className="mt-1.5 text-[11px] leading-snug text-gold">
              Free mode never switches to a paid operation: if no free capability covers this question, the launch is refused and nothing is spent.
            </p>
          )}
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="limit" className="mb-1.5 block text-xs font-medium text-ink-soft">
              Spending ceiling
            </label>
            <div className={`flex min-h-10 items-baseline rounded-md border bg-panel-2 px-3 py-2 ${limitValid ? "border-edge" : "border-risk"}`}>
              <span className="tabular text-[13px] text-ink-faint">$</span>
              <input
                id="limit"
                value={limit}
                onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                aria-invalid={!limitValid}
                className="w-24 bg-transparent pl-1 tabular text-sm text-ink focus:outline-none"
              />
            </div>
            <p className={`mt-1.5 text-[11px] leading-snug ${limitValid ? "text-ink-faint" : "text-risk"}`}>
              {limitValid
                ? "The most this operation may spend, checked before any payment."
                : FORM_ERROR_COPY.limitInvalid}
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-soft">Approval</p>
            <button
              type="button"
              role="switch"
              aria-checked={requiresApproval}
              onClick={() => setRequiresApproval((v) => !v)}
              className={`flex min-h-10 w-full items-center justify-between rounded-md border px-3 py-2 text-left transition-colors ${
                requiresApproval ? "border-gold/60 bg-gold/10" : "border-edge bg-panel-2 hover:border-edge-strong"
              }`}
            >
              <span className={`text-[12.5px] ${requiresApproval ? "text-gold" : "text-ink-soft"}`}>
                {requiresApproval ? "Ask me before spending" : "Run without asking"}
              </span>
              <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${requiresApproval ? "bg-gold" : "bg-edge-strong"}`} aria-hidden>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-night transition-all ${requiresApproval ? "left-3.5" : "left-0.5"}`} />
              </span>
            </button>
            <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
              {requiresApproval
                ? "The plan waits for your decision before anything is paid."
                : "Runs straight through, still within the ceiling."}
            </p>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-md border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[13px] text-risk">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="tabular text-[11px] text-ink-faint">
            {requiresApproval ? "Plan only. You approve, then it spends." : "Runs straight away, within the ceiling."}
          </p>
          <button
            type="submit"
            disabled={submitting || !goal.trim() || !limitValid}
            className="min-h-10 w-full rounded-md border border-teal/40 bg-teal/15 px-6 py-2.5 text-[13px] font-medium text-teal transition-colors hover:bg-teal/25 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
          >
            {submitting ? "Starting operation…" : "Launch Operation"}
          </button>
        </div>
      </form>
    </div>
  );
}

type ReactKeyboardEvent = React.KeyboardEvent<HTMLTextAreaElement>;

/* ------------------------------------------------------------------ */
/* Launched-operation monitor: stay on this page until the result      */
/* ------------------------------------------------------------------ */

const TERMINAL_STATES = new Set(["completed", "failed", "blocked", "rejected"]);

/**
 * Live view of the operation the user just launched on this page. Polls the
 * real task record, shows the working steps, and when the task completes
 * renders THE ANSWER prominently right here with its verification evidence,
 * completion time and spend, so nobody has to dig through a feed for results.
 */
function OperationMonitor({
  taskId,
  onFinished,
  onDismiss,
}: {
  taskId: string;
  onFinished: () => void;
  onDismiss: () => void;
}) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setTask(null);
    setLoadFailed(false);
    finishedRef.current = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { task: TaskRecord };
        if (cancelled) return;
        setTask(body.task);
        if (TERMINAL_STATES.has(body.task.state) && !finishedRef.current) {
          finishedRef.current = true;
          onFinished();
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const running = task ? !TERMINAL_STATES.has(task.state) : true;
  const awaiting = task?.state === "awaiting_approval";
  const done = task?.state === "completed";

  async function decide(action: "approve" | "reject") {
    if (task && !TERMINAL_STATES.has(task.state)) {
      await fetch(`/api/tasks/${task.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).catch(() => undefined);
    }
  }

  return (
    <section
      aria-label="Launched operation"
      className={`rounded-lg border bg-panel ${done ? "border-teal/40" : awaiting ? "border-gold/50" : "border-edge"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-edge px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          {task ? <StatusChip state={task.state} /> : (
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[11px] font-medium text-ink-faint">
              Starting…
            </span>
          )}
          <span className="tabular text-[11px] text-ink-faint">{task ? task.goal : "your operation"}</span>
        </div>
        <div className="flex items-center gap-3">
          {task && (
            <Link href={`/tasks/${task.id}`} className="text-[11.5px] font-medium text-blue hover:underline underline-offset-2">
              Open full history →
            </Link>
          )}
          {finishedRef.current && (
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-8 rounded-md border border-edge px-2.5 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-edge-strong hover:text-ink"
            >
              Close
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        {loadFailed && (
          <p role="alert" className="rounded-md border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[13px] text-risk">
            Lost contact with the server while tracking this operation. It keeps running; reopen it from History.
          </p>
        )}

        {!task && !loadFailed && (
          <div className="space-y-2" aria-live="polite">
            <div className="h-4 w-2/3 rounded bg-panel-2 motion-safe:animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-panel-2 motion-safe:animate-pulse" />
          </div>
        )}

        {task && awaiting && (
          <>
            <p className="text-[13px] leading-relaxed text-ink-soft">
              The plan is ready and waits for your decision before anything is spent.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void decide("approve")}
                className="min-h-9 rounded-md border border-teal/40 bg-teal/15 px-3.5 py-1.5 text-[12.5px] font-medium text-teal transition-colors hover:bg-teal/25"
              >
                Approve and run
              </button>
              <button
                type="button"
                onClick={() => void decide("reject")}
                className="min-h-9 rounded-md border border-edge px-3.5 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-edge-strong hover:text-ink"
              >
                Reject
              </button>
            </div>
          </>
        )}

        {task && running && !awaiting && (
          <div className="space-y-3">
            <p className="text-[12px] text-ink-faint" aria-live="polite">
              Working — updates appear here automatically.
            </p>
            <div className="max-h-56 overflow-y-auto rounded-md border border-edge bg-panel-2 px-3.5 py-2">
              <ActivityLog events={task.events.slice(-8)} />
            </div>
          </div>
        )}

        {task && TERMINAL_STATES.has(task.state) && (
          <div className="space-y-4">
            <OutcomeBlock task={task} />

            {done && task.result && (
              <>
                <div>
                  <p className="x-label mb-1">Evidence</p>
                  <EvidenceList evidence={task.result.evidence} />
                </div>
                <p className="tabular text-[11.5px] text-ink-faint">
                  Completed {clockOf(task.result.completedAt)} · spent {money(task.spend.spentUsdCents)} of the {money(task.spend.limitUsdCents)} ceiling · verified against the recorded evidence above
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Page: launcher + current operations                                 */
/* ------------------------------------------------------------------ */

export default function Operations() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [job, setJob] = useState<JobId>("research");
  // The operation the user launched on THIS page; the monitor below keeps it
  // visible here until the result shows, instead of sending people hunting
  // through the dashboard feed.
  const [lockedTaskId, setLockedTaskId] = useState<string | null>(null);
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
  const active = real.filter((t) => isOpen(t.state));

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="max-w-2xl">
        <h1 className="text-[22px] font-semibold tracking-tight">Operations</h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          Pick a job, configure it once, launch. Every operation runs through the same engine with your ceiling,
          your approval rule, and verifiable outcomes.
        </p>
      </div>

      {/* Job selector */}
      <div role="group" aria-label="Job type" className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {JOBS.map((j) => (
          <button
            key={j.id}
            type="button"
            aria-pressed={job === j.id}
            onClick={() => (j.status === "available" ? setJob(j.id) : undefined)}
            disabled={j.status === "planned"}
            className={`rounded-lg border p-4 text-left transition-colors ${
              job === j.id
                ? "border-blue/60 bg-panel"
                : j.status === "planned"
                  ? "cursor-not-allowed border-edge bg-panel/50 opacity-70"
                  : "border-edge bg-panel hover:border-edge-strong"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-ink">{j.name}</h3>
              {j.status === "available" ? (
                <span className="rounded-sm border border-teal/40 bg-teal/10 px-2 py-0.5 text-[10.5px] font-medium text-teal">Available</span>
              ) : (
                <span className="rounded-sm border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10.5px] font-medium text-gold">Planned</span>
              )}
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{j.blurb}</p>
            {j.status === "planned" && (
              <p className="mt-2 text-[11px] text-ink-faint">Marked planned. Requires capabilities the engine does not have yet.</p>
            )}
          </button>
        ))}
      </div>

      {/* Config panel */}
      <div className="mt-5 max-w-3xl">
        <JobConfig
          job={job}
          onStarted={refresh}
          activeGoals={active.map((t) => t.goal)}
          onLaunched={(t) => {
            setLockedTaskId(t.id);
            if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      </div>

      {lockedTaskId && (
        <div className="mt-5">
          <OperationMonitor
            taskId={lockedTaskId}
            onFinished={refresh}
            onDismiss={() => setLockedTaskId(null)}
          />
        </div>
      )}

      {tasks !== null && loadFailed && (
        <p aria-live="assertive" role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not load the task list. The view keeps retrying every few seconds.
        </p>
      )}

      {/* Current operations */}
      <section className="mt-8" aria-label="Current operations">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Current operations</h2>
          <span className="tabular text-[11px] text-ink-faint">{active.length} active</span>
        </div>
        {tasks === null && !loadFailed ? (
          <div aria-live="polite" className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 rounded-lg bg-panel-2 motion-safe:animate-pulse" />
            ))}
          </div>
        ) : active.length === 0 && !loadFailed ? (
          <div className="rounded-lg border border-dashed border-edge bg-panel/50 px-5 py-8 text-center">
            <p className="mx-auto max-w-sm text-[13px] text-ink-soft">
              No active operation. Launch one above.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((t) => {
              const spent = t.spend.spentUsdCents;
              const limit = t.spend.limitUsdCents;
              const pct = Math.min(100, Math.round((spent / Math.max(limit, 1)) * 100));
              const last = t.events[t.events.length - 1];
              const p = phaseState(t);
              return (
                <Link
                  key={t.id}
                  href={`/tasks/${t.id}`}
                  className="block rounded-lg border border-edge bg-panel p-4 transition-colors hover:border-edge-strong"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <StatusChip state={t.state} />
                    <span className="tabular text-[11px] text-ink-faint">
                      {t.origin.source === "telegram" ? "via Telegram" : "via web"}
                    </span>
                  </div>
                  <p className="mt-2 text-[13.5px] font-medium text-ink">{t.goal}</p>
                  <p className="mt-1.5 text-[12px] text-ink-soft">
                    <span className="tabular">{[p.plan && "planned", p.paid ? `${money(spent)} spent` : null, `${money(limit)} ceiling`].filter(Boolean).join(" · ")}</span>
                    {isTestRun(t) ? " · test run" : ""}
                  </p>
                  {last && <p className="mt-1 line-clamp-1 text-[12px] text-ink-faint">{last.message}</p>}
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
