"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle } from "lucide-react";

import type { TaskRecord } from "@/lib/engine/types";
import type { DeskEvidence, DeskInvestigation } from "@/lib/desk/types";
import { DESK_TYPE_LABEL, DESK_VERDICT_LABEL } from "@/lib/desk/types";
import { friendlyNetworkError } from "@/lib/api/client-errors";
import { vibrate } from "@/lib/haptics";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";
import { ConfirmPaidRun } from "@/components/confirm-paid-run";
import { ReportDisclosure } from "@/components/report/collapsible";
import { useRunWatchdog } from "@/components/minds/run-watchdog";
import { openTaskStream } from "@/components/minds/task-stream";
import RunFlow from "@/components/minds/run-flow";

const TERMINAL = new Set(["completed", "failed", "rejected", "blocked"]);

const PROVENANCE_CHIP: Record<string, { chip: string; word: string }> = {
  verified: { chip: "border-teal/30 bg-teal/5 text-teal", word: "Verified fact" },
  unverified: { chip: "border-amber/40 bg-amber-soft/40 text-amber-deep", word: "Unverified" },
  missing: { chip: "border-edge bg-panel-2 text-ink-faint", word: "Missing evidence" },
  analysis: { chip: "border-[--accent]/30 bg-[--accent]/5 text-[--accent]", word: "Desk analysis" },
};

const SEVERITY_CHIP: Record<string, string> = {
  critical: "border-risk/40 bg-risk/5 text-risk",
  material: "border-amber/40 bg-amber/10 text-amber",
  minor: "border-edge bg-panel-2 text-ink-soft",
  info: "border-edge bg-panel-2 text-ink-faint",
};

const VERDICT_CHIP: Record<string, string> = {
  hold_pending_review: "border-risk/40 bg-risk/10 text-risk",
  proceed_with_conditions: "border-amber/40 bg-amber/10 text-amber",
  proceed_on_record: "border-teal/40 bg-teal/10 text-teal",
  insufficient_verified_evidence: "border-edge bg-panel-3 text-ink-faint",
};

const CONFIDENCE_WORD: Record<string, string> = {
  signal_verified: "Signal verified",
  partially_verified: "Partially verified",
  route_verified_only: "Route verified only",
  unverified: "Unverified",
};

function money(cents: number | undefined): string {
  return cents === undefined ? "—" : `$${(cents / 100).toFixed(2)}`;
}

function shortHash(hash: string | undefined): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "—";
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function humanizeValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : String(Math.round(v * 1000) / 1000);
  if (typeof v === "object") return null;
  const s = String(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

function EvidenceCard({ e }: { e: DeskEvidence }) {
  const tone = PROVENANCE_CHIP[e.provenance] ?? PROVENANCE_CHIP.missing;
  const facts = Object.entries(e.facts).filter(([, v]) => humanizeValue(v) !== null);
  return (
    <li className="rounded-2xl border border-edge bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink">{e.title}</p>
        <span className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold tracking-wide ${tone.chip}`}>{tone.word}</span>
      </div>
      <p className="mt-1.5 break-words text-[12px] leading-relaxed text-ink-soft">{e.detail}</p>
      {facts.length > 0 && (
        <dl className="mt-2.5 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="flex min-w-0 gap-1.5 text-[11.5px]">
              <dt className="shrink-0 text-ink-faint">{humanizeKey(k)}:</dt>
              <dd className="min-w-0 break-words text-ink">{humanizeValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-faint">
        <span className="rounded border border-edge bg-panel-2 px-1.5 py-0.5 font-mono">{e.capability}</span>
        {e.source.kind === "telegraph" && <span>{e.source.label}</span>}
        {e.signalHash && <span className="font-mono">signal {shortHash(e.signalHash)}</span>}
        {e.receiptHash && <span className="font-mono">receipt {shortHash(e.receiptHash)}</span>}
        {e.costUsdCents !== undefined && <span className="tabular">{money(e.costUsdCents)}</span>}
        {e.viaRouterFallback && <span className="text-amber">router fallback</span>}
        <span>{new Date(e.source.observedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
      </p>
    </li>
  );
}

export function DeskWorkspace({ investigationId }: { investigationId: string }) {
  const [inv, setInv] = useState<DeskInvestigation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [task, setTask] = useState<TaskRecord | null>(null);
  const [redacted, setRedacted] = useState(false);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);
  const [paidConfirmOpen, setPaidConfirmOpen] = useState(false);
  const prevTaskState = useRef<TaskRecord["state"] | null>(null);
  const syncedForRef = useRef<string | null>(null);
  const justFinishedRef = useRef(false);
  const reportRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);

  const signedIn = session.mode === "user" || session.mode === "operator";
  const isOwner =
    session.mode === "operator" ||
    (session.mode === "user" && !!session.address && !!inv?.owner && inv.owner.toLowerCase() === session.address);
  const watchdog = useRunWatchdog(task);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/desk/${investigationId}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { investigation?: DeskInvestigation; error?: string };
      if (!res.ok) {
        setLoadError(body.error ?? `The file could not be read (status ${res.status}).`);
        return;
      }
      setInv(body.investigation ?? null);
      setLoadError(null);
    } catch (err) {
      setLoadError(friendlyNetworkError(err));
    }
  }, [investigationId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (session.mode !== "loading") void refresh();
  }, [session.mode, session.address, refresh]);

  const act = useCallback(
    async (key: string, run: () => Promise<Response>) => {
      setBusy(key);
      setActionError(null);
      setNotice(null);
      try {
        const res = await run();
        const body = (await res.json().catch(() => ({}))) as { error?: string; note?: string; notes?: string[] };
        if (!res.ok) {
          setActionError(body.error ?? `The action failed with status ${res.status}.`);
          return;
        }
        setNotice(body.note ?? (body.notes?.length ? body.notes.join(" ") : null));
        await refresh();
      } catch (err) {
        setActionError(friendlyNetworkError(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const loadTask = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(65_000) });
      if (!res.ok) return;
      const body = (await res.json()) as { task?: TaskRecord; redacted?: boolean };
      if (!body.task) return;
      setTask(body.task);
      setRedacted(!!body.redacted);
      const prev = prevTaskState.current;
      if (prev && prev !== body.task.state) {
        if (body.task.state === "completed") vibrate("success");
        else if (body.task.state === "failed" || body.task.state === "blocked") vibrate("error");
        else if (body.task.state === "awaiting_approval") vibrate("notify");
        const to = body.task.state;
        if (to === "completed") justFinishedRef.current = true;
        setTimeout(() => {
          if (to === "awaiting_approval") flowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
          else if (to === "completed") reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 120);
      }
      prevTaskState.current = body.task.state;
      // A completed run is absorbed into the ledger exactly once — whether the
      // finish was watched live or the file was opened with the run already
      // done. The report builds in the background; the manual step is gone.
      if (body.task.state === "completed" && syncedForRef.current !== body.task.id) {
        syncedForRef.current = body.task.id;
        void act("sync-report", () =>
          fetch(`/api/desk/${investigationId}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "report", mode: body.task?.labels?.some((l) => l === "desk-mode:intel") ? "intel" : "free" }),
          }),
        );
      }
      // A terminal run needs no further polling.
      if (TERMINAL.has(body.task.state) && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      /* transient; next poll retries */
    }
  }, [investigationId, act]);

  // Live stream + 3s poll fallback for the latest run. The effect keys on the
  // task id (not the runs array identity, which every refresh recreates), and
  // the poll stops itself once the run reaches a terminal state.
  const latestRun = inv?.runs.length ? inv.runs[inv.runs.length - 1] : null;
  const latestTaskId = latestRun?.taskId ?? null;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!latestTaskId) return;
    const stop = openTaskStream(latestTaskId, (body) => {
      const t = (body as { task?: TaskRecord }).task;
      if (t) {
        setTask(t);
        prevTaskState.current = t.state;
      }
    });
    pollRef.current = setInterval(() => void loadTask(latestTaskId), 3000);
    void loadTask(latestTaskId);
    return () => {
      stop();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [latestTaskId, loadTask]);

  // Take the reader straight to the report the moment it lands after a run
  // finishes in this session. A report that was already built before the file
  // was opened never yanks the page down on arrival.
  useEffect(() => {
    if (!justFinishedRef.current) return;
    if (inv?.report) {
      justFinishedRef.current = false;
      reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [inv?.report]);

  if (loadError && !inv) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <p role="alert" className="rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          {loadError}
        </p>
        <Link href="/desk" className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] text-ink-soft">
          <ArrowLeft size={13} aria-hidden /> Back to Deal Desk
        </Link>
      </div>
    );
  }
  if (!inv) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <div className="h-40 rounded-2xl bg-panel-2 motion-safe:animate-pulse" />
      </div>
    );
  }

  const counts = {
    verified: inv.evidence.filter((e) => e.provenance === "verified"),
    unverified: inv.evidence.filter((e) => e.provenance === "unverified"),
    missing: inv.evidence.filter((e) => e.provenance === "missing"),
    analysis: inv.evidence.filter((e) => e.provenance === "analysis"),
  };
  const grouped: Array<[string, DeskEvidence[]]> = [
    ["verified", counts.verified],
    ["unverified", counts.unverified],
    ["missing", counts.missing],
    ["analysis", counts.analysis],
  ];
  const spend = task?.spend?.spentUsdCents ?? 0;
  const building = busy === "sync-report";
  const latestRunCompleted = latestRun?.taskState === "completed";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/desk" className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-soft transition-colors hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Deal Desk
      </Link>

      <header className="mt-5 flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-[56ch]">
          <p className="x-eyebrow">{DESK_TYPE_LABEL[inv.type]}</p>
          <h1 className="x-display-2 mt-3 text-balance text-ink">
            <span className="tabular">{inv.reference}</span>
          </h1>
          <p className="mt-2 text-[14px] font-medium text-ink">
            {Object.entries(inv.subject)
              .filter(([k]) => k !== "spendLimitUsdCents")
              .slice(0, 2)
              .map(([, v]) => v)
              .join(" · ") || "No subject recorded"}
          </p>
          <p className="mt-1 text-[12px] text-ink-soft">
            Status {inv.status} · ceiling {money(inv.spendLimitUsdCents)} · opened{" "}
            {new Date(inv.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
            {inv.report ? ` · ${CONFIDENCE_WORD[inv.report.confidence] ?? inv.report.confidence}` : ""}
          </p>
        </div>
        <WalletSignIn onSession={setSession} compact />
      </header>

      {notice && (
        <p className="mt-4 rounded-lg border border-teal/40 bg-teal/5 px-3.5 py-2.5 text-[12.5px] text-teal">{notice}</p>
      )}
      {actionError && (
        <p role="alert" className="mt-4 rounded-lg border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk">
          {actionError}
        </p>
      )}
      {!isOwner && (
        <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-amber/40 bg-amber/5 px-3.5 py-2.5 text-[12.5px] text-amber">
          <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
          {session.mode === "anonymous"
            ? "This file belongs to a wallet. Sign in with the wallet that opened it to run or approve anything."
            : "This file belongs to another wallet — read-only for you."}
        </p>
      )}

      {/* Run actions — stacked on a phone, one row on a desk. The paid run
          asks before it starts; the report builds itself when the run ends. */}
      <section aria-label="Runs" className="mt-6" ref={flowRef}>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            className="btn-primary !min-h-10"
            disabled={busy !== null || !isOwner}
            title={isOwner ? undefined : "Only the file's owner or the operator can run it"}
            onClick={() =>
              void act("run-free", () =>
                fetch(`/api/desk/${inv.id}/run`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "run", mode: "free" }),
                }),
              )
            }
          >
            {busy === "run-free" ? <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> : null}
            Run free pre-flight
          </button>
          <button
            type="button"
            className="btn-quiet !min-h-10"
            disabled={busy !== null || !isOwner}
            title={isOwner ? "Asks for confirmation, then stops at the approval gate; nothing is signed until you approve" : "Only the file's owner or the operator can run it"}
            onClick={() => setPaidConfirmOpen(true)}
          >
            {busy === "run-intel" ? <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> : null}
            Run paid investigation
          </button>
          {building && (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-teal/30 bg-teal/5 px-2.5 py-1 text-[11px] font-medium text-teal" role="status">
              <LoaderCircle size={12} aria-hidden className="motion-safe:animate-spin" />
              Building the report…
            </span>
          )}
          {inv.runs.length > 0 && <span className="text-[11px] text-ink-faint">{inv.runs.length} run(s) · latest {latestRun?.taskState}</span>}
        </div>

        {task && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-edge bg-panel">
            <RunFlow
              task={task}
              mode={latestRun?.mode ?? "free"}
              routableCount={task.result?.capabilityReport?.counts.routable_unverified ?? 0}
              ceilingUsdCents={task.spend.limitUsdCents}
              canAct={signedIn && isOwner}
              signedIn={signedIn}
              acting={acting}
              actionError={actionError}
              onApprove={() => {
                setActing("approve");
                void act("approve", () =>
                  fetch(`/api/tasks/${task.id}/action`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "approve" }),
                  }),
                ).finally(() => setActing(null));
              }}
              onReject={() => {
                setActing("reject");
                void act("reject", () =>
                  fetch(`/api/tasks/${task.id}/action`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "reject" }),
                  }),
                ).finally(() => setActing(null));
              }}
              onResume={() =>
                void act("resume", () =>
                  fetch(`/api/tasks/${task.id}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }),
                )
              }
              resuming={busy === "resume"}
              onRunAgain={() =>
                void act("run-again", () =>
                  fetch(`/api/desk/${inv.id}/run`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "run", mode: "free" }),
                  }),
                )
              }
              onSignIn={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              onReadReport={() => reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              redacted={redacted}
              watchdog={watchdog}
            />
          </div>
        )}
      </section>

      {/* The run finished and the report is assembling itself — a loading
          state in place of the old button. When the built report lands, the
          reader is taken straight to it. */}
      {latestRunCompleted && !inv.report && (
        <section aria-label="Report building" className="mt-8 sm:mt-10" ref={reportRef}>
          <h2 className="x-label">Report</h2>
          <div className="mt-3 rounded-2xl border border-edge bg-panel p-4 sm:p-5">
            <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink" role="status">
              <LoaderCircle size={14} aria-hidden className="shrink-0 motion-safe:animate-spin text-teal" />
              {building
                ? "The run finished — assembling the report from the run's evidence…"
                : "The run finished — the report builds from the evidence ledger in the background…"}
            </p>
            <div className="mt-3 space-y-2" aria-hidden>
              <div className="h-4 w-3/4 rounded bg-panel-2 motion-safe:animate-pulse" />
              <div className="h-4 w-1/2 rounded bg-panel-2 motion-safe:animate-pulse" />
              <div className="h-4 w-2/3 rounded bg-panel-2 motion-safe:animate-pulse" />
            </div>
          </div>
        </section>
      )}

      {/* Report — the answer is the spotlight. Headline and findings open the
          card; discrepancies, section summaries, limitations and questions sit
          in closed, counted disclosures; the long orientation copy lives in
          "How to read this report". The activity trail stays its own section
          below, so the process can never be mistaken for the answer. */}
      {inv.report && (
        <section aria-label="Report" className="mt-8 sm:mt-10" ref={reportRef}>
          <h2 className="x-label">Report — what the investigation found</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-edge bg-panel">
            <div className="p-4 sm:p-5">
              <p className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                The answer · the activity trail sits further down
              </p>
              <div className="mt-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                <h3 className="min-w-0 text-[16.5px] font-semibold leading-snug text-ink sm:text-[18px]">{inv.report.headline}</h3>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold tracking-wide ${
                    inv.report.confidence === "signal_verified"
                      ? "border-teal/40 bg-teal/10 text-teal"
                      : inv.report.confidence === "partially_verified"
                        ? "border-amber/40 bg-amber/10 text-amber"
                        : "border-edge bg-panel-3 text-ink-faint"
                  }`}
                >
                  {CONFIDENCE_WORD[inv.report.confidence] ?? inv.report.confidence}
                </span>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">
                {inv.report.mode === "intel" ? "Paid run" : "Free pre-flight"} · prepared{" "}
                {new Date(inv.report.preparedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} ·{" "}
                <span className="tabular">
                  {inv.report.counts.verified} verified · {inv.report.counts.unverified} unverified · {inv.report.counts.missing} missing ·{" "}
                  {inv.report.counts.analysis} analysis
                </span>
              </p>

              {/* Executive assessment — the desk's labelled analysis verdict:
                  what was established, what is adverse, what the file cannot
                  speak to, and the concrete next steps, each traced. */}
              <div className="mt-4 rounded-xl border border-edge bg-panel-2/60 p-3.5 sm:p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${
                      VERDICT_CHIP[inv.report.assessment.verdict] ?? VERDICT_CHIP.insufficient_verified_evidence
                    }`}
                  >
                    {DESK_VERDICT_LABEL[inv.report.assessment.verdict] ?? inv.report.assessment.verdict}
                  </span>
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">Executive assessment · labelled desk analysis</span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-ink">{inv.report.assessment.summary}</p>
                {inv.report.assessment.basis.length > 0 && (
                  <ul className="mt-2.5 space-y-1">
                    {inv.report.assessment.basis.map((b, i) => (
                      <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-ink-soft">
                        <span aria-hidden className="mt-[1px] shrink-0 text-ink-faint">—</span>
                        <span className="min-w-0">{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {inv.report.assessment.nextActions.length > 0 && (
                  <div className="mt-3 border-t border-edge pt-3">
                    <p className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-faint">Recommended next steps</p>
                    <ol className="mt-2 space-y-2">
                      {inv.report.assessment.nextActions.map((a, i) => (
                        <li key={i} className="flex gap-2">
                          <span aria-hidden className="mt-[1px] shrink-0 font-semibold text-ink-faint tabular">{i + 1}.</span>
                          <div className="min-w-0">
                            <p className="text-[12.5px] font-medium leading-snug text-ink">{a.title}</p>
                            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-soft">{a.detail}</p>
                            {a.basis.length > 0 && <p className="mt-0.5 text-[10.5px] text-ink-faint">Basis: {a.basis.join(", ")}</p>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>

              {inv.report.findings.length === 0 ? (
                <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
                  No findings — verified evidence produces findings; unverified routes never do. What this run did
                  establish sits one tap away in the activity trail below.
                </p>
              ) : (
                <>
                  <ul className="mt-3 space-y-2">
                    {inv.report.findings.slice(0, 3).map((f) => (
                      <li key={f.id} className="rounded-xl border border-edge bg-panel-2 px-3.5 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="min-w-0 text-[13px] font-semibold text-ink">{f.title}</p>
                          <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${SEVERITY_CHIP[f.severity]}`}>{f.severity}</span>
                        </div>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{f.detail}</p>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{f.significance}</p>
                        <p className="mt-1.5 text-[10.5px] text-ink-faint">Evidence: {f.evidenceIds.join(", ")} · {f.provenance}</p>
                      </li>
                    ))}
                  </ul>
                  {inv.report.findings.length > 3 && (
                    <div className="mt-2">
                      <ReportDisclosure title="More findings" count={inv.report.findings.length - 3}>
                        <ul className="space-y-2">
                          {inv.report.findings.slice(3).map((f) => (
                            <li key={f.id} className="rounded-xl border border-edge bg-panel-2 px-3.5 py-2.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="min-w-0 text-[13px] font-semibold text-ink">{f.title}</p>
                                <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${SEVERITY_CHIP[f.severity]}`}>{f.severity}</span>
                              </div>
                              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{f.detail}</p>
                              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{f.significance}</p>
                              <p className="mt-1.5 text-[10.5px] text-ink-faint">Evidence: {f.evidenceIds.join(", ")} · {f.provenance}</p>
                            </li>
                          ))}
                        </ul>
                      </ReportDisclosure>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Secondary sections — present, counted, closed by default. */}
            <div className="space-y-2 border-t border-edge bg-panel-2/40 p-3 sm:p-4">
              {(() => {
                const paidRan = inv.runs.some((r) => r.mode === "intel");
                const banner =
                  inv.report && inv.report.findings.length > 0
                    ? "This is the report — the answer to what you asked. Findings cite their evidence; the activity trail below shows how each answer was priced, bought and checked."
                    : paidRan
                      ? "This is the report after a paid run — but nothing verified, so there are no findings. The answers returned sit in the activity trail, labelled unverified and never presented as data."
                      : "This is the free pre-flight — no answer has been purchased yet, so there are no findings to read. What you have: every route checked and priced, what the network cannot answer, and the questions a paid run would settle. The activity trail below is the process, not the answer.";
                return (
                  <ReportDisclosure title="How to read this report" tone="teal">
                    <p className="text-[12px] leading-relaxed text-ink-soft">{banner}</p>
                  </ReportDisclosure>
                );
              })()}
              <ReportDisclosure
                title="Discrepancies"
                count={inv.report.discrepancies.length}
                tone={inv.report.discrepancies.length > 0 ? "amber" : "neutral"}
              >
                {inv.report.discrepancies.length === 0 ? (
                  <p className="text-[12px] text-ink-faint">No conflicts recorded between the requested inputs and the answers.</p>
                ) : (
                  <ul className="space-y-2">
                    {inv.report.discrepancies.map((d) => (
                      <li key={d.id} className="rounded-xl border border-amber/40 bg-amber/5 px-3.5 py-3">
                        <p className="text-[12.5px] font-semibold text-ink">{d.title}</p>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{d.detail}</p>
                        <p className="mt-1.5 text-[10.5px] text-ink-faint">Evidence: {d.evidenceIds.join(", ")}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </ReportDisclosure>
              <ReportDisclosure title="What the report covers, section by section" count={inv.report.sections.length}>
                <ul className="space-y-2">
                  {inv.report.sections.map((s) => (
                    <li key={s.id} className="rounded-xl border border-edge bg-panel-2 px-3.5 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 text-[12.5px] font-semibold text-ink">{s.title}</p>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${PROVENANCE_CHIP[s.provenance]?.chip ?? PROVENANCE_CHIP.missing.chip}`}>
                          {PROVENANCE_CHIP[s.provenance]?.word ?? s.provenance}
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{s.summary}</p>
                    </li>
                  ))}
                </ul>
              </ReportDisclosure>
              <ReportDisclosure title="Confidence limitations" count={inv.report.limitations.length}>
                <ul className="space-y-1.5">
                  {inv.report.limitations.map((l, i) => (
                    <li key={i} className="text-[12px] leading-relaxed text-ink-soft">— {l}</li>
                  ))}
                </ul>
              </ReportDisclosure>
              <ReportDisclosure title="Outstanding questions" count={inv.report.outstandingQuestions.length}>
                <ul className="space-y-1.5">
                  {inv.report.outstandingQuestions.map((q, i) => (
                    <li key={i} className="text-[12px] leading-relaxed text-ink-soft">? {q}</li>
                  ))}
                </ul>
              </ReportDisclosure>
            </div>
          </div>
        </section>
      )}

      {/* Activity trail — how the investigation ran: probes, purchases,
          declared inputs and named gaps, grouped by provenance, each group a
          closed, counted disclosure. Kept verbally separate from the report
          above so the process can never be mistaken for the answer. */}
      <section aria-label="Activity trail" className="mt-8 sm:mt-10">
        <h2 className="x-label">How this was investigated — the activity trail</h2>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-faint">
          <span className="tabular">{counts.verified.length} verified</span>
          <span className="tabular">{counts.unverified.length} unverified</span>
          <span className="tabular">{counts.missing.length} missing</span>
          <span className="tabular">{counts.analysis.length} analysis</span>
          <span className="tabular">{money(spend)} spent</span>
        </p>
        {inv.evidence.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-ink-faint">Empty. Run the free pre-flight to populate routes and named gaps.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {grouped
              .filter(([, list]) => list.length > 0)
              .map(([key, list]) => (
                <ReportDisclosure
                  key={key}
                  title={`${PROVENANCE_CHIP[key]?.word ?? key} records`}
                  count={list.length}
                  tone={key === "verified" ? "teal" : key === "unverified" ? "amber" : "neutral"}
                >
                  <ul className="space-y-2">
                    {list.map((e) => (
                      <EvidenceCard key={e.id} e={e} />
                    ))}
                  </ul>
                </ReportDisclosure>
              ))}
          </div>
        )}
      </section>

      {/* Unsupported requirements + audit — one counted disclosure */}
      <div className="mt-6 sm:mt-8">
        <ReportDisclosure title="Named unsupported requirements and file audit" count={inv.unsupported.length}>
          <ul className="space-y-2">
            {inv.unsupported.map((g) => (
              <li key={g.capabilityKey} className="rounded-xl border border-edge bg-panel-2 px-3.5 py-3">
                <p className="text-[12.5px] font-medium text-ink">{g.label}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{g.reason}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">Resolution: {g.resolution}</p>
              </li>
            ))}
          </ul>
          <h3 className="x-label mt-4">Audit trail</h3>
          <ul className="mt-2 space-y-1">
            {inv.audit.slice(-12).map((a, i) => (
              <li key={i} className="text-[11px] text-ink-faint">
                {new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {a.actor} · {a.action} — {a.detail}
              </li>
            ))}
          </ul>
        </ReportDisclosure>
      </div>

      <p className="mt-10 text-[11px] leading-relaxed text-ink-faint">
        Every verified fact re-derived against its node signal; every route priced by an unpaid probe is labelled
        unverified; every unsupported requirement is named. The desk never signs or broadcasts a payment.
      </p>

      {/* The paid run asks before it starts — a stray tap while scrolling must
          never launch one. Confirm carries the ceiling; Cancel does nothing. */}
      <ConfirmPaidRun
        open={paidConfirmOpen}
        title="Start a paid investigation?"
        body="The desk plans every capability against the live network, then stops at the approval gate — you see the exact priced plan before anything is signed."
        cost={`This run is paid from the deployment's payer wallet, hard-capped at the file's ceiling of ${money(inv.spendLimitUsdCents)}.`}
        confirmLabel="Start the paid run"
        busy={busy === "run-intel"}
        onConfirm={() => {
          setPaidConfirmOpen(false);
          void act("run-intel", () =>
            fetch(`/api/desk/${inv.id}/run`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "run", mode: "intel" }),
            }),
          );
        }}
        onCancel={() => setPaidConfirmOpen(false)}
      />
    </div>
  );
}
