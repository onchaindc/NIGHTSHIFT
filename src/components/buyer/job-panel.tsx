"use client";

/**
 * The buyer's job panel — the lifecycle of ONE real ACP job, state-first:
 * a six-stage tracker (Submit → Price → Pay → Investigate → Deliver →
 * Settle) driven by the provider's actual AcpJobStatus, one plain-language
 * headline per phase, the phase's action up front, and the deliverable
 * (the evidence-backed report) rendered in place. On-chain truth (the
 * ERC-8183 job's status and budget) is shown alongside the provider's
 * lifecycle — never one instead of the other.
 */

import { Check, ChevronDown, CircleAlert, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";

import type { BuyerJobView, BuyerPhase } from "@/lib/acp/buyer";
import { BUYER_PHASE_LABEL } from "@/lib/acp/buyer";
import type { DeskDeliverable } from "@/lib/acp/lifecycle";
import type { StallView } from "@/lib/acp/buyer-stages";
import type { DeskReport } from "@/lib/desk/types";
import type { OnChainJobView, TxErrorView } from "@/lib/acp/buyer-browser";
import { formatUsdc } from "@/lib/acp/buyer-browser";
import { ErrorNotice } from "./error-notice";

const PHASES: { key: BuyerPhase | "settle"; label: string }[] = [
  { key: "submitted", label: "Submit" },
  { key: "reading", label: "Price" },
  { key: "awaiting_payment", label: "Pay" },
  { key: "processing", label: "Investigate" },
  { key: "review_delivery", label: "Deliver" },
  { key: "completed", label: "Settle" },
];

function stageIndex(phase: BuyerPhase): number {
  switch (phase) {
    case "submitted":
      return 0;
    case "reading":
      return 1;
    case "rejected_intake":
      return 1;
    case "awaiting_payment":
      return 2;
    case "processing":
      return 3;
    case "review_delivery":
      return 4;
    case "completed":
      return 5;
    case "rejected":
      return 4;
    case "expired":
      return 2;
    case "failed":
      return 3;
  }
}

function phaseTone(phase: BuyerPhase): "working" | "attention" | "done" | "failed" | "stopped" {
  if (phase === "completed") return "done";
  if (phase === "rejected" || phase === "failed" || phase === "rejected_intake" || phase === "expired") return "failed";
  if (phase === "awaiting_payment" || phase === "review_delivery") return "attention";
  if (phase === "submitted" || phase === "reading") return "working";
  return "working";
}

const TONE_CARD: Record<string, string> = {
  working: "border-teal/30 bg-teal/5",
  attention: "border-amber/40 bg-amber-soft/40",
  done: "border-teal/30 bg-teal/5",
  failed: "border-risk/30 bg-risk/5",
  stopped: "border-edge bg-panel-2",
};

const ONCHAIN_STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

export function JobPanel({
  view,
  chainJob,
  busy,
  stepNote,
  stall,
  onApprovePayment,
  onReleaseEscrow,
  actionError,
  children,
}: {
  view: BuyerJobView;
  chainJob: OnChainJobView | null;
  busy: string | null;
  /** The echo between the two payment confirmations, so the buyer always
   *  knows which signature they are looking at. */
  stepNote?: string | null;
  /** The honest waiting view (elapsed, unusual-wait notice, expiry). */
  stall?: StallView | null;
  onApprovePayment: () => void;
  onReleaseEscrow: () => void;
  actionError: TxErrorView | null;
  children?: React.ReactNode;
}) {
  const { buyer, provider, phase } = view;
  const idx = stageIndex(phase);
  const dead = phase === "rejected" || phase === "failed" || phase === "expired" || phase === "rejected_intake";
  const status = idx >= 0 ? PHASES.map((_, i) => (i < idx ? "done" : i === idx ? (dead ? "failed" : "active") : "pending")) : [];
  const tone = phaseTone(phase);
  const priceUsdCents = provider?.priceUsdCents ?? null;
  const onChainBudget = chainJob?.budget ?? null;
  const budgetAgrees =
    priceUsdCents !== null && onChainBudget !== null ? onChainBudget === BigInt(Math.round(priceUsdCents)) * 10_000n : null;
  let deliverable: DeskDeliverable | null = null;
  if (provider?.deliverable) {
    try {
      deliverable = JSON.parse(provider.deliverable) as DeskDeliverable;
    } catch {
      deliverable = null;
    }
  }

  const headline = () => {
    switch (phase) {
      case "submitted":
        return {
          title: "Job created — the request rides the on-chain job description",
          sub: "NIGHTSHIFT reads the requirement directly from the job (and the job room when available) and answers with the price via setBudget. Nothing moves until you fund.",
        };
      case "reading":
        return { title: "NIGHTSHIFT is reading your request", sub: provider?.statusDetail ?? "Validating the requirement against the offering's schema." };
      case "rejected_intake":
        return { title: "The request was refused at intake", sub: provider?.statusDetail ?? "Nothing was priced and no funds can be committed. Adjust the request and create a new job." };
      case "awaiting_payment":
        return { title: `Waiting for your payment — ${priceUsdCents !== null ? formatUsdc(BigInt(priceUsdCents) * 10_000n) : "price below"}`, sub: "The provider priced the job on-chain. Funding the escrow releases the investigation." };
      case "processing":
        return { title: "Processing the investigation", sub: provider?.statusDetail ?? "Funded — the investigation is running." };
      case "review_delivery":
        return { title: "Report delivered — review, then release the escrow", sub: "Read the report below. Releasing is YOUR action: the escrow settles only when you accept on-chain." };
      case "completed":
        return { title: "Completed — escrow settled", sub: provider?.statusDetail ?? "The deliverable is final." };
      case "rejected":
        return { title: "The deliverable was rejected on-chain", sub: provider?.statusDetail ?? "" };
      case "expired":
        return { title: "The job expired", sub: provider?.statusDetail ?? "The escrow was never funded in time or the job aged out." };
      case "failed":
        return { title: "The job failed on the provider side", sub: provider?.statusDetail ?? "" };
    }
  };
  const head = headline();

  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-label="Your ACP job">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3 sm:px-5">
        <p className="x-label !mt-0">{provider ? provider.offering : buyer.offering}</p>
        <span className="flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="tabular">job {buyer.jobId}</span>
          {buyer.txHash && (
            <a href={`https://basescan.org/tx/${buyer.txHash}`} target="_blank" rel="noreferrer" className="tabular text-teal hover:underline">
              created ↗
            </a>
          )}
        </span>
      </div>

      <div className="space-y-3.5 px-4 py-4 sm:px-5">
        {/* Tracker */}
        <ol className="flex items-center gap-1" aria-label="Job stages">
          {PHASES.map((p, i) => {
            const st = status[i] ?? "pending";
            const dot =
              st === "done"
                ? "border-teal bg-teal text-panel"
                : st === "active"
                  ? "border-teal bg-teal/10 text-teal animate-pulse"
                  : st === "failed"
                    ? "border-risk bg-risk text-panel"
                    : "border-edge bg-panel-2 text-ink-faint/60";
            const labelTone = st === "active" ? "text-teal font-medium" : st === "done" ? "text-ink-soft" : st === "failed" ? "text-risk font-medium" : "text-ink-faint/80";
            return (
              <li key={p.key} className="flex min-w-0 items-center gap-1" aria-current={st === "active" ? "step" : undefined}>
                {i > 0 && <span aria-hidden className={`h-px w-2.5 shrink-0 sm:w-4 ${status[i - 1] === "done" ? "bg-teal/40" : "bg-edge"}`} />}
                <span className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${dot}`} aria-hidden>
                  {st === "done" && <Check size={9} strokeWidth={3} />}
                  {st === "active" && <span className="size-1.5 rounded-full bg-teal" />}
                  {st === "failed" && <span className="text-[9px] font-bold leading-none">!</span>}
                </span>
                <span className={`truncate text-[10px] tracking-wide ${labelTone}`}>{p.label}</span>
              </li>
            );
          })}
        </ol>

        {/* Headline + action */}
        <div className={`rounded-lg border px-3.5 py-3 ${TONE_CARD[tone]}`} role="status">
          <p className="flex items-center gap-2 text-[14px] font-medium leading-snug text-ink">
            {tone === "working" && <LoaderCircle size={15} aria-hidden className="shrink-0 animate-spin text-teal" />}
            {tone === "attention" && <ShieldCheck size={15} aria-hidden className="shrink-0 text-amber-deep" />}
            {tone === "done" && <Check size={15} aria-hidden className="shrink-0 text-teal" />}
            {tone === "failed" && <CircleAlert size={15} aria-hidden className="shrink-0 text-risk" />}
            {head.title}
          </p>
          {head.sub && <p className="mt-1 text-[12px] leading-relaxed text-ink-soft break-words [overflow-wrap:anywhere]">{head.sub}</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {view.action === "fund" && (
              <button type="button" onClick={onApprovePayment} disabled={busy !== null} className="btn-primary !min-h-9">
                {busy === "fund" ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
                {priceUsdCents !== null ? `Approve payment — fund ${formatUsdc(BigInt(priceUsdCents) * 10_000n)} USDC escrow` : "Approve payment — fund the escrow"}
              </button>
            )}
            {view.action === "review" && chainJob?.status === 2 && (
              <button type="button" onClick={onReleaseEscrow} disabled={busy !== null} className="btn-primary !min-h-9">
                {busy === "release" ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
                Release escrow — accept delivery
              </button>
            )}
            {view.action === "review" && chainJob && chainJob.status !== 2 && (
              <p className="text-[11.5px] text-ink-faint">
                On-chain status is “{ONCHAIN_STATUS[chainJob.status] ?? chainJob.status}” — the release action becomes available once the deliverable is submitted on-chain.
              </p>
            )}
            {actionError && (
              <div className="w-full">
                <ErrorNotice error={actionError} />
              </div>
            )}
            {stepNote && (
              <p className="flex w-full items-center gap-2 text-[11.5px] font-medium text-teal" role="status">
                <LoaderCircle size={12} className="animate-spin" aria-hidden /> {stepNote}
              </p>
            )}
          </div>
        </div>

        {/* Honest waiting: an unusually long wait is said so — with the
            money-truth (nothing is at risk until the buyer funds) and the
            on-chain expiry countdown. Terminal phases keep their own words. */}
        {stall?.stalled && !dead && (
          <div className="rounded-lg border border-amber/40 bg-amber-soft/40 px-3.5 py-2.5" role="status">
            <p className="flex items-start gap-2 text-[12px] font-medium leading-snug text-amber-deep">
              <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" /> {stall.stallTitle}
            </p>
            {stall.stallDetail && <p className="mt-1 pl-[21px] text-[11.5px] leading-relaxed text-amber-deep/90">{stall.stallDetail}</p>}
          </div>
        )}
        {stall?.expiryNote && !dead && <p className="px-1 text-[11px] leading-relaxed text-ink-faint">{stall.expiryNote}</p>}

        {/* On-chain transactions — every reference, linked. A signature that
            never happened shows no hash; the desk never reports a
            transaction as submitted without its hash. */}
        <div className="rounded-lg border border-edge bg-panel-2 px-3.5 py-3">
          <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">On-chain transactions</p>
          <ul className="mt-1.5 space-y-1">
            <TxRow label="Job creation" hash={buyer.txHash} when={buyer.createdAt} />
            <TxRow label="USDC allowance" hash={buyer.allowanceTxHash} />
            <TxRow label="Escrow funding" hash={buyer.fundedTxHash} />
            <TxRow label="Escrow release" hash={buyer.completedTxHash} />
          </ul>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
            Every signature you make lands here with its Basescan link. A row without a link means that signature has not happened yet.
          </p>
        </div>

        {/* On-chain truth row */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fact label="On-chain status" value={chainJob ? ONCHAIN_STATUS[chainJob.status] ?? String(chainJob.status) : "—"} />
          <Fact label="Escrow budget" value={onChainBudget !== null ? formatUsdc(onChainBudget) : priceUsdCents !== null ? formatUsdc(BigInt(priceUsdCents) * 10_000n) : "—"} />
          <Fact label="Provider" value={chainJob ? `${chainJob.provider.slice(0, 6)}…${chainJob.provider.slice(-4)}` : "—"} />
          <Fact
            label="Funded"
            value={buyer.fundedTxHash ? "yes" : "no"}
            href={buyer.fundedTxHash ? `https://basescan.org/tx/${buyer.fundedTxHash}` : undefined}
          />
        </div>
        {budgetAgrees === false && (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-amber-deep">
            <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
            The provider&apos;s quoted price differs from the budget currently on-chain — fund only what you agree with; the escrow takes exactly the budget.
          </p>
        )}

        {buyer.notes.length > 0 && (
          <details className="rounded-lg border border-edge bg-panel-2 px-3.5 py-2.5">
            <summary className="cursor-pointer list-none text-[11px] uppercase tracking-[0.1em] text-ink-faint">Buyer record notes ({buyer.notes.length})</summary>
            <ul className="mt-1.5 space-y-1">
              {buyer.notes.map((n, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-ink-faint break-words [overflow-wrap:anywhere]">{n}</li>
              ))}
            </ul>
          </details>
        )}

        {children}

        {/* The deliverable */}
        {deliverable && (
          <details className="group rounded-lg border border-edge bg-panel-2" open>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5">
              <span className="text-[12.5px] font-medium text-ink">The deliverable — {deliverable.typeLabel}</span>
              <ChevronDown size={14} aria-hidden className="text-ink-faint transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-3 border-t border-edge px-3.5 py-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Fact label="Verdict" value={deliverable.reportSummary.verdict} />
                <Fact label="Confidence" value={deliverable.reportSummary.confidence} />
                <Fact label="Reference" value={deliverable.reference} />
                <Fact label="Provider spend" value={formatUsdc(BigInt(Math.max(deliverable.spend.spentUsdCents, 0)) * 10_000n)} />
              </div>
              {deliverable.reportSummary.headline && <p className="text-[13px] font-medium leading-snug text-ink">{deliverable.reportSummary.headline}</p>}
              {deliverable.receipts.length > 0 && (
                <div>
                  <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Evidence receipts</p>
                  <ul className="mt-1 space-y-1">
                    {deliverable.receipts.map((r, i) => (
                      <li key={`${r.capability}-${i}`} className="text-[11.5px] leading-relaxed text-ink-soft">
                        <span className={r.verification.includes("FAILED") ? "text-risk" : r.verification.startsWith("independently") ? "text-teal" : "text-ink"}>
                          {r.verification}
                        </span>{" "}
                        — {r.label}
                        {r.signalHash && (
                          <>
                            {" · "}
                            <span className="tabular text-ink-faint">signal {r.signalHash.slice(0, 10)}…{r.signalHash.slice(-6)}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {deliverable.verificationFailures.length > 0 && (
                <div>
                  <p className="text-[10.5px] uppercase tracking-[0.1em] text-risk">Verification failures — named, never hidden</p>
                  <ul className="mt-1 space-y-1">
                    {deliverable.verificationFailures.map((f, i) => (
                      <li key={i} className="text-[11.5px] leading-relaxed text-ink-soft">
                        {f.capability}: {f.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {deliverable.discrepancies.length > 0 && (
                <div>
                  <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Discrepancies</p>
                  <ul className="mt-1 space-y-1">
                    {deliverable.discrepancies.map((d, i) => (
                      <li key={i} className="text-[11.5px] leading-relaxed text-ink-soft">
                        {d.title}
                        {d.material === true && <span className="ml-1.5 text-amber-deep">(material)</span>}: {d.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {deliverable.missingEvidence.length > 0 && (
                <div>
                  <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Missing evidence</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{deliverable.missingEvidence.join(" · ")}</p>
                </div>
              )}
              {deliverable.report ? (
                <FullReport report={deliverable.report} />
              ) : (
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  The full structured report is part of this deliverable — reference <span className="tabular">{deliverable.reference}</span>, investigation{" "}
                  <span className="tabular">{deliverable.investigationId.slice(0, 8)}…</span>.
                </p>
              )}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * The full structured report, rendered IN the buyer's desk — every section,
 * finding, limitation and open question the provider delivered, exactly as
 * recorded. The buyer paid for this; it does not live behind the operator
 * console (the old layout pointed buyers at /desk/i/<id>), and nothing here
 * is re-worded: it is the delivered evidence ledger, verbatim.
 */
function FullReport({ report }: { report: DeskReport }) {
  const verdict = report.assessment.verdict.replace(/_/g, " ");
  return (
    <details className="group rounded-lg border border-edge bg-panel-2" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5">
        <span className="text-[12.5px] font-medium text-ink">The full report — every section, finding and limitation</span>
        <ChevronDown size={14} aria-hidden className="text-ink-faint transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-edge px-3.5 py-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fact label="Verdict" value={verdict} />
          <Fact label="Confidence" value={report.confidence.replace(/_/g, " ")} />
          <Fact label="Verified records" value={String(report.counts.verified)} />
          <Fact label="Prepared" value={new Date(report.preparedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} />
        </div>
        {report.assessment.summary && <p className="text-[12.5px] leading-relaxed text-ink-soft">{report.assessment.summary}</p>}
        {report.assessment.basis.length > 0 && (
          <div>
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">The assessment rests on</p>
            <ul className="mt-1 space-y-1">
              {report.assessment.basis.map((b, i) => (
                <li key={i} className="text-[11.5px] leading-relaxed text-ink-soft">— {b}</li>
              ))}
            </ul>
          </div>
        )}
        {report.sections.length > 0 && (
          <div>
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Sections</p>
            <ul className="mt-1.5 space-y-2">
              {report.sections.map((s) => (
                <li key={s.id} className="rounded-lg border border-edge bg-panel px-3 py-2.5">
                  <p className="text-[12px] font-medium text-ink">
                    {s.title} <span className="ml-1 text-[10px] font-normal text-ink-faint">provenance: {s.provenance.replace(/_/g, " ")}</span>
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-soft">{s.summary}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.findings.length > 0 && (
          <div>
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Findings</p>
            <ul className="mt-1 space-y-1.5">
              {report.findings.map((f) => (
                <li key={f.id} className="text-[11.5px] leading-relaxed text-ink-soft">
                  <span className="font-medium text-ink">{f.title}</span> — {f.detail} <span className="text-ink-faint">({f.provenance.replace(/_/g, " ")})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.limitations.length > 0 && (
          <div>
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Limitations — stated plainly</p>
            <ul className="mt-1 space-y-1">
              {report.limitations.map((l, i) => (
                <li key={i} className="text-[11.5px] leading-relaxed text-ink-soft">{l}</li>
              ))}
            </ul>
          </div>
        )}
        {report.outstandingQuestions.length > 0 && (
          <div>
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Outstanding questions</p>
            <ul className="mt-1 space-y-1">
              {report.outstandingQuestions.map((q, i) => (
                <li key={i} className="text-[11.5px] leading-relaxed text-ink-soft">{q}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function Fact({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-panel-2 px-2.5 py-2">
      <p className="text-[9.5px] uppercase tracking-[0.1em] text-ink-faint">{label}</p>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="mt-0.5 block truncate text-[11.5px] font-medium text-teal hover:underline">
          {value}
        </a>
      ) : (
        <p className="mt-0.5 truncate text-[11.5px] font-medium text-ink" title={value}>
          {value}
        </p>
      )}
    </div>
  );
}

function TxRow({ label, hash, when }: { label: string; hash: string | null; when?: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
      <span className="text-[11.5px] text-ink-soft">{label}</span>
      {hash ? (
        <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer" className="tabular text-[11px] text-teal hover:underline">
          {hash.slice(0, 10)}…{hash.slice(-8)} ↗
        </a>
      ) : (
        <span className="text-[11px] text-ink-faint">— not signed yet</span>
      )}
    </li>
  );
}
