"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Cpu,
  Loader2,
  LockKeyhole,
  Radio,
  ShieldCheck,
  Zap,
} from "lucide-react";

import type { TaskRecord } from "@/lib/engine/types";
import type { CapabilityReport } from "@/lib/minds/capability-runner";
import type { BitcoinMiningReport } from "@/lib/bitcoinmining/report";

export interface BitcoinDimensionView {
  id: string;
  label: string;
  requirement: string;
  status: "verified" | "partial" | "gap";
  intent?: string;
  provider?: string;
  priceUsdCents?: number;
  limitation?: string;
  missingReason?: string;
  resolution?: string;
}

export interface BitcoinMiningGuarantees {
  nodeUrl: string;
  ceilingUsdCents: number;
  dimensions: BitcoinDimensionView[];
}

type Session = "loading" | "anonymous" | "authenticated" | "unavailable";

const ZONES = ["HB_WEST", "HB_NORTH", "HB_SOUTH", "HB_HOUSTON", "LZ_WEST", "LZ_NORTH", "LZ_SOUTH", "LZ_HOUSTON"];

const TERMINAL = new Set(["completed", "failed", "rejected", "blocked"]);

function sessionMode(body: unknown): Session {
  if (!body || typeof body !== "object") return "unavailable";
  const mode = (body as { mode?: unknown }).mode;
  return mode === "operator" ? "authenticated" : mode === "anonymous" ? "anonymous" : "unavailable";
}

function previousHourUtc(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() - 1);
  return `${d.toISOString().slice(0, 13)}:00:00Z`;
}

function fmtUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function shortHash(hash: string | undefined): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "—";
}

function stateLabel(state: string | null): string {
  switch (state) {
    case "created":
      return "Planning";
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
  if (status === 503) return detail || "The required live lookup is unavailable. Supply the value explicitly and retry.";
  return detail || `The request failed (HTTP ${status}).`;
}

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

export default function BitcoinMiningClient({ guarantees }: { guarantees: BitcoinMiningGuarantees }) {
  const [blockHeight, setBlockHeight] = useState("");
  const [zone, setZone] = useState("HB_WEST");
  const [intervalStart, setIntervalStart] = useState<string>(() => previousHourUtc());
  const [mode, setMode] = useState<"free" | "intel">("free");
  const [session, setSession] = useState<Session>("loading");
  const [token, setToken] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [redacted, setRedacted] = useState(false);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approveGraceUntil = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);

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
    const url = id ? `/minds/bitcoin-mining?task=${encodeURIComponent(id)}` : "/minds/bitcoin-mining";
    window.history.replaceState(null, "", url);
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
      const res = await fetch("/api/mind/bitcoin-mining", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blockHeight: blockHeight.trim() || undefined,
          zone,
          intervalStart,
          mode,
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
  }, [blockHeight, zone, intervalStart, mode, poll, stopPolling]);

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
      if (sessionMode(await check.json().catch(() => null)) !== "authenticated") {
        setSignInError("The session cookie did not stick. Allow cookies for this site and retry.");
        return;
      }
      setToken("");
      setSession("authenticated");
      if (taskId) void load(taskId);
    } catch {
      setSignInError(friendlyError(0));
    } finally {
      setSigningIn(false);
    }
  }, [token, taskId, load]);

  const state = task?.state ?? null;
  const awaiting = state === "awaiting_approval";
  const running = state === "created" || state === "planning" || state === "executing" || state === "verifying";
  const report = task?.result?.bitcoinMiningReport;
  const capabilityReport = task?.result?.capabilityReport;
  const eventTail = (task?.events ?? []).filter((e) =>
    [
      "step_started",
      "capability_baseline_ready",
      "spend_recorded",
      "step_failed",
      "verification_started",
      "verification_passed",
      "task_completed",
      "delivery_succeeded",
      "delivery_skipped",
    ].includes(e.type),
  ).slice(-7);

  return (
    <div className="mt-8 space-y-6">
      <section className="overflow-hidden rounded-xl border border-edge bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label">Operator access</p>
          {session === "authenticated" ? (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-teal">
              <span aria-hidden className="size-1.5 rounded-full bg-teal" /> Signed in
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint">
              <span aria-hidden className="size-1.5 rounded-full bg-ink-faint/60" /> Browsing anonymously
            </span>
          )}
        </div>
        <div className="px-4 py-3 sm:px-5">
          {session === "authenticated" ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] leading-relaxed text-ink-soft">
                This browser can approve the three-cent plan and read the full evidence trail.
              </p>
              <button
                type="button"
                onClick={async () => {
                  await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
                  setSession("anonymous");
                  if (taskId) void load(taskId);
                }}
                className="text-[11.5px] font-medium text-ink-faint transition-colors hover:text-ink"
              >
                Sign out
              </button>
            </div>
          ) : (
            <>
              <p className="text-[12px] leading-relaxed text-ink-soft">
                Free preflights are open. Approving a paid run and reading its full report need the operator token.
              </p>
              <form onSubmit={signIn} className="mt-2.5 flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1">
                  <span className="x-label">Operator token</span>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setSignInError(null);
                    }}
                    placeholder="Paste the operator token"
                    autoComplete="off"
                    enterKeyHint="go"
                    className="mt-1 h-9 w-full rounded-md border border-edge bg-panel-2 px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                  />
                </label>
                <button type="submit" disabled={signingIn} className="btn-secondary !min-h-9">
                  {signingIn ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <LockKeyhole size={12} aria-hidden />}
                  Sign in
                </button>
              </form>
              {signInError && <p className="mt-1.5 text-[12px] text-risk">{signInError}</p>}
            </>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-labelledby="objective">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label" id="objective">1 · Define the objective</p>
        </div>
        <div className="space-y-5 px-4 py-4 sm:px-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="bm-height" className="x-label">Bitcoin block height</label>
              <input
                id="bm-height"
                value={blockHeight}
                onChange={(e) => setBlockHeight(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
                placeholder="Current tip"
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] tabular text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
              />
              <p className="mt-1.5 text-[11px] text-ink-faint">Blank resolves the current tip. Historical blocks are flagged in the report.</p>
            </div>
            <div>
              <label htmlFor="bm-zone" className="x-label">ERCOT hub / zone</label>
              <select
                id="bm-zone"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none focus:ring-1 focus:ring-edge"
              >
                {ZONES.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-ink-faint">The site&apos;s settlement hub, not a retail tariff.</p>
            </div>
            <div>
              <label htmlFor="bm-interval" className="x-label">Settlement interval</label>
              <input
                id="bm-interval"
                value={intervalStart}
                onChange={(e) => setIntervalStart(e.target.value)}
                placeholder="2026-11-23T00:00:00-06:00"
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[12px] tabular text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
              />
              <p className="mt-1.5 text-[11px] text-ink-faint">RFC 3339 with timezone. UTC is accepted; use -06:00 for ERCOT local.</p>
            </div>
          </div>

          <div>
            <p className="x-label">2 · Choose the run</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {[
                { value: "free" as const, title: "Free preflight", body: "Probe all three routes, record live prices and the gap ledger. No payment." },
                { value: "intel" as const, title: "Paid intelligence — $0.03 ceiling", body: "Three signal-verified asks after your explicit approval, then the mining report." },
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
              disabled={starting || (mode === "intel" && session !== "authenticated")}
              className="btn-primary !min-h-10"
            >
              {starting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ArrowRight size={14} aria-hidden />}
              {mode === "free" ? "Run free preflight" : "Build plan & request approval"}
            </button>
            <p className="text-[11.5px] text-ink-faint">
              {mode === "intel" && session !== "authenticated"
                ? "Sign in above to request a paid plan."
                : `Hard ceiling ${fmtUsd(guarantees.ceilingUsdCents / 100)} · one attempt per dimension.`}
            </p>
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
                <p className="x-label !mt-0">3 · Investigation</p>
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
                    The free probes priced three dimensions at {fmtUsd(guarantees.ceilingUsdCents / 100)} total. Approving releases
                    one paid attempt per dimension, re-checked against each live offer. Pool concentration and fleet uptime are
                    not part of the plan.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void act("approve")} disabled={!!acting} className="btn-primary !min-h-9">
                      {acting === "approve" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
                      Approve $0.03 run
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
                  {state === "verifying" ? "Verifying every committed answer against its node signal…" : "Working through the approved plan…"}
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
                    Sign in with the operator token above to read the findings, hashes and receipts. No report is reconstructed from
                    the public projection.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {!redacted && report && state === "completed" && (
        <MiningReportView report={report} capability={capabilityReport} />
      )}

      {!redacted && !report && state === "completed" && capabilityReport && (
        <section className="rounded-xl border border-edge bg-panel p-5">
          <p className="x-label !mt-0">Preflight complete</p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
            Three routes were priced. No paid answer was purchased, so there are no mining findings to report.
          </p>
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-edge bg-panel p-5">
          <p className="x-label !mt-0">What runs</p>
          <ul className="mt-3 space-y-2.5">
            {guarantees.dimensions.filter((d) => d.status !== "gap").map((d) => (
              <li key={d.id} className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-soft">
                <Check size={13} className="mt-0.5 shrink-0 text-teal" aria-hidden />
                <span>
                  <span className="text-ink">{d.label}</span> · {d.provider} · {fmtUsd((d.priceUsdCents ?? 1) / 100)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-edge bg-panel p-5">
          <p className="x-label !mt-0">What remains unsupported</p>
          <ul className="mt-3 space-y-2.5">
            {guarantees.dimensions.filter((d) => d.status === "gap").map((d) => (
              <li key={d.id} className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-soft">
                <CircleAlert size={13} className="mt-0.5 shrink-0 text-ink-faint" aria-hidden />
                <span>
                  <span className="text-ink">{d.label}</span> — {d.missingReason ?? "no verified route"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-edge pt-2.5 text-[11px] leading-relaxed text-ink-faint">
            Every report repeats the gap ledger. No gap is estimated from a neighbouring intent.
          </p>
        </div>
      </section>
    </div>
  );
}

function MiningReportView({
  report,
  capability,
}: {
  report: BitcoinMiningReport;
  capability?: CapabilityReport;
}) {
  const f = report.findings;
  const verifiedCount = capability?.counts.verified ?? 0;

  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-labelledby="mining-report">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-4 py-4 sm:px-5">
        <div>
          <p className="x-label !mt-0">{report.mode === "free" ? "4 · Preflight evidence" : "4 · Intelligence report"}</p>
          <h2 id="mining-report" className="mt-1 text-[18px] font-medium tracking-[-0.01em] text-ink">
            {report.objective
              ? `${report.mode === "free" ? "Preflight" : "Block"} ${report.objective.blockHeight} · ${report.objective.zone}`
              : "Bitcoin mining economics"}
          </h2>
          <p className="mt-1 text-[11.5px] text-ink-faint">
            {report.objective?.intervalStart ?? "Settlement interval unavailable"} · {verifiedCount}/3 signal-verified answers ·{" "}
            {fmtUsd(report.spendUsdCents / 100)} spent
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] ${
            report.confidence === "signal-verified"
              ? "border-teal/30 bg-teal/5 text-teal"
              : "border-amber/40 bg-amber-soft/40 text-amber-deep"
          }`}
        >
          {report.mode === "free" ? "Preflight only" : report.confidence}
        </span>
      </div>

      {report.mode === "intel" ? (
        <div className="grid gap-px bg-edge sm:grid-cols-2 lg:grid-cols-4">
          <Kpi icon={<Cpu size={14} />} label="Hashprice" value={fmtUsd(f.hashpriceUsdPerPhDay)} unit="USD / PH / day" />
          <Kpi icon={<Zap size={14} />} label="BTC spot" value={fmtUsd(f.btcPriceUsd)} unit="USD / BTC" />
          <Kpi icon={<Radio size={14} />} label={`ERCOT ${f.energyZone ?? ""}`} value={fmtUsd(f.lmpUsdPerMwh)} unit="USD / MWh" />
          <Kpi
            icon={<ShieldCheck size={14} />}
            label="Break-even efficiency"
            value={report.breakEven ? `${fmtNum(report.breakEven.efficiencyJPerTh, 1)}` : "—"}
            unit="J / TH at these prices"
          />
        </div>
      ) : (
        <div className="border-b border-edge bg-panel-2 px-4 py-3 text-[12px] leading-relaxed text-ink-soft sm:px-5">
          No offer was signed. The routes below were priced by unpaid probes; they are not findings. Approve the three-cent plan
          to buy and verify the answers.
        </div>
      )}

      <div className="space-y-5 px-4 py-4 sm:px-5">
        {report.mode === "intel" && !report.alignment.aligned && (
          <div className="rounded-lg border border-amber/40 bg-amber-soft/40 px-3.5 py-3">
            <p className="flex items-center gap-2 text-[12px] font-medium text-amber-deep">
              <CircleAlert size={13} aria-hidden /> Read the timestamps before using this as a current operating picture
            </p>
            <ul className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-ink-soft">
              {report.alignment.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        <div className={report.mode === "free" ? "hidden" : undefined}>
          <p className="x-label">Findings</p>
          <dl className="mt-2 divide-y divide-edge border-y border-edge">
            <Finding label="Network hashrate" value={`${fmtNum(f.hashrateEhS)} EH/s`} detail={`block ${f.blockHeight ?? "—"} · ${f.blockTime ?? "timestamp unavailable"}`} />
            <Finding label="Hashprice (sats)" value={`${fmtNum(f.hashpriceSatsPerPhDay, 2)} sats / PH / day`} detail="Committed by the hashprice provider" />
            <Finding
              label="Hashprice (USD)"
              value={fmtUsd(f.hashpriceUsdPerPhDay)}
              detail={
                f.hashpriceUsdBasis === "derived_from_btc"
                  ? "Derived: committed sats × separately committed BTC spot price"
                  : "Reported directly by the provider"
              }
            />
            <Finding
              label="BTC spot price"
              value={fmtUsd(f.btcPriceUsd)}
              detail={f.btcVerifiedAt ? `Signal recorded ${new Date(f.btcVerifiedAt).toLocaleString("en-US")}` : "Committed price"}
            />
            <Finding
              label={`ERCOT LMP · ${f.energyZone ?? "zone"}`}
              value={`${fmtUsd(f.lmpUsdPerMwh)} / MWh`}
              detail={`${f.energyMarket ?? "market"} · interval ${f.energyIntervalStart ?? "unavailable"}`}
            />
          </dl>
        </div>

        {report.mode === "intel" && report.breakEven && (
          <div className="rounded-lg border border-edge bg-panel-2 px-3.5 py-3">
            <p className="x-label !mt-0">Break-even, not a fleet measurement</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{report.breakEven.note}</p>
            <p className="mt-1.5 text-[11px] tabular text-ink-faint">{report.breakEven.formula}</p>
          </div>
        )}

        <div>
          <p className="x-label">Evidence ledger</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[11.5px]">
              <thead className="text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                <tr className="border-b border-edge">
                  <th className="py-2 pr-3 font-medium">Dimension</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Signal</th>
                  <th className="py-2 font-medium">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {(capability?.dimensions ?? []).map((d) => (
                  <tr key={d.dimension}>
                    <td className="py-2.5 pr-3 text-ink">
                      {d.label}
                      {d.provider ? <span className="block text-[10.5px] text-ink-faint">{d.provider}</span> : null}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${REPORT_STATUS_TONE[d.status] ?? REPORT_STATUS_TONE.gap}`}>
                        {REPORT_STATUS_LABEL[d.status] ?? d.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[10.5px] text-ink-faint" title={d.signalHash}>
                      {shortHash(d.signalHash)}
                    </td>
                    <td className="py-2.5 font-mono text-[10.5px] text-ink-faint" title={d.receiptHash}>
                      {shortHash(d.receiptHash)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
            Verified means the committed response re-derived to the node signal hash. The full hashes are available in the task API and
            the event timeline.
          </p>
        </div>

        <div>
          <p className="x-label">Gap ledger · how to close it</p>
          <ul className="mt-2 space-y-3">
            {report.gaps.map((g) => (
              <li key={g.dimension} className="rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
                <p className="text-[12px] font-medium text-ink">{g.label}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{g.reason}</p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-teal">Route: {g.resolution}</p>
              </li>
            ))}
          </ul>
        </div>

        {report.caveats.length > 0 && (
          <ul className="space-y-1 border-t border-edge pt-3 text-[11px] leading-relaxed text-ink-faint">
            {report.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Kpi({ icon, label, value, unit }: { icon: React.ReactNode; label: string; value: string; unit: string }) {
  return (
    <div className="bg-panel px-4 py-4">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        <span className="text-teal">{icon}</span>
        {label}
      </p>
      <p className="mt-2 text-[24px] font-medium tracking-[-0.02em] tabular text-ink">{value}</p>
      <p className="mt-0.5 text-[10.5px] text-ink-faint">{unit}</p>
    </div>
  );
}

function Finding({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[1fr_1.2fr] sm:gap-4">
      <div>
        <dt className="text-[12px] text-ink">{label}</dt>
        <dd className="text-[10.5px] text-ink-faint">{detail}</dd>
      </div>
      <dd className="tabular text-[12.5px] text-ink-soft sm:text-right">{value}</dd>
    </div>
  );
}
