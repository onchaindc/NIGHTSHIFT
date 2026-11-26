"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleDashed, LoaderCircle, ShieldAlert } from "lucide-react";

import { ASSURANCE_CAPABILITIES } from "@/lib/assurance/capabilities";
import type {
  AssuranceEvidence,
  DecisionOutcome,
  Finding,
  IntelligenceRun,
  Investigation,
} from "@/lib/assurance/types";
import { SEVERITY_ORDER } from "@/lib/assurance/types";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";

interface RunView extends IntelligenceRun {
  taskState: string;
  taskError: string | null;
  canApprove: boolean;
  spendUsdCents: number;
}

interface Payload {
  readOnly: boolean;
  investigation: Investigation;
  runs: RunView[];
  spend: { spentUsdCents: number; ceilingUsdCents: number };
  orchestration: { planner: string; mindConnected: boolean; note: string };
  error?: string;
}

const DECISION_STYLE: Record<DecisionOutcome, { chip: string; panel: string; label: string }> = {
  CLEARED: { chip: "border-teal/40 bg-teal/10 text-teal", panel: "border-teal/40 bg-teal/[0.04]", label: "Cleared for settlement" },
  HOLD: { chip: "border-amber/40 bg-amber/10 text-amber", panel: "border-amber/45 bg-amber/[0.05]", label: "Held: conditions open" },
  ESCALATE: { chip: "border-risk/40 bg-risk/10 text-risk", panel: "border-risk/40 bg-risk/[0.04]", label: "Escalated: critical finding" },
};

const SEVERITY_STYLE: Record<Finding["severity"], string> = {
  critical: "border-risk/40 bg-risk/10 text-risk",
  material: "border-amber/45 bg-amber/10 text-amber",
  minor: "border-edge-strong bg-panel-3 text-ink-soft",
  info: "border-edge bg-panel-3 text-ink-faint",
};

const EVIDENCE_LABEL: Record<AssuranceEvidence["class"], string> = {
  source_verified: "SOURCE-VERIFIED",
  node_verified: "NODE-VERIFIED",
  probe_verified: "PROBE-ONLY",
  demonstration: "DEMONSTRATION",
};

const EVIDENCE_STYLE: Record<AssuranceEvidence["class"], string> = {
  source_verified: "border-teal/40 bg-teal/10 text-teal",
  node_verified: "border-blue/40 bg-blue/10 text-blue",
  probe_verified: "border-edge-strong bg-panel-3 text-ink-soft",
  demonstration: "border-amber/40 bg-amber/10 text-amber",
};

function money(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}

function usdc(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Section({
  n,
  title,
  meta,
  children,
}: {
  n: string;
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-edge py-7 first:border-t-0 first:pt-0">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-3">
          <span className="tabular text-[11px] text-ink-faint" aria-hidden>
            {n}
          </span>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        </div>
        {meta}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="x-label">{label}</dt>
      <dd className={`mt-1 break-words text-[12.5px] leading-relaxed text-ink ${mono ? "tabular" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

function StatusDot({ done, active }: { done: boolean; active?: boolean }) {
  if (done) return <Check size={12} aria-hidden className="text-teal" />;
  if (active) return <LoaderCircle size={12} aria-hidden className="motion-safe:animate-spin text-amber" />;
  return <CircleDashed size={12} aria-hidden className="text-ink-faint" />;
}

export function AssuranceWorkspace({ investigationId }: { investigationId: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signature, setSignature] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/assurance/${investigationId}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as Payload;
      if (!res.ok) {
        setLoadError(body.error ?? `The file could not be read (status ${res.status}).`);
        return;
      }
      setPayload(body);
      setLoadError(null);
    } catch (err) {
      setLoadError(`Could not reach the server. ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [investigationId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, [refresh]);

  // A fresh identity changes what the server will let this browser do.
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
        const body = (await res.json().catch(() => ({}))) as { error?: string; note?: string; delivery?: { detail?: string }; notes?: string[] };
        if (!res.ok) {
          setActionError(body.error ?? `The action failed with status ${res.status}.`);
          return;
        }
        setNotice(body.note ?? (body.delivery?.detail ? `Report delivery: ${body.delivery.detail}` : null));
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  if (loadError && !payload) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <p role="alert" className="rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          {loadError}
        </p>
        <Link href="/assurance" className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] text-ink-soft">
          <ArrowLeft size={13} aria-hidden /> Back to files
        </Link>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="h-6 w-48 rounded bg-panel-2 motion-safe:animate-pulse" />
        <div className="mt-4 h-40 rounded-md bg-panel-2 motion-safe:animate-pulse" />
      </div>
    );
  }

  const inv = payload.investigation;
  const decision = inv.decision;
  const findings = [...inv.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const sourceVerified = inv.evidence.filter((e) => e.class === "source_verified").length;
  const nodeVerified = inv.evidence.filter((e) => e.class === "node_verified").length;
  const demo = inv.evidence.filter((e) => e.class === "demonstration").length;
  const probeOnly = inv.evidence.filter((e) => e.class === "probe_verified").length;
  const hasRuns = payload.runs.length > 0;
  const hasEvidence = sourceVerified + nodeVerified > 0;
  const paidRuns = payload.runs.filter((r) => r.mode === "intel");
  const running = payload.runs.find((r) => ["planning", "executing", "verifying"].includes(r.taskState));
  const awaiting = payload.runs.find((r) => r.canApprove);

  const workflow = [
    { label: "Transaction entered", done: true },
    { label: "Investigation launched", done: hasRuns, active: Boolean(running) },
    { label: "Evidence gathered", done: hasEvidence },
    { label: "Assessment recorded", done: Boolean(decision) },
    { label: "Authorization decision", done: Boolean(decision) },
    { label: "Settlement assurance", done: Boolean(inv.settlement) },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <Link href="/assurance" className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
            <ArrowLeft size={12} aria-hidden /> Settlement assurance
          </Link>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <h1 className="tabular text-[17px] font-semibold tracking-tight text-ink">{inv.reference}</h1>
            {inv.dataMode === "demonstration" && (
              <span className="rounded-sm border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber">
                DEMONSTRATION
              </span>
            )}
            {decision && (
              <span className={`rounded-sm border px-2 py-0.5 text-[10.5px] font-semibold tracking-wide ${DECISION_STYLE[decision.outcome].chip}`}>
                {decision.outcome}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            {inv.counterparty.legalName} · <span className="tabular">{usdc(inv.transaction.amountUsdc)} USDC</span> on Solana
          </p>
        </div>
        <div className="text-right">
          <p className="x-label">Spend on intelligence</p>
          <p className="tabular mt-1 text-[14px] text-ink">
            {money(payload.spend.spentUsdCents)} <span className="text-ink-faint">/ {money(payload.spend.ceilingUsdCents)}</span>
          </p>
          <p className="mt-0.5 text-[10.5px] text-ink-faint">Ledger from linked engine tasks</p>
        </div>
      </div>

      {(actionError || loadError) && (
        <p role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk">
          {actionError ?? loadError}
        </p>
      )}
      {notice && (
        <p className="mt-5 rounded-md border border-edge bg-panel-3 px-3.5 py-2.5 text-[12px] text-ink-soft">{notice}</p>
      )}

      {/* Decision banner: the one thing a reviewer needs first, up top. */}
      {decision && (
        <div className={`mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 ${DECISION_STYLE[decision.outcome].panel}`}>
          <div className="flex min-w-0 items-center gap-3">
            {decision.outcome === "ESCALATE" ? (
              <ShieldAlert size={18} aria-hidden className="shrink-0 text-risk" />
            ) : decision.outcome === "HOLD" ? (
              <CircleAlert size={18} aria-hidden className="shrink-0 text-amber" />
            ) : (
              <Check size={18} aria-hidden className="shrink-0 text-teal" />
            )}
            <div className="min-w-0">
              <p className="text-[14px] font-semibold tracking-tight text-ink">{DECISION_STYLE[decision.outcome].label}</p>
              <p className="mt-0.5 truncate text-[11.5px] text-ink-soft">{decision.rationale}</p>
            </div>
          </div>
          <a
            href="#decision"
            className="shrink-0 text-[11.5px] font-medium text-ink-soft transition-colors hover:text-ink"
          >
            Criteria & evidence ↓
          </a>
        </div>
      )}

      {payload.readOnly && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-edge bg-panel-3 px-4 py-3.5">
          <p className="text-[12px] leading-relaxed text-ink-soft">
            {inv.dataMode === "demonstration"
              ? "Demonstration file — open to everyone, read-only. Sign in with your wallet to open and run live files."
              : "This file belongs to another wallet, or you are browsing anonymously. Actions are available to its owner."}
          </p>
          <WalletSignIn onSession={setSession} compact />
        </div>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_268px] lg:gap-12">
        <div className="min-w-0">
          {/* 01 — transaction */}
          <Section
            n="01"
            title="Transaction under review"
            meta={<span className="x-tag">PRE-SETTLEMENT</span>}
          >
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Fact label="Payer wallet" value={inv.transaction.payerWallet} />
              <Fact label="Recipient wallet" value={inv.transaction.recipientWallet} />
              <Fact label="Amount" value={`${usdc(inv.transaction.amountUsdc)} USDC`} />
              <Fact label="Token mint" value={inv.transaction.tokenMint} />
              <Fact label="Approved beneficiary" value={inv.transaction.approvedBeneficiary} mono={false} />
              <Fact label="Counterparty record" value={inv.counterparty.legalName} mono={false} />
              <Fact label="Registration (as supplied)" value={inv.counterparty.registrationNumber ?? "not supplied"} />
              <Fact label="Jurisdiction" value={inv.transaction.jurisdiction} />
              <Fact label="Contract reference" value={inv.transaction.contractRef} mono={false} />
              <Fact label="Settlement memo" value={inv.transaction.memo} mono={false} />
            </dl>
            {inv.transaction.documents.length > 0 && (
              <div className="mt-5 border-t border-edge pt-4">
                <p className="x-label">Supporting documents</p>
                <ul className="mt-1.5 space-y-1.5">
                  {inv.transaction.documents.map((d, i) => (
                    <li key={i} className="text-[12.5px] leading-relaxed text-ink-soft">
                      <span className="text-ink">{d.name}</span>
                      {d.sha256 ? <span className="tabular text-ink-faint"> · sha256 {d.sha256}</span> : null}
                      {d.note ? <span className="block text-[11.5px] text-ink-faint">{d.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          {/* 02 — investigation */}
          <Section
            n="02"
            title="Investigation"
            meta={<span className="x-tag">FREE READS · APPROVED INTELLIGENCE</span>}
          >
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void act("inspect", () => fetch(`/api/assurance/${inv.id}/inspect`, { method: "POST" }))}
                disabled={busy !== null || payload.readOnly || inv.dataMode === "demonstration"}
                className="btn-signal !min-h-9 !text-[12px]"
              >
                {busy === "inspect" ? "Reading Solana…" : hasEvidence ? "Re-run Solana inspection (free)" : "Run Solana inspection (free)"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void act("free", () =>
                    fetch(`/api/assurance/${inv.id}/intelligence`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "run", mode: "free" }),
                    }),
                  )
                }
                disabled={busy !== null || payload.readOnly || inv.dataMode === "demonstration"}
                className="btn-quiet !min-h-9 !text-[12px]"
              >
                {busy === "free" ? "Probing…" : "Free pre-flight"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void act("intel", () =>
                    fetch(`/api/assurance/${inv.id}/intelligence`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "run", mode: "intel" }),
                    }),
                  )
                }
                disabled={busy !== null || payload.readOnly || inv.dataMode === "demonstration"}
                className="btn-quiet !min-h-9 !text-[12px]"
                title={inv.dataMode === "demonstration" ? "Demonstration files cannot spend" : payload.readOnly ? "Sign in as the file's owner to run intelligence" : undefined}
              >
                {busy === "intel" ? "Creating plan…" : "Request paid intelligence"}
              </button>
              {hasRuns && (
                <button
                  type="button"
                  onClick={() =>
                    void act("sync", () =>
                      fetch(`/api/assurance/${inv.id}/intelligence`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "sync" }),
                      }),
                    )
                  }
                  disabled={busy !== null || payload.readOnly}
                  className="btn-quiet !min-h-9 !text-[12px]"
                >
                  Sync evidence
                </button>
              )}
            </div>

            <div className="mt-5 divide-y divide-edge border-y border-edge">
              {ASSURANCE_CAPABILITIES.map((dim) => (
                <div key={dim.id} className="grid gap-1 py-2.5 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-4">
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium text-ink">{dim.label}</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">{dim.requirement}</p>
                    {dim.status === "gap" && (
                      <p className="mt-1 text-[11px] leading-relaxed text-amber">{dim.missingReason}</p>
                    )}
                  </div>
                  <span className="tabular text-[10.5px] uppercase tracking-wide text-ink-faint">
                    {dim.status === "gap" ? "Unsupported" : `${dim.status} · ${dim.provider} · $${((dim.priceUsdCents ?? 0) / 100).toFixed(2)}`}
                  </span>
                </div>
              ))}
            </div>

            {payload.runs.length > 0 && (
              <div className="mt-5 space-y-2">
                {payload.runs.map((run) => (
                  <div key={run.taskId} className="rounded-md border border-edge bg-panel px-3.5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium text-ink">{run.mode === "intel" ? "Paid intelligence run" : "Free pre-flight"}</span>
                        <span className="tabular text-[10.5px] uppercase tracking-wide text-ink-faint">{run.taskState}</span>
                      </div>
                      <span className="tabular text-[11px] text-ink-faint">
                        {money(run.spendUsdCents)} spent · ceiling {money(run.ceilingUsdCents)}
                      </span>
                    </div>
                    {run.taskError && <p className="mt-1 text-[11.5px] leading-relaxed text-risk">{run.taskError}</p>}
                    {run.canApprove && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="text-[11.5px] text-amber">Waiting for your approval before anything is signed.</p>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(`approve-${run.taskId}`, () =>
                              fetch(`/api/tasks/${run.taskId}/action`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "approve" }),
                              }),
                            )
                          }
                          className="btn-signal !min-h-8 !px-3 !text-[11.5px]"
                        >
                          Approve and run
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(`reject-${run.taskId}`, () =>
                              fetch(`/api/tasks/${run.taskId}/action`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "reject" }),
                              }),
                            )
                          }
                          className="btn-quiet !min-h-8 !px-3 !text-[11.5px]"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5 rounded-md border border-edge bg-panel-3 px-3.5 py-3">
              <p className="text-[11.5px] font-medium text-ink">Mind orchestration</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">{payload.orchestration.note}</p>
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                <span aria-hidden className={`size-1.5 rounded-full ${payload.orchestration.mindConnected ? "bg-teal" : "bg-ink-faint"}`} />
                {payload.orchestration.mindConnected
                  ? "Minds delivery configured"
                  : "No connected Mind configured; planning is deterministic and no Mind claims are shown"}
              </p>
            </div>
          </Section>

          {/* 03 — evidence */}
          <Section
            n="03"
            title="Evidence"
            meta={<span className="tabular text-[11px] text-ink-faint">{inv.evidence.length} record(s)</span>}
          >
            {inv.evidence.length === 0 ? (
              <p className="rounded-md border border-dashed border-edge bg-panel/40 px-4 py-6 text-[12.5px] text-ink-soft">
                No evidence yet. Run the free Solana inspection, then request the intelligence dimensions the
                transaction needs.
              </p>
            ) : (
              <div className="divide-y divide-edge border-y border-edge">
                {inv.evidence.map((ev) => (
                  <div key={ev.id} id={`ev-${ev.id}`} className="py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-sm border px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide ${EVIDENCE_STYLE[ev.class]}`}>
                        {EVIDENCE_LABEL[ev.class]}
                      </span>
                      <span className="text-[12.5px] font-medium text-ink">{ev.title}</span>
                      {ev.costUsdCents ? <span className="tabular text-[10.5px] text-ink-faint">{money(ev.costUsdCents)}</span> : null}
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{ev.detail}</p>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-ink-faint">
                      <span className="tabular">{ev.source.label}</span>
                      <span>{new Date(ev.source.observedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="tabular break-all">{ev.source.ref}</span>
                      {ev.signalHash ? <span className="tabular break-all">signal {ev.signalHash.slice(0, 20)}…</span> : null}
                    </div>
                    {Object.keys(ev.facts).length > 0 && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[10.5px] text-ink-faint">Recorded fields</summary>
                        <dl className="mt-1 grid gap-x-5 gap-y-1 sm:grid-cols-2">
                          {Object.entries(ev.facts).map(([k, v]) => (
                            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-edge/60 py-0.5">
                              <dt className="tabular text-[10.5px] text-ink-faint">{k}</dt>
                              <dd className="tabular break-all text-right text-[10.5px] text-ink-soft">{String(v ?? "—")}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 04 — assessment */}
          <Section
            n="04"
            title="Assessment"
            meta={
              <button
                type="button"
                onClick={() => void act("assess", () => fetch(`/api/assurance/${inv.id}/assess`, { method: "POST" }))}
                disabled={busy !== null || payload.readOnly || inv.dataMode === "demonstration"}
                className="btn-quiet !min-h-8 !px-3 !text-[11.5px]"
              >
                {busy === "assess" ? "Assessing…" : "Record assessment"}
              </button>
            }
          >
            {findings.length === 0 ? (
              <p className="text-[12.5px] text-ink-soft">No finding recorded. Run the assessment once evidence is in.</p>
            ) : (
              <ol className="space-y-3">
                {findings.map((f) => (
                  <li key={f.id} className="rounded-md border border-edge bg-panel px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-sm border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${SEVERITY_STYLE[f.severity]}`}>
                        {f.severity}
                      </span>
                      <p className="text-[12.5px] font-semibold text-ink">{f.title}</p>
                      {f.requiresHuman && <span className="text-[10px] text-ink-faint">human decision required</span>}
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{f.explanation}</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink">{f.significance}</p>
                    {f.evidenceIds.length > 0 && (
                      <p className="mt-1.5 flex flex-wrap gap-2 text-[10.5px] text-ink-faint">
                        Evidence:
                        {f.evidenceIds.map((id) => (
                          <a key={id} href={`#ev-${id}`} className="tabular text-blue hover:underline">
                            {id.slice(0, 12)}…
                          </a>
                        ))}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {/* 05 — decision */}
          <Section n="05" title="Authorization decision" meta={<span id="decision" className="scroll-mt-24" aria-hidden />}>
            {!decision ? (
              <p className="text-[12.5px] text-ink-soft">
                No decision is recorded. The assessment produces CLEARED, HOLD or ESCALATE from the evidence above.
              </p>
            ) : (
              <div className={`rounded-md border px-4 py-4 ${DECISION_STYLE[decision.outcome].panel}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    {decision.outcome === "ESCALATE" ? (
                      <ShieldAlert size={17} aria-hidden className="text-risk" />
                    ) : decision.outcome === "HOLD" ? (
                      <CircleAlert size={17} aria-hidden className="text-amber" />
                    ) : (
                      <Check size={17} aria-hidden className="text-teal" />
                    )}
                    <p className="text-[16px] font-semibold tracking-tight text-ink">{DECISION_STYLE[decision.outcome].label}</p>
                  </div>
                  <p className="tabular text-[11px] text-ink-faint">
                    {new Date(decision.decidedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <p className="mt-2.5 max-w-[80ch] text-[12.5px] leading-relaxed text-ink-soft">{decision.rationale}</p>
                <p className="mt-2 text-[11.5px] text-ink-faint">
                  {decision.settlementAuthorized
                    ? "Settlement preparation is authorized for this file."
                    : "Settlement is not authorized. Held or escalated files cannot produce a settlement bundle."}
                </p>

                <div className="mt-4 border-t border-edge/80 pt-3">
                  <table className="w-full">
                    <tbody>
                      {decision.criteria.map((c) => (
                        <tr key={c.id} className="align-top">
                          <td className="w-5 py-1.5">
                            <span aria-hidden className={`inline-block size-1.5 rounded-full ${c.status === "pass" ? "bg-teal" : c.status === "fail" ? "bg-risk" : "bg-ink-faint"}`} />
                          </td>
                          <td className="py-1.5 pr-4 text-[12px] font-medium text-ink">{c.label}</td>
                          <td className="py-1.5 pr-4 text-[11.5px] leading-snug text-ink-soft">{c.detail}</td>
                          <td className="py-1.5 text-right text-[10.5px] uppercase tracking-wide text-ink-faint">{c.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>

          {/* 06 — settlement */}
          <Section n="06" title="Settlement assurance" meta={<span className="x-tag">UNSIGNED · NOT BROADCAST</span>}>
            {!decision ? (
              <p className="text-[12.5px] text-ink-soft">A settlement bundle can only be prepared after a CLEARED decision.</p>
            ) : decision.outcome !== "CLEARED" ? (
              <div className="rounded-md border border-edge bg-panel px-4 py-3.5">
                <p className="text-[12.5px] font-medium text-ink">Settlement blocked by the {decision.outcome} decision</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
                  {decision.openIssues} open critical or material issue(s). Re-run the investigation after the
                  counterparty resolves them; NIGHTSHIFT will not prepare a transfer around an open discrepancy.
                </p>
              </div>
            ) : inv.settlement ? (
              <div className="space-y-3">
                <div className="rounded-md border border-edge bg-panel px-4 py-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[12.5px] font-medium text-ink">
                      {inv.settlement.status === "confirmed_on_chain"
                        ? "Settlement confirmed on chain"
                        : inv.settlement.status === "failed"
                          ? "Settlement transaction failed on chain"
                          : inv.settlement.signature
                            ? "Signature checked: not confirmed yet"
                            : "Bundle prepared, awaiting an authorized signer"}
                    </p>
                    <span className="tabular text-[10.5px] uppercase tracking-wide text-ink-faint">{inv.settlement.status.replace(/_/g, " ")}</span>
                  </div>
                  <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    <Fact label="Source token account" value={inv.settlement.sourceTokenAccount ?? "—"} />
                    <Fact label="Destination token account" value={inv.settlement.destinationTokenAccount ?? "—"} />
                    <Fact label="Amount (base units)" value={inv.settlement.amountBaseUnits} />
                    <Fact label="Recent blockhash" value={inv.settlement.recentBlockhash} />
                    <Fact label="Last valid block height" value={String(inv.settlement.lastValidBlockHeight ?? "—")} />
                    <Fact label="Instructions" value={`${inv.settlement.instructions.length} (memo + SPL transfer)`} />
                  </dl>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[10.5px] text-ink-faint">Instruction bundle</summary>
                    <ol className="mt-2 space-y-2">
                      {inv.settlement.instructions.map((ins, i) => (
                        <li key={i} className="rounded-sm border border-edge bg-panel-3 px-2.5 py-2">
                          <p className="text-[11.5px] text-ink-soft">{ins.description}</p>
                          <p className="tabular mt-1 break-all text-[10px] text-ink-faint">program {ins.programId}</p>
                          <p className="tabular break-all text-[10px] text-ink-faint">data {ins.data}</p>
                        </li>
                      ))}
                    </ol>
                  </details>
                  <p className="mt-3 border-t border-edge pt-2.5 text-[11px] leading-relaxed text-amber">
                    NIGHTSHIFT did not sign or broadcast this bundle. An authorized institutional signer must sign and
                    submit it; nothing is recorded as settled until a live chain read confirms the signature.
                  </p>
                  {inv.settlement.verification && (
                    <p className="mt-2 text-[11px] text-ink-faint">
                      Last check: {inv.settlement.verification.status}
                      {inv.settlement.verification.slot ? ` at slot ${inv.settlement.verification.slot}` : ""} ·{" "}
                      {inv.settlement.verification.rpcUrl}
                    </p>
                  )}
                </div>

                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act("verify", () =>
                      fetch(`/api/assurance/${inv.id}/settlement`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "verify", signature }),
                      }),
                    );
                  }}
                >
                  <label className="min-w-0 flex-1">
                    <span className="x-label mb-1 block">Transaction signature (from the authorized signer)</span>
                    <input
                      value={signature}
                      onChange={(e) => setSignature(e.target.value)}
                      placeholder="Solana transaction signature"
                      spellCheck={false}
                      className="tabular w-full rounded-md border border-edge bg-panel-2 px-3 py-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
                    />
                  </label>
                  <button type="submit" disabled={busy !== null || payload.readOnly || signature.trim().length < 64} className="btn-quiet !min-h-9 !text-[12px]">
                    {busy === "verify" ? "Checking chain…" : "Verify on chain"}
                  </button>
                </form>
              </div>
            ) : (
              <div className="rounded-md border border-teal/35 bg-teal/[0.04] px-4 py-3.5">
                <p className="text-[12.5px] leading-relaxed text-ink-soft">
                  The transaction is cleared. Prepare the unsigned SPL transfer and memo bundle from live Solana token
                  accounts and a recent blockhash. It will not be signed or broadcast here.
                </p>
                <button
                  type="button"
                  onClick={() => void act("prepare", () => fetch(`/api/assurance/${inv.id}/settlement`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "prepare" }) }))}
                  disabled={busy !== null || payload.readOnly}
                  className="btn-primary mt-3 !min-h-9 !text-[12px]"
                >
                  {busy === "prepare" ? "Reading live chain state…" : "Prepare settlement bundle"}
                </button>
              </div>
            )}
          </Section>
        </div>

        {/* rail */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-md border border-edge bg-panel px-4 py-4">
            <p className="x-label">Workflow</p>
            <ol className="mt-3 space-y-2.5">
              {workflow.map((step, i) => (
                <li key={step.label} className="flex items-center gap-2.5">
                  <span className="grid size-4 place-items-center" aria-hidden>
                    <StatusDot done={step.done} active={step.active} />
                  </span>
                  <span className={`text-[12px] ${step.done ? "text-ink" : "text-ink-faint"}`}>
                    {i + 1}. {step.label}
                  </span>
                </li>
              ))}
            </ol>
            {awaiting && (
              <p className="mt-3 border-t border-edge pt-2.5 text-[11px] leading-snug text-amber">
                A paid plan is waiting for approval in section 02.
              </p>
            )}
          </div>

          <div className="mt-3 rounded-md border border-edge bg-panel px-4 py-4">
            <p className="x-label">Evidence provenance</p>
            <dl className="mt-2.5 space-y-1.5">
              {[
                { label: "Solana reads", value: sourceVerified, tone: "text-teal" },
                { label: "Node-verified answers", value: nodeVerified, tone: "text-blue" },
                { label: "Probe only (no answer)", value: probeOnly, tone: "text-ink-soft" },
                { label: "Demonstration records", value: demo, tone: "text-amber" },
              ].map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[11.5px] text-ink-faint">{row.label}</dt>
                  <dd className={`tabular text-[12px] ${row.tone}`}>{row.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2.5 border-t border-edge pt-2 text-[10.5px] leading-snug text-ink-faint">
              A paid answer is only counted when the engine re-derived it against the node signal.
            </p>
          </div>

          {paidRuns.length > 0 && (
            <div className="mt-3 rounded-md border border-edge bg-panel px-4 py-4">
              <p className="x-label">Intelligence spend</p>
              {paidRuns.map((r) => (
                <div key={r.taskId} className="mt-2 flex items-baseline justify-between gap-2">
                  <span className="tabular text-[10.5px] text-ink-faint">{r.taskId.slice(0, 8)}…</span>
                  <span className="tabular text-[11.5px] text-ink">{money(r.spendUsdCents)}</span>
                </div>
              ))}
              <Link href="/activity" className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink-soft hover:text-ink">
                Open the task ledger <ArrowRight size={11} aria-hidden />
              </Link>
            </div>
          )}

          {inv.limitations.length > 0 && (
            <div className="mt-3 rounded-md border border-edge bg-panel-3 px-4 py-4">
              <p className="x-label">Stated limits</p>
              <ul className="mt-2 space-y-2">
                {inv.limitations.map((l, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-ink-soft">
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {inv.audit.length > 0 && (
            <details className="mt-3 rounded-md border border-edge bg-panel px-4 py-3">
              <summary className="cursor-pointer text-[11px] font-medium text-ink-soft">Audit trail ({inv.audit.length})</summary>
              <ol className="mt-2 space-y-2">
                {[...inv.audit].reverse().map((a, i) => (
                  <li key={i} className="text-[10.5px] leading-snug text-ink-faint">
                    <span className="tabular">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{" "}
                    <span className="text-ink-soft">{a.actor}</span> · {a.action}
                    <span className="block text-ink-faint">{a.detail}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}
