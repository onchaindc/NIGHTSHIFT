"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
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
 *   the investigation (inputs per supported dimension → run mode → run)
 *     → the live investigation trail (state, spend, approval gate, events)
 *     → the per-dimension capability report (verified / route-only / gap)
 *     → operator access (sign-in, approve/reject)
 *
 * Honesty rules carried over from the flagship: a free preflight prices the
 * routes and records gaps; a paid run is one attempt per dimension behind the
 * human approval gate; nothing here upgrades a Mind's catalogue status.
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

const REPORT_STATUS_LABEL: Record<string, string> = {
  verified: "Signal verified",
  recorded: "Recorded, not proven",
  unverified: "Unverified",
  routable_unverified: "Route only",
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

  const missingRequired = routable.flatMap((d) =>
    d.params
      .filter((p) => p.required && !(inputs[d.id]?.[p.name] ?? "").trim())
      .map((p) => `${d.label}: ${p.name}`),
  );

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
  const eventTail = (task?.events ?? []).filter((e) => EVENT_TYPES.includes(e.type)).slice(-7);

  return (
    <div className="mt-8 space-y-6">
      {/* The investigation console — same arrangement as the flagship */}
      <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-labelledby="cap-console">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label" id="cap-console">The capability run</p>
        </div>
        <div className="space-y-5 px-4 py-4 sm:px-5">
          {routable.length > 0 ? (
            <div className="space-y-4">
              {routable.map((d) => (
                <div key={d.id}>
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] font-medium text-ink">
                    {d.label}
                    <span className="text-[10.5px] font-normal text-ink-faint">
                      {d.provider} · {fmtUsd((d.priceUsdCents ?? 1) / 100)}
                    </span>
                  </p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {d.params.map((p) => (
                      <div key={p.name}>
                        <label htmlFor={`in-${d.id}-${p.name}`} className="x-label">
                          {p.name}
                          {p.required ? <span className="text-risk"> *</span> : null}
                        </label>
                        <input
                          id={`in-${d.id}-${p.name}`}
                          value={inputs[d.id]?.[p.name] ?? ""}
                          onChange={(e) =>
                            setInputs((prev) => ({ ...prev, [d.id]: { ...prev[d.id], [p.name]: e.target.value } }))
                          }
                          placeholder={p.sample !== undefined ? String(p.sample) : p.description}
                          className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                        />
                        <p className="mt-1 text-[11px] leading-snug text-ink-faint">{p.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={fillSamples} className="btn-secondary !min-h-8 !text-[11.5px]">
                  <Wand2 size={12} aria-hidden /> Fill with sample values
                </button>
                <p className="text-[11px] text-ink-faint">
                  Samples are safe probe values from the capability matrix — replace them with the real subject.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              No routable dimension is defined for this Mind yet, so there is nothing to run.
            </p>
          )}

          <div>
            <p className="x-label">Run mode</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {[
                {
                  value: "free" as const,
                  title: "Free preflight",
                  body: "Probe every supported route with its canonical schema, record the live price and the gap ledger. No payment path exists.",
                },
                {
                  value: "intel" as const,
                  title: `Paid intelligence — ${fmtUsd(ceilingUsdCents / 100)} ceiling`,
                  body: "The same baseline, then one paid attempt per routable dimension after your explicit approval.",
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
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-edge pt-4">
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || routable.length === 0 || (mode === "intel" && session !== "authenticated")}
              className="btn-primary !min-h-10"
            >
              {starting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ArrowRight size={14} aria-hidden />}
              {mode === "free" ? "Run free preflight" : "Build plan & request approval"}
            </button>
            <p className="text-[11.5px] text-ink-faint">
              {mode === "intel" && session !== "authenticated" ? (
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
              ) : mode === "intel" ? (
                `Hard ceiling ${fmtUsd(ceilingUsdCents / 100)} · one attempt per dimension, skipped when the budget cannot cover it.`
              ) : (
                "Free mode plans no purchase and can spend nothing by construction."
              )}
            </p>
          </div>
          {missingRequired.length > 0 && mode === "intel" && (
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-amber-deep">
              <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden /> Missing required inputs: {missingRequired.join("; ")}
            </p>
          )}
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
                <p className="x-label !mt-0">Capability run</p>
                <span className="rounded-full border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] text-ink-soft">
                  {stateLabel(state)}
                </span>
              </div>
              {task && <span className="tabular text-[11px] text-ink-faint">spent {fmtUsd((task.spend?.spentUsdCents ?? 0) / 100)}</span>}
            </div>

            <div className="space-y-5 px-4 py-4 sm:px-5">
              {task?.goal && <p className="text-[12px] leading-relaxed text-ink-soft">{task.goal}</p>}

              {awaiting && (
                <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3.5">
                  <p className="flex items-center gap-2 text-[12.5px] font-medium text-amber-deep">
                    <ShieldCheck size={14} aria-hidden /> Approval gate
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                    The free probes priced {routable.length} dimension{routable.length === 1 ? "" : "s"} at {fmtUsd(ceilingUsdCents / 100)} total.
                    Approving releases one paid attempt per dimension, re-checked against each live offer. Unsupported dimensions are not
                    part of the plan.
                  </p>
                  <ul className="mt-2 space-y-1 text-[11.5px] text-ink-soft">
                    {routable.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span>{d.label}</span>
                        <span className="tabular text-[10.5px] text-ink-faint">
                          {d.provider} · {fmtUsd((d.priceUsdCents ?? 1) / 100)}
                        </span>
                      </li>
                    ))}
                  </ul>
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
                  {state === "verifying" ? "Verifying every committed answer against its node signal…" : "Working through the plan…"}
                </div>
              )}

              {eventTail.length > 0 && (
                <ol className="space-y-1.5 border-t border-edge pt-3">
                  {eventTail.map((e) => (
                    <li key={e.id} className="grid grid-cols-[76px_1fr] gap-2 text-[11.5px] leading-relaxed">
                      <span className="tabular text-ink-faint">{new Date(e.ts).toLocaleTimeString("en-US", { hour12: false })}</span>
                      <span className={e.type === "step_failed" ? "text-risk" : "text-ink-soft"}>{e.message}</span>
                    </li>
                  ))}
                </ol>
              )}

              {state === "failed" && task?.error && (
                <p className="rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-[12px] leading-relaxed text-risk">{task.error}</p>
              )}

              {redacted && state === "completed" && (
                <div className="rounded-lg border border-dashed border-edge bg-panel-2 px-3.5 py-3">
                  <p className="text-[12.5px] font-medium text-ink">The report is withheld from anonymous readers.</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
                    Sign in under Operator access below to read the findings, hashes and receipts. No report is reconstructed from the
                    public projection.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {!task && !running && (
          <p className="rounded-xl border border-dashed border-edge bg-panel-2 px-4 py-8 text-center text-[12.5px] leading-relaxed text-ink-faint">
            The capability report lands here — set the inputs above and run it.
          </p>
        )}

        {!redacted && report && state === "completed" && (
          <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-labelledby="cap-report">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-edge px-4 py-3 sm:px-5">
              <h2 id="cap-report" className="mt-1 text-[16px] font-medium tracking-[-0.01em] text-ink">
                {name} — capability report
              </h2>
              <span className="tabular text-[11px] text-ink-faint">
                verified {report.counts.verified} · route-only {report.counts.routable_unverified} · gaps {report.counts.gap} · spent{" "}
                {fmtUsd(report.spendUsdCents / 100)}
              </span>
            </div>
            <div className="space-y-4 px-4 py-4 sm:px-5">
              <p className="text-[12px] leading-relaxed text-ink-soft">{report.note}</p>
              <ul className="border-t border-edge">
                {report.dimensions.map((d) => (
                  <li key={d.dimension} className="grid gap-1.5 border-b border-edge py-3.5 sm:grid-cols-[10px_1fr_auto] sm:items-baseline sm:gap-3">
                    <span aria-hidden className={`mt-1.5 size-1.5 rounded-full ${STATUS_DOT[d.status]}`} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-[13px] font-medium text-ink">{d.label}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${REPORT_STATUS_TONE[d.status]}`}>
                          {REPORT_STATUS_LABEL[d.status]}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">{d.detail}</p>
                      {d.values && Object.keys(d.values).length > 0 && (
                        <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[11.5px] sm:grid-cols-2">
                          {Object.entries(d.values).slice(0, 12).map(([k, v]) => (
                            <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-3">
                              <dt className="text-ink-faint">{k}</dt>
                              <dd className="tabular text-ink">{String(v)}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {d.missingFields && d.missingFields.length > 0 && (
                        <p className="mt-1 text-[11px] text-amber-deep">Not returned: {d.missingFields.join(", ")}</p>
                      )}
                      <p className="mt-1 break-words text-[10.5px] text-ink-faint">
                        {d.intent ? <span className="tabular">{d.intent}</span> : null}
                        {d.provider ? <> · {d.provider}</> : null}
                        {d.priceUsdCents ? <> · {fmtUsd(d.priceUsdCents / 100)}</> : null}
                        {d.signalHash ? <> · signal {shortHash(d.signalHash)}</> : null}
                        {d.receiptHash ? <> · receipt {shortHash(d.receiptHash)}</> : null}
                      </p>
                    </div>
                    <span className="tabular text-[11px] text-ink-faint">
                      {d.status === "gap" ? "—" : d.priceUsdCents ? fmtUsd(d.priceUsdCents / 100) : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {report.missing.length > 0 && (
                <div className="rounded-lg border border-dashed border-edge bg-panel-2 px-3.5 py-3">
                  <p className="text-[12px] font-medium text-ink">Gap ledger</p>
                  <ul className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-ink-soft">
                    {report.missing.map((m) => (
                      <li key={m.dimension}>{m.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        )}

        {!redacted && !report && state === "completed" && task?.result?.mindsDelivery && (
          <section className="rounded-xl border border-edge bg-panel p-5">
            <p className="x-label !mt-0">Mind roundtrip complete</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
              The report was delivered to the connected Mind. Delivery status <span className="text-ink">{task.result.mindsDelivery.status}</span>.
              Spent {fmtUsd((task.spend?.spentUsdCents ?? 0) / 100)}.
            </p>
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
            {mindStatus === "available"
              ? "Paid runs sign exact x402 offers after this approval gate; every committed answer is re-derived against its node signal."
              : "This Mind stays marked in development: paid runs exercise its verified dimensions, but no paid answer has been verified for it yet."}
            {probedAt ? ` Capability matrix probed unpaid ${probedAt.slice(0, 10)}.` : ""}{" "}
            <Link href="/minds" className="text-teal hover:underline">
              All Minds
            </Link>
          </p>
        </div>
      </details>
    </div>
  );
}
