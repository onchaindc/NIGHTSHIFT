"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  LockKeyhole,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wand2,
} from "lucide-react";

import type { TaskRecord } from "@/lib/engine/types";
import type { CapabilityReport } from "@/lib/minds/capability-runner";

/**
 * The shared capability console — the same visual arrangement as the Bitcoin
 * Mining Intelligence page, generic over any Mind's verified matrix:
 *
 *   inputs (compact) → run mode → the live trail (state, spend, approval
 *   gate, events) → a plain-language capability report → operator access
 *
 * Honesty rules carried over from the flagship: a free preflight prices the
 * routes and records gaps; a paid run is one attempt per dimension behind the
 * human approval gate; nothing here rewrites a Mind's catalogue status.
 * Machine evidence (intents, providers, hashes) is available but collapsed —
 * the page speaks to the reader, the audit trail is one click away.
 */

export interface ConsoleParamView {
  name: string;
  required: boolean;
  description: string;
  sample?: string | number;
}

export interface ConsoleDimensionView {
  id: string;
  label: string;
  requirement: string;
  status: "verified" | "partial" | "gap";
  intent?: string;
  provider?: string;
  priceUsdCents?: number;
  params: ConsoleParamView[];
}

export interface CapabilityConsoleProps {
  slug: string;
  name: string;
  /** The catalogue status of the owning Mind — the console never changes it. */
  mindStatus: "available" | "in_development" | "planned";
  ceilingUsdCents: number;
  dimensions: ConsoleDimensionView[];
  probedAt?: string;
}

type Session = "loading" | "anonymous" | "authenticated" | "unavailable";

const TERMINAL = new Set(["completed", "failed", "rejected", "blocked"]);

const EVENT_TYPES = [
  "step_started",
  "capability_baseline_ready",
  "spend_recorded",
  "step_failed",
  "verification_started",
  "verification_passed",
  "task_completed",
];

const REPORT_STATUS_TONE: Record<string, string> = {
  verified: "border-teal/30 bg-teal/5 text-teal",
  recorded: "border-amber/40 bg-amber-soft/40 text-amber-deep",
  unverified: "border-risk/30 bg-risk/5 text-risk",
  routable_unverified: "border-edge bg-panel-2 text-ink-faint",
  gap: "border-edge bg-panel-2 text-ink-faint",
};

/** Reader-facing status words; the machine label stays in the evidence drawer. */
const REPORT_STATUS_LABEL: Record<string, string> = {
  verified: "Answer verified",
  recorded: "Answer recorded",
  unverified: "Could not verify",
  routable_unverified: "Priced, not purchased",
  gap: "Unsupported",
};

const STATUS_DOT: Record<string, string> = {
  verified: "bg-teal",
  recorded: "bg-amber",
  unverified: "bg-risk",
  routable_unverified: "bg-ink-faint/40",
  gap: "bg-ink-faint/40",
};

function sessionMode(body: unknown): Session {
  if (!body || typeof body !== "object") return "unavailable";
  const mode = (body as { mode?: unknown }).mode;
  return mode === "operator" ? "authenticated" : mode === "anonymous" ? "anonymous" : "unavailable";
}

function fmtUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function shortHash(hash: string | undefined): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "—";
}

/** vessels_waiting → "Vessels waiting" */
function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Reader-friendly values; null drops the row entirely. */
function humanizeValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toLocaleString("en-US") : String(Math.round(v * 1000) / 1000);
  }
  if (typeof v === "object") return null; // nested structures stay in raw evidence
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** "verified against the node signal; Independent re-derivation matches: keccak…" → "Independently re-derived against the node signal." */
function plainDetail(status: string, detail: string): string {
  if (status === "verified") return "Live answer, independently re-derived against the node signal.";
  if (status === "recorded") return "The provider returned an answer; verification could not confirm it end to end.";
  if (status === "unverified") return "The provider returned an answer that failed verification. Treat as unconfirmed.";
  if (status === "routable_unverified") return "Route priced live; no answer was purchased on this run.";
  return detail;
}

function stateLabel(state: string | null): string {
  switch (state) {
    case "created":
    case "planning":
      return "Planning";
    case "awaiting_approval":
      return "Awaiting approval";
    case "executing":
      return "Executing";
    case "verifying":
      return "Verifying evidence";
    case "completed":
      return "Report ready";
    case "rejected":
      return "Rejected";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    default:
      return "Objective";
  }
}

function friendlyError(status: number, detail?: string): string {
  if (status === 401) return "The operator session was not accepted. Sign in with the deployment token and retry.";
  return detail || `The request failed (HTTP ${status}).`;
}

export default function CapabilityConsole({ slug, name, mindStatus, ceilingUsdCents, dimensions, probedAt }: CapabilityConsoleProps) {
  const routable = dimensions.filter((d) => d.status !== "gap");
  const [inputs, setInputs] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(routable.map((d) => [d.id, Object.fromEntries(d.params.map((p) => [p.name, ""]))])),
  );
  const [mode, setMode] = useState<"free" | "intel">("free");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [redacted, setRedacted] = useState(false);
  const [session, setSession] = useState<Session>("loading");
  const [token, setToken] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approveGraceUntil = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);
  const opsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (mode === "intel" && session === "anonymous") {
      if (opsRef.current) opsRef.current.open = true;
    }
  }, [mode, session]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/session", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled) setSession(sessionMode(body));
      })
      .catch(() => {
        if (!cancelled) setSession("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { task?: TaskRecord; redacted?: boolean };
        if (!body.task) return;
        if (body.task.state === "awaiting_approval" && Date.now() < approveGraceUntil.current) {
          setTask({ ...body.task, state: "executing" });
          setRedacted(!!body.redacted);
          return;
        }
        setTask(body.task);
        setRedacted(!!body.redacted);
        if (TERMINAL.has(body.task.state)) stopPolling();
      } catch {
        /* transient; next poll retries */
      }
    },
    [stopPolling],
  );

  const poll = useCallback(
    (id: string) => {
      stopPolling();
      void load(id);
      pollRef.current = setInterval(() => void load(id), 3000);
    },
    [load, stopPolling],
  );

  useEffect(() => {
    const id = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("task");
    if (id) {
      setTaskId(id);
      poll(id);
    }
    return () => stopPolling();
  }, [poll, stopPolling]);

  const writeUrl = (id: string | null) => {
    if (typeof window === "undefined") return;
    const url = id ? `/minds/${slug}?task=${encodeURIComponent(id)}` : `/minds/${slug}`;
    window.history.replaceState(null, "", url);
  };

  const fillSamples = () => {
    setInputs(
      Object.fromEntries(
        routable.map((d) => [
          d.id,
          Object.fromEntries(d.params.map((p) => [p.name, p.sample !== undefined ? String(p.sample) : inputs[d.id]?.[p.name] ?? ""])),
        ]),
      ),
    );
  };

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    setActionError(null);
    stopPolling();
    setTask(null);
    setTaskId(null);
    setRedacted(false);
    writeUrl(null);
    try {
      const res = await fetch(`/api/minds/${encodeURIComponent(slug)}/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          inputs: Object.fromEntries(
            routable.map((d) => [
              d.id,
              Object.fromEntries(Object.entries(inputs[d.id] ?? {}).filter(([, v]) => v.trim() !== "")),
            ]),
          ),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { task?: TaskRecord; error?: string };
      if (!res.ok || !body.task) {
        if (res.status === 401) setSession("anonymous");
        setError(friendlyError(res.status, body.error));
        return;
      }
      setTask(body.task);
      setTaskId(body.task.id);
      writeUrl(body.task.id);
      poll(body.task.id);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch {
      setError(friendlyError(0));
    } finally {
      setStarting(false);
    }
  }, [slug, mode, inputs, poll, stopPolling]);

  const act = useCallback(
    async (action: "approve" | "reject") => {
      if (!taskId) return;
      setActing(action);
      setActionError(null);
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setActionError(friendlyError(res.status, body.error));
          if (res.status === 401) setSession("anonymous");
          return;
        }
        if (action === "approve") {
          approveGraceUntil.current = Date.now() + 8000;
          setTask((t) => (t ? { ...t, state: "executing" } : t));
          poll(taskId);
        } else {
          stopPolling();
          await load(taskId);
        }
      } catch {
        setActionError(friendlyError(0));
      } finally {
        setActing(null);
      }
    },
    [taskId, poll, load, stopPolling],
  );

  const signIn = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setSignInError("Enter the operator token first.");
      return;
    }
    setSigningIn(true);
    setSignInError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        setSignInError(res.status === 401 ? "That token was not accepted." : friendlyError(res.status));
        return;
      }
      const check = await fetch("/api/session", { cache: "no-store" });
      const body = await check.json().catch(() => null);
      setSession(sessionMode(body));
      setToken("");
    } catch {
      setSignInError(friendlyError(0));
    } finally {
      setSigningIn(false);
    }
  }, [token]);

  const state = task?.state ?? null;
  const awaiting = state === "awaiting_approval";
  const running = state === "created" || state === "planning" || state === "executing" || state === "verifying";
  const report = task?.result?.capabilityReport as CapabilityReport | undefined;
  const eventTail = (task?.events ?? []).filter((e) => EVENT_TYPES.includes(e.type)).slice(-5);
  const answers = report ? report.counts.verified + report.counts.recorded + report.counts.unverified : 0;
  const priced = report ? report.counts.routable_unverified : 0;

  return (
    <div className="mt-8 space-y-5">
      {/* The run console */}
      <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-labelledby="cap-console">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label !mt-0" id="cap-console">Run an investigation</p>
          <span className="text-[11px] text-ink-faint">
            {routable.length} routes · free preflight open · paid ceiling {fmtUsd(ceilingUsdCents / 100)}
          </span>
        </div>
        <div className="space-y-4 px-4 py-4 sm:px-5">
          {routable.length > 0 ? (
            <div className="space-y-3.5">
              {routable.map((d) => (
                <div key={d.id}>
                  <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                    {d.label}
                    <span className="ml-2 normal-case tracking-normal text-ink-faint/80">{fmtUsd((d.priceUsdCents ?? 1) / 100)}</span>
                  </p>
                  <div className="mt-1.5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                    {d.params.map((p) => (
                      <input
                        key={p.name}
                        value={inputs[d.id]?.[p.name] ?? ""}
                        onChange={(e) =>
                          setInputs((prev) => ({ ...prev, [d.id]: { ...prev[d.id], [p.name]: e.target.value } }))
                        }
                        placeholder={p.description}
                        aria-label={`${d.label}: ${p.description}`}
                        className="h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={fillSamples} className="btn-secondary !min-h-8 !text-[11.5px]">
                  <Wand2 size={12} aria-hidden /> Fill with sample values
                </button>
                <p className="text-[11px] text-ink-faint">Samples are safe probe values — replace them with the real subject.</p>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              No routable dimension is defined for this Mind yet, so there is nothing to run.
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {[
              {
                value: "free" as const,
                title: "Free preflight",
                body: "Prices every route, records the gap ledger. No payment path exists.",
              },
              {
                value: "intel" as const,
                title: `Paid answers — up to ${fmtUsd(ceilingUsdCents / 100)}`,
                body: "Waits for your approval; a failed route is re-routed once automatically.",
              },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                aria-pressed={mode === opt.value}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  mode === opt.value ? "border-teal/50 bg-teal/5" : "border-edge bg-panel-2 hover:border-ink-faint/50"
                }`}
              >
                <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                  {opt.value === "free" ? <Radio size={13} aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
                  {opt.title}
                </span>
                <span className="mt-1 block text-[11.5px] leading-relaxed text-ink-soft">{opt.body}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-edge pt-3.5">
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || routable.length === 0 || (mode === "intel" && session !== "authenticated")}
              className="btn-primary !min-h-10"
            >
              {starting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ArrowRight size={14} aria-hidden />}
              {mode === "free" ? "Run free preflight" : "Build plan & request approval"}
            </button>
            {mode === "intel" && session !== "authenticated" && (
              <button
                type="button"
                onClick={() => {
                  if (opsRef.current) {
                    opsRef.current.open = true;
                    opsRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
                  }
                }}
                className="text-[11.5px] font-medium text-teal hover:underline"
              >
                Sign in below — paid runs need the operator token
              </button>
            )}
          </div>
          {error && (
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-risk">
              <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden /> {error}
            </p>
          )}
        </div>
      </section>

      <div ref={resultRef}>
        {(task || running) && (
          <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3 sm:px-5">
              <div className="flex items-center gap-2">
                <p className="x-label !mt-0">Run</p>
                <span className="rounded-full border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] text-ink-soft">
                  {stateLabel(state)}
                </span>
              </div>
              {task && <span className="tabular text-[11px] text-ink-faint">spent {fmtUsd((task.spend?.spentUsdCents ?? 0) / 100)}</span>}
            </div>

            <div className="space-y-4 px-4 py-4 sm:px-5">
              {awaiting && (
                <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3.5">
                  <p className="flex items-center gap-2 text-[12.5px] font-medium text-amber-deep">
                    <ShieldCheck size={14} aria-hidden /> Approval gate
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                    {routable.length} route{routable.length === 1 ? "" : "s"} priced at {fmtUsd(ceilingUsdCents / 100)} total. Approving
                    releases each pinned route, re-checked against its live offer; a failed route is re-routed once through the
                    node's router. Spend never exceeds this ceiling.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void act("approve")} disabled={!!acting} className="btn-primary !min-h-9">
                      {acting === "approve" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
                      Approve {fmtUsd(ceilingUsdCents / 100)} run
                    </button>
                    <button type="button" onClick={() => void act("reject")} disabled={!!acting} className="btn-secondary !min-h-9">
                      Reject
                    </button>
                  </div>
                  {actionError && <p className="mt-2 text-[12px] text-risk">{actionError}</p>}
                </div>
              )}

              {running && (
                <div className="flex items-center gap-2 text-[12px] text-ink-soft">
                  <Loader2 size={13} className="animate-spin text-teal" aria-hidden />
                  {state === "verifying" ? "Verifying every answer against its node signal…" : "Working through the plan…"}
                </div>
              )}

              {eventTail.length > 0 && (
                  <ol className="space-y-1.5 border-t border-edge pt-3">
                  {eventTail.map((e) => (
                    <li key={e.id} className="grid grid-cols-[64px_1fr] gap-2 text-[11.5px] leading-relaxed">
                      <span className="tabular text-ink-faint">{new Date(e.ts).toLocaleTimeString("en-US", { hour12: false })}</span>
                      <span className={`min-w-0 break-words [overflow-wrap:anywhere] ${e.type === "step_failed" ? "text-risk" : "text-ink-soft"}`}>{e.message}</span>
                    </li>
                  ))}
                </ol>
              )}

              {state === "failed" && task?.error && (
                <p className="rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-[12px] leading-relaxed break-words [overflow-wrap:anywhere] text-risk">{task.error}</p>
              )}

              {redacted && state === "completed" && (
                <div className="rounded-lg border border-dashed border-edge bg-panel-2 px-3.5 py-3">
                  <p className="text-[12.5px] font-medium text-ink">The report is withheld from anonymous readers.</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
                    Sign in under Operator access below to read the findings.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {!task && !running && (
          <p className="rounded-xl border border-dashed border-edge bg-panel-2 px-4 py-7 text-center text-[12.5px] leading-relaxed text-ink-faint">
            The report lands here — set the inputs above and run it.
          </p>
        )}

        {/* The report — plain language first, evidence collapsed */}
        {!redacted && report && state === "completed" && (
          <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-labelledby="cap-report">
            <div className="border-b border-edge px-4 py-3 sm:px-5">
              <h2 id="cap-report" className="text-[16px] font-medium tracking-[-0.01em] text-ink">
                {name} — report
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                {answers > 0 ? (
                  <>
                    <span className="font-medium text-ink">{answers} of {routable.length}</span> routes returned live answers
                    {report.counts.verified > 0 ? " and were re-verified against the network signal" : ""}.
                  </>
                ) : (
                  <>
                    No answers were purchased on this run — <span className="font-medium text-ink">{priced}</span> route
                    {priced === 1 ? "" : "s"} priced live, all recorded below.
                  </>
                )}{" "}
                Spent {fmtUsd(report.spendUsdCents / 100)}.
              </p>
            </div>
            <ul className="border-t border-edge">
              {report.dimensions.map((d) => {
                const values = Object.entries(d.values ?? {})
                  .map(([k, v]) => [humanizeKey(k), humanizeValue(v)] as const)
                  .filter(([, v]) => v !== null)
                  .slice(0, 10);
                return (
                  <li key={d.dimension} className="border-b border-edge px-4 py-3.5 sm:px-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span aria-hidden className={`inline-block size-1.5 rounded-full ${STATUS_DOT[d.status]}`} />
                        <span className="text-[13.5px] font-medium text-ink">{d.label}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${REPORT_STATUS_TONE[d.status]}`}>
                          {REPORT_STATUS_LABEL[d.status]}
                        </span>
                      </p>
                      {d.priceUsdCents ? (
                        <span className="tabular text-[11px] text-ink-faint">{fmtUsd(d.priceUsdCents / 100)}</span>
                      ) : null}
                    </div>
                    {values.length > 0 ? (
                      <dl className="mt-2 grid gap-x-4 gap-y-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-2.5 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
                        {values.map(([k, v]) => (
                          <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-3">
                            <dt className="text-ink-faint">{k}</dt>
                            <dd className="tabular min-w-0 break-words text-ink">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{plainDetail(d.status, d.detail)}</p>
                    )}
                    {d.missingFields && d.missingFields.length > 0 && (
                      <p className="mt-1 text-[11px] break-words text-amber-deep">
                        Not returned: {d.missingFields.map(humanizeKey).join(", ")}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            <details className="group border-t border-edge">
              <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-[11.5px] text-ink-faint sm:px-5">
                Evidence — intents, providers, signal hashes
                <ChevronDown size={13} aria-hidden className="transition-transform group-open:rotate-180" />
              </summary>
              <ul className="border-t border-edge px-4 py-2 text-[10.5px] leading-relaxed text-ink-faint sm:px-5">
                {report.dimensions.map((d) => (
                  <li key={d.dimension} className="break-words border-b border-edge/60 py-1.5 last:border-0">
                    <span className="text-ink-soft">{d.label}</span>
                    {" — "}
                    {d.intent ?? "no intent"}
                    {d.provider ? <> · {d.provider}</> : null}
                    {d.signalHash ? <> · signal {shortHash(d.signalHash)}</> : null}
                    {d.receiptHash ? <> · receipt {shortHash(d.receiptHash)}</> : null}
                    {d.verifiedAt ? <> · {new Date(d.verifiedAt).toLocaleString("en-US", { hour12: false })}</> : null}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        )}
      </div>

      <details ref={opsRef} className="overflow-hidden rounded-xl border border-edge bg-panel">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <span className="x-label !mt-0">Operator access</span>
          {session === "authenticated" ? (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-teal">
              <span aria-hidden className="size-1.5 rounded-full bg-teal" /> Signed in
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint">
              <span aria-hidden className="size-1.5 rounded-full bg-ink-faint/60" /> Browsing anonymously
            </span>
          )}
        </summary>
        <div className="border-t border-edge px-4 py-3 sm:px-5">
          {session === "authenticated" ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] leading-relaxed text-ink-soft">
                This browser can approve the paid plan and read the full evidence trail.
              </p>
              <button
                type="button"
                onClick={async () => {
                  await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
                  setSession("anonymous");
                }}
                className="btn-secondary !min-h-8 !text-[11.5px]"
              >
                Sign out
              </button>
            </div>
          ) : (
            <form onSubmit={signIn} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1">
                <label htmlFor={`ops-token-${slug}`} className="x-label">Deployment token</label>
                <div className="relative mt-1.5">
                  <LockKeyhole size={13} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
                  <input
                    id={`ops-token-${slug}`}
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="NIGHTSHIFT_API_TOKEN"
                    autoComplete="off"
                    className="h-10 w-full rounded-lg border border-edge bg-panel-2 pl-8 pr-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                  />
                </div>
              </div>
              <button type="submit" disabled={signingIn} className="btn-primary !min-h-10">
                {signingIn ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}
                Sign in
              </button>
              {signInError && <p className="w-full text-[12px] text-risk">{signInError}</p>}
            </form>
          )}
          <p className="mt-3 border-t border-edge pt-3 text-[11px] leading-relaxed text-ink-faint">
            Paid runs sign exact x402 offers after the approval gate; every committed answer is re-derived against its node
            signal before the report is written.{probedAt ? ` Capability matrix probed unpaid ${probedAt.slice(0, 10)}.` : ""}{" "}
            <Link href="/minds" className="text-teal hover:underline">
              All Minds
            </Link>
          </p>
        </div>
      </details>
    </div>
  );
}
