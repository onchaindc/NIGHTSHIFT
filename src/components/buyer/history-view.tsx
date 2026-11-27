"use client";

/**
 * Past requests — a dedicated history view: every job the buyer opened,
 * with its lifecycle phase, on-chain references and transaction links.
 * Opening one moves the desk into that job's tracking view.
 */

import { ArrowRight } from "lucide-react";

import type { BuyerJobView } from "@/lib/acp/buyer";
import { formatUsdc } from "@/lib/acp/buyer-browser";

const PHASE_TONE: Record<string, string> = {
  completed: "text-teal",
  failed: "text-risk",
  rejected: "text-risk",
  rejected_intake: "text-risk",
  expired: "text-risk",
};

function txLink(label: string, hash: string) {
  return (
    <a key={label} href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer" className="tabular text-[10.5px] text-teal hover:underline">
      {label} ↗
    </a>
  );
}

export function HistoryView({
  jobs,
  activeKey,
  onOpen,
  loadFailed = false,
  onRetry,
}: {
  jobs: BuyerJobView[];
  activeKey: string | null;
  onOpen: (key: string) => void;
  /** The last jobs fetch FAILED — never render "No requests yet" for that:
   *  an empty list and a failed load are different truths. */
  loadFailed?: boolean;
  onRetry?: () => void;
}) {
  if (loadFailed && jobs.length === 0) {
    return (
      <div className="rounded-xl border border-risk/30 bg-panel px-4 py-6 sm:px-5" role="alert">
        <p className="x-label !mt-0">Your requests</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          Your requests could not be loaded — the connection to the server dropped. Nothing was lost: your on-chain jobs and their escrows are unaffected.
        </p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn-quiet mt-3 !min-h-8 !text-[12px]">
            Try again
          </button>
        )}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-edge bg-panel px-4 py-6 sm:px-5">
        <p className="x-label !mt-0">Your requests</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">No requests yet. Pick a service on the storefront to create your first ACP job — it will be listed here with its transactions and report.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5" aria-label="Your requests">
      <p className="x-label !mt-0">
        Your requests <span className="ml-1 normal-case tracking-normal tabular">({jobs.length})</span>
      </p>
      {loadFailed && (
        <p className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber/40 bg-amber-soft/40 px-3 py-2 text-[11px] text-amber-deep" role="status">
          <span>The last refresh failed — showing the last loaded list.</span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="btn-quiet !min-h-7 !text-[11px]">
              Retry
            </button>
          )}
        </p>
      )}
      <ul className="mt-3 space-y-1.5">
        {jobs.map((j) => {
          const refs = [
            j.buyer.txHash ? txLink("created", j.buyer.txHash) : null,
            j.buyer.allowanceTxHash ? txLink("allowance", j.buyer.allowanceTxHash) : null,
            j.buyer.fundedTxHash ? txLink("funded", j.buyer.fundedTxHash) : null,
            j.buyer.completedTxHash ? txLink("released", j.buyer.completedTxHash) : null,
          ].filter(Boolean);
          const price = j.provider?.priceUsdCents ? formatUsdc(BigInt(j.provider.priceUsdCents) * 10_000n) : null;
          return (
            <li key={j.buyer.key}>
              <button
                type="button"
                onClick={() => onOpen(j.buyer.key)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${j.buyer.key === activeKey ? "border-teal/40 bg-teal/5" : "border-edge bg-panel-2 hover:border-edge-strong"}`}
              >
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-ink">{j.provider?.offering ?? j.buyer.offering}</span>
                  <span className={`text-[11px] font-medium ${PHASE_TONE[j.phase] ?? "text-amber-deep"}`}>{j.phaseLabel}</span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-ink-faint">
                  <span className="tabular">job {j.buyer.jobId}</span>
                  <span>·</span>
                  <span>opened {new Date(j.buyer.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  {price && (
                    <>
                      <span>·</span>
                      <span className="tabular">{price} USDC</span>
                    </>
                  )}
                  {refs.length > 0 && <span className="flex flex-wrap items-center gap-2">{refs.map((r, i) => (<span key={i} className="contents">{r}</span>))}</span>}
                </span>
                <span className="mt-1 flex items-center gap-1 text-[11px] font-medium text-teal">
                  Open tracking <ArrowRight size={11} aria-hidden />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
