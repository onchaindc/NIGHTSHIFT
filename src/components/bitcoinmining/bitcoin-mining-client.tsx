"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Cpu,
  Loader2,
  Radio,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";

import type { TaskRecord } from "@/lib/engine/types";
import { useRunWatchdog } from "@/components/minds/run-watchdog";
import RunFlow from "@/components/minds/run-flow";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";
import type { CapabilityReport } from "@/lib/minds/capability-runner";
import type { BitcoinMiningReport } from "@/lib/bitcoinmining/report";
import { openTaskStream } from "@/components/minds/task-stream";

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
  probedAt?: string;
}

type Session = "loading" | "anonymous" | "user" | "operator" | "unavailable";

const ZONES = ["HB_WEST", "HB_NORTH", "HB_SOUTH", "HB_HOUSTON", "LZ_WEST", "LZ_NORTH", "LZ_SOUTH", "LZ_HOUSTON"];

const TERMINAL = new Set(["completed", "failed", "rejected", "blocked"]);

// Operator handoff: the three investigations whose Mind replies arrived after
// the 20 s window and still need deferred collection, plus the exact objective
// of the completed free baseline (task 6437381a) for the intel comparison arm.
const MIND_HANDOFF_COLLECT_IDS = [
  "6aa47a1a-c8a2-4757-af1e-b5f047d82659",
  "8b61777a-836f-4180-ac43-16ba2d0e7e90",
  "58694c0d-bc18-49f8-a1f5-a0478882d53e",
];
const MIND_HANDOFF_OBJECTIVE =
  'Investigate "MARA Holdings" in United States: Bitcoin mining economics — network hashrate trajectory, miner cost curves, and public miner margin outlook entering 2026';

function sessionMode(body: unknown): Session {
  if (!body || typeof body !== "object") return "unavailable";
  const mode = (body as { mode?: unknown }).mode;
  return mode === "operator" ? "operator" : mode === "user" ? "user" : mode === "anonymous" ? "anonymous" : "unavailable";
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

function friendlyError(status: number, detail?: string): string {
  if (status === 401) return "The session was not accepted. Sign in with your wallet and retry.";
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
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [redacted, setRedacted] = useState(false);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const signedIn = session === "operator" || session === "user";
  // Approval authority: the operator, or the wallet that owns THIS run. The
  // server enforces the same rule; this keeps the UI honest up front instead
  // of letting a wallet session click a button the run will refuse.
  const canAct =
    session === "operator" ||
    (session === "user" && !!sessionAddress && !!task?.owner && task.owner.toLowerCase() === sessionAddress);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approveGraceUntil = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);
  const opsRef = useRef<HTMLDetailsElement>(null);

  // Opening the paid-run chooser while anonymous surfaces the sign-in box
  // exactly when it becomes relevant, instead of leading the page with it.
  useEffect(() => {
    if (mode === "intel" && session === "anonymous") {
      if (opsRef.current) opsRef.current.open = true;
    }
  }, [mode, session]);

  // WalletSignIn reports the session it loads; both wallet users and the
  // operator unlock the paid path, anonymous keeps the public view.
  const handleSession = useCallback((next: SessionState) => {
    setSession(next.mode === "operator" ? "operator" : next.mode === "user" ? "user" : next.mode === "unavailable" ? "unavailable" : next.mode === "loading" ? "loading" : "anonymous");
    setSessionAddress(next.address ?? null);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const apply = useCallback(
    (body: { task?: TaskRecord; redacted?: boolean }) => {
      if (!body.task) return;
        if (body.task.state === "awaiting_approval" && Date.now() < approveGraceUntil.current) {
          setTask({ ...body.task, state: "executing" });
          setRedacted(!!body.redacted);
          return;
        }
        setTask(body.task);
        setRedacted(!!body.redacted);
      if (TERMINAL.has(body.task.state)) stopPolling();
    },
    [stopPolling],
  );

  const load = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(65_000) });
        if (!res.ok) return;
        apply((await res.json()) as { task?: TaskRecord; redacted?: boolean });
      } catch {
        /* transient; next poll retries */
      }
    },
    [apply],
  );

  // SSE live stream with the 3s poll as fallback; both funnel through apply().
  useEffect(() => {
    if (!taskId) return;
    return openTaskStream(taskId, (body) => apply(body as { task?: TaskRecord; redacted?: boolean }));
  }, [taskId, apply]);

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

  const [resuming, setResuming] = useState(false);
  const resumeRun = useCallback(async () => {
    if (!taskId || resuming) return;
    setResuming(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(70_000),
      });
      const body = (await res.json()) as { task?: TaskRecord; error?: string };
      if (!res.ok || !body.task) {
        setActionError(body.error ?? "resume failed; re-run the mining investigation instead");
        return;
      }
      setTask(body.task);
      setTaskId(body.task.id);
      writeUrl(body.task.id);
      poll(body.task.id);
    } catch {
      setActionError("resume failed; re-run the mining investigation instead");
    } finally {
      setResuming(false);
    }
  }, [taskId, resuming, poll, writeUrl]);


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
        signal: AbortSignal.timeout(70_000),
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

  const [handoffBusy, setHandoffBusy] = useState<"collect" | "create" | null>(null);
  const [handoffLog, setHandoffLog] = useState<string[]>([]);

  // Attach the Mind replies that arrived after the original capture window
  // closed. No task changes state; only the result record gains the reply.
  const collectMindReplies = useCallback(async () => {
    setHandoffBusy("collect");
    setHandoffLog([]);
    try {
      for (const id of MIND_HANDOFF_COLLECT_IDS) {
        try {
          const res = await fetch("/api/mind/minds-delivery", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: id }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
          setHandoffLog((l) => [
            ...l,
            `${id.slice(0, 8)}… — ${res.ok ? body.detail ?? "Mind reply attached" : body.error ?? `HTTP ${res.status}`}`,
          ]);
        } catch {
          setHandoffLog((l) => [...l, `${id.slice(0, 8)}… — network error, retry`]);
        }
      }
    } finally {
      setHandoffBusy(null);
    }
  }, []);

  // Create the intel arm of the founder comparison with the identical free
  // baseline objective and the same $0.03 hard ceiling. The task parks at the
  // approval gate; the existing progress panel below takes over from there.
  const createMaraIntel = useCallback(async () => {
    setHandoffBusy("create");
    setError(null);
    setActionError(null);
    try {
      const res = await fetch("/api/mind/investigations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(70_000),
        body: JSON.stringify({
          objective: MIND_HANDOFF_OBJECTIVE,
          mode: "intel",
          spendLimitUsdCents: 3,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { task?: TaskRecord; error?: string };
      if (!res.ok || !body.task) {
        setHandoffLog((l) => [...l, `create failed — ${body.error ?? `HTTP ${res.status}`}`]);
        return;
      }
      setHandoffLog((l) => [...l, `${body.task!.id.slice(0, 8)}… created — parked at the approval gate below; nothing paid yet`]);
      setTask(body.task);
      setTaskId(body.task.id);
      writeUrl(body.task.id);
      poll(body.task.id);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch {
      setHandoffLog((l) => [...l, "create failed — network error, retry"]);
    } finally {
      setHandoffBusy(null);
    }
  }, [poll]);

  const state = task?.state ?? null;
  const watchdog = useRunWatchdog(task);
  const report = task?.result?.bitcoinMiningReport;
  const capabilityReport = task?.result?.capabilityReport;

  return (
    <div className="mt-8 space-y-6">
      <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-labelledby="objective">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label" id="objective">The investigation</p>
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
            <p className="x-label">Run mode</p>
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
              // No confirmation gate: paid runs stop at the approval gate
              // anyway, where the exact priced plan is shown before anything
              // is signed.
              onClick={() => void start()}
              disabled={starting || (mode === "intel" && !signedIn)}
              className="btn-primary !min-h-10"
            >
              {starting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ArrowRight size={14} aria-hidden />}
              {mode === "free" ? "Run free preflight" : "Build plan & request approval"}
            </button>
            <p className="text-[11.5px] text-ink-faint">
              {mode === "intel" && !signedIn ? (
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
                  Sign in with your wallet — paid runs need a session
                </button>
              ) : (
                `Hard ceiling ${fmtUsd(guarantees.ceilingUsdCents / 100)} · one attempt per dimension.`
              )}
            </p>
          </div>
          {error && (
            <p className="flex items-start gap-2 text-[12px] leading-relaxed break-words [overflow-wrap:anywhere] text-risk">
              <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden /> {error}
            </p>
          )}
        </div>
      </section>

      <div ref={resultRef}>
        {task && (
          <RunFlow
            task={task}
            mode={mode}
            routableCount={guarantees.dimensions.filter((d) => d.status !== "gap").length}
            ceilingUsdCents={task.spend.limitUsdCents || guarantees.ceilingUsdCents}
            canAct={canAct}
            signedIn={signedIn}
            acting={acting}
            actionError={actionError}
            onApprove={() => void act("approve")}
            onReject={() => void act("reject")}
            onResume={() => void resumeRun()}
            resuming={resuming}
            onRunAgain={() => void start()}
            onSignIn={() => {
              if (opsRef.current) {
                opsRef.current.open = true;
                opsRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }}
            onReadReport={() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            redacted={redacted}
            watchdog={watchdog}
          />
        )}

        {!task && (
          <p className="rounded-xl border border-dashed border-edge bg-panel-2 px-4 py-8 text-center text-[12.5px] leading-relaxed text-ink-faint">
            The report lands here — set the investigation above and run it.
          </p>
        )}

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

        {!redacted && state === "completed" && !report && !capabilityReport && task?.result?.mindsDelivery && (
          <section className="rounded-xl border border-edge bg-panel p-5">
            <p className="x-label !mt-0">Mind roundtrip complete</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
              The investigation report was delivered to the connected Mind. Delivery status{" "}
              <span className="text-ink">{task.result.mindsDelivery.status}</span>
              {task.result.mindsDelivery.reply
                ? " — the Mind reply was captured inline and is attached to this task."
                : " — no reply arrived inside the capture window; attach it via the collect control in Operator access."}{" "}
              Spent {fmtUsd((task.spend?.spentUsdCents ?? 0) / 100)}.
            </p>
          </section>
        )}
      </div>

      <details ref={opsRef} className="overflow-hidden rounded-xl border border-edge bg-panel">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <span className="x-label !mt-0">Operator access</span>
          {signedIn ? (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-teal">
              <span aria-hidden className="size-1.5 rounded-full bg-teal" /> {session === "operator" ? "Signed in" : "Wallet linked"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint">
              <span aria-hidden className="size-1.5 rounded-full bg-ink-faint/60" /> Browsing anonymously
            </span>
          )}
        </summary>
        <div className="border-t border-edge px-4 py-3 sm:px-5">
          {session === "operator" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] leading-relaxed text-ink-soft">
                  Operator session — this browser can approve paid runs and read the full evidence trail.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
                    setSession("anonymous");
                    setSessionAddress(null);
                    if (taskId) void load(taskId);
                  }}
                  className="text-[11.5px] font-medium text-ink-faint transition-colors hover:text-ink"
                >
                  Sign out
                </button>
              </div>

              <div className="mt-3 border-t border-edge pt-3">
                <p className="x-label">Mind handoff</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                  Collect the three outstanding Animoca Mind replies (attaches each to its originating task), and create the
                  intel arm of the founder comparison — identical objective to the completed free baseline, $0.03 hard ceiling,
                  parked at the approval gate until you approve it below.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void collectMindReplies()} disabled={!!handoffBusy} className="btn-secondary !min-h-9">
                    {handoffBusy === "collect" ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
                    Collect 3 deferred Mind replies
                  </button>
                  <button type="button" onClick={() => void createMaraIntel()} disabled={!!handoffBusy} className="btn-secondary !min-h-9">
                    {handoffBusy === "create" ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <ArrowRight size={12} aria-hidden />}
                    Create MARA intel investigation
                  </button>
                </div>
                {handoffLog.length > 0 && (
                  <ul className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-ink-soft">
                    {handoffLog.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : session === "user" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] leading-relaxed text-ink-soft">
                  Wallet session — signed in as{" "}
                  <span className="tabular">{sessionAddress ? `${sessionAddress.slice(0, 6)}…${sessionAddress.slice(-4)}` : "wallet"}</span>. You
                  can approve runs this wallet owns; runs created by the operator or another wallet answer to the operator only.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
                    setSession("anonymous");
                    setSessionAddress(null);
                    if (taskId) void load(taskId);
                  }}
                  className="text-[11.5px] font-medium text-ink-faint transition-colors hover:text-ink"
                >
                  Sign out
                </button>
              </div>
              <p className="mt-3 border-t border-edge pt-3 text-[11px] leading-relaxed text-ink-faint">
                The Mind handoff controls are operator-only — sign in with the operator token to use them.
              </p>
            </>
          ) : (
            <>
              <p className="text-[12px] leading-relaxed text-ink-soft">
                Free preflights are open. Sign in with your wallet to approve a paid run and read its full report.
              </p>
              <div className="mt-2.5">
                <WalletSignIn onSession={handleSession} />
              </div>
            </>
          )}
        </div>
      </details>

      <details className="overflow-hidden rounded-xl border border-edge bg-panel">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <span className="x-label !mt-0">Coverage &amp; method</span>
          <span className="text-[11px] text-ink-faint">What runs, what stays unsupported, how answers are verified</span>
        </summary>
        <div className="space-y-5 border-t border-edge px-4 py-4 sm:px-5">
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-edge bg-panel-2 p-5">
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
            <div className="rounded-xl border border-edge bg-panel-2 p-5">
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
          <p className="max-w-[78ch] text-[12.5px] leading-relaxed text-ink-soft">
            Each ask settles through Telegraph x402 only after the engine approval gate. The committed payload is re-derived
            against its node signal; a mismatch is recorded, never smoothed over. The provider&apos;s hashprice answer carries sats
            and hashrate but explicitly leaves USD unavailable, so the report multiplies that committed sats value by the separately
            committed BTC spot price and labels the result as a derivation.
          </p>
          <p className="flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-ink-faint">
            <span>Three routes probed unpaid {guarantees.probedAt?.slice(0, 10) ?? "—"}</span>
            <span>Paid path exercised 2026-11-24</span>
            <Link href="/minds/bitcoin-mining-intelligence" className="inline-flex items-center gap-1 text-ink-soft transition-colors hover:text-teal">
              Full coverage profile <ArrowRight size={11} aria-hidden />
            </Link>
          </p>
        </div>
      </details>
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
          <p className="x-label !mt-0">{report.mode === "free" ? "Preflight evidence" : "Intelligence report"}</p>
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
                      {d.viaRouterFallback && (
                        <span className="mt-0.5 inline-flex items-center rounded border border-amber/40 bg-amber-soft/50 px-1 py-px text-[9.5px] font-medium text-amber-deep">router fallback</span>
                      )}
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
