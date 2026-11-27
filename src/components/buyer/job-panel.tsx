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

import Link from "next/link";
import { Check, ChevronDown, CircleAlert, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";

import type { BuyerJobView, BuyerPhase } from "@/lib/acp/buyer";
import { BUYER_PHASE_LABEL } from "@/lib/acp/buyer";
import type { DeskDeliverable } from "@/lib/acp/lifecycle";
import type { OnChainJobView } from "@/lib/acp/buyer-browser";
import { formatUsdc } from "@/lib/acp/buyer-browser";

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
  onApprovePayment,
  onReleaseEscrow,
  actionError,
  children,
}: {
  view: BuyerJobView;
  chainJob: OnChainJobView | null;
  busy: string | null;
  onApprovePayment: () => void;
  onReleaseEscrow: () => void;
  actionError: string | null;
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
            {actionError && <p className="w-full text-[12px] text-risk">{actionError}</p>}
          </div>
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
              <p className="text-[11px] leading-relaxed text-ink-faint">
                The full structured report (every record, its provenance and the traced assessment) is carried in this deliverable&apos;s{" "}
                <span className="tabular">report</span> field — reference {deliverable.reference}, investigation{" "}
                <Link href={`/desk/i/${deliverable.investigationId}`} className="text-teal hover:underline">
                  {deliverable.investigationId.slice(0, 8)}…
                </Link>
              </p>
            </div>
          </details>
        )}
      </div>
    </section>
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
