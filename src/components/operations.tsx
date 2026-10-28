"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@/lib/engine/types";
import {
  StatusChip,
  isOpen,
  isTestRun,
  money,
  phaseState,
} from "@/components/taskParts";
import { buildTaskRequest, cleanLimit, FORM_ERROR_COPY } from "@/lib/ui/taskForm";

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
}: {
  job: JobId;
  activeGoals: string[];
  onStarted: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [limit, setLimit] = useState("1.00");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveGoalsRef = useRef(activeGoals);
  liveGoalsRef.current = activeGoals;
  const def = JOBS.find((j) => j.id === job)!;
  const examples = def.examples ?? [];

  async function submit() {
    const built = buildTaskRequest({
      goal,
      limitRaw: limit,
      requiresApproval,
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
      } else {
        setGoal("");
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
/* Page: launcher + current operations                                 */
/* ------------------------------------------------------------------ */

export default function Operations() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [job, setJob] = useState<JobId>("research");
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
        />
      </div>

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
