"use client";

/**
 * Review and purchase — the dedicated step BEFORE any signature.
 *
 * Everything the buyer must know is on this screen: the selected service,
 * the submitted requirements, the price in USDC, the buyer wallet and its
 * verified network, the preflight reads (gas, USDC, allowance), and a
 * plain-language list of every wallet confirmation the purchase will ask
 * for. Job creation, payment approval and escrow funding stay clearly
 * separate — the buyer never signs blind.
 */

import { ArrowLeft, Check, CircleAlert, LoaderCircle, RefreshCcw, ShieldCheck, TriangleAlert } from "lucide-react";

import type { AcpServiceOffering } from "@/lib/acp/types";
import type { TxErrorView } from "@/lib/acp/tx-errors";
import { formatUsdc, usdcBaseUnits, chainLabel } from "@/lib/acp/buyer-browser";
import type { PreflightCheck } from "@/lib/acp/buyer-stages";
import { ErrorNotice } from "./error-notice";

export function ReviewStage({
  offering,
  subject,
  priceBase,
  walletAddress,
  walletChainId,
  requiredChainId,
  switching,
  preflight,
  preflightLoading,
  createError,
  busy,
  onSwitchToBase,
  onRefreshPreflight,
  onCreateJob,
  onBack,
  signedIn,
}: {
  offering: AcpServiceOffering;
  subject: Record<string, string>;
  priceBase: bigint;
  walletAddress: string | null;
  walletChainId: number | null;
  requiredChainId: number;
  switching: boolean;
  preflight: PreflightCheck[];
  preflightLoading: boolean;
  createError: TxErrorView | null;
  busy: string | null;
  onSwitchToBase: () => void;
  onRefreshPreflight: () => void;
  onCreateJob: () => void;
  onBack: () => void;
  signedIn: boolean;
}) {
  const blocked = preflight.some((c) => c.state === "block");
  const networkOk = walletChainId === requiredChainId;
  const price = formatUsdc(priceBase);

  return (
    <section aria-label="Review and purchase" className="space-y-3">
      <header className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
        <p className="x-label !mt-0">Review · {offering.name}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          Review, then sign — nothing moves without your explicit confirmation.
        </p>
      </header>

      {/* Requirements + price */}
      <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
        <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Your requirements</p>
        <dl className="mt-2 space-y-1.5">
          {offering.inputs.map((f) => {
            const value = (subject[f.name] ?? "").trim();
            if (!value && !f.required) return null;
            return (
              <div key={f.name} className="flex flex-wrap gap-x-2 gap-y-0.5 border-b border-edge/60 pb-1.5 last:border-0 last:pb-0">
                <dt className="text-[11.5px] text-ink-faint">
                  {f.label}
                  {!f.required && !/optional/i.test(f.label) ? " (optional)" : ""}
                </dt>
                <dd className="min-w-0 flex-1 break-words text-right text-[12.5px] text-ink">{value || <span className="text-ink-faint">— left empty —</span>}</dd>
              </div>
            );
          })}
        </dl>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-edge pt-3">
          <p className="text-[12.5px] text-ink-soft">Price — settled in USDC on Base</p>
          <p className="tabular text-[16px] font-semibold text-ink">{price} <span className="text-[12px] font-normal text-ink-faint">USDC</span></p>
        </div>
      </div>

      {/* Wallet + network */}
      <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
        <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Buyer wallet &amp; network</p>
        {walletAddress ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
              <span className="tabular">
                {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
              </span>
              <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${networkOk ? "border-teal/30 bg-teal/5 text-teal" : "border-amber/40 bg-amber-soft/40 text-amber-deep"}`}>
                {networkOk ? <Check size={11} aria-hidden /> : <TriangleAlert size={11} aria-hidden />}
                {networkOk ? "Base (8453)" : walletChainId === null ? "network unread" : `on ${chainLabel(walletChainId)}`}
              </span>
            </div>
            {!networkOk && (
              <div className="space-y-2">
                <p className="text-[12px] leading-relaxed text-amber-deep">
                  NIGHTSHIFT transactions only sign on Base (chain 8453). Your wallet is on {chainLabel(walletChainId)} — switching is requested explicitly; nothing signs on the wrong chain.
                </p>
                <button type="button" onClick={onSwitchToBase} disabled={switching} className="btn-signal !min-h-8 !text-[12px]">
                  {switching ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <RefreshCcw size={12} aria-hidden />}
                  {switching ? "Check your wallet…" : "Switch wallet to Base"}
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{signedIn ? "Open the wallet panel to connect a wallet for signing." : "Sign in with your wallet — the desk needs it for the signatures."}</p>
        )}
      </div>

      {/* Preflight */}
      <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Before anything signs</p>
          <button type="button" onClick={onRefreshPreflight} disabled={preflightLoading} className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-faint transition-colors hover:text-teal">
            <RefreshCcw size={11} className={preflightLoading ? "animate-spin" : ""} aria-hidden /> Refresh
          </button>
        </div>
        <ul className="mt-2 space-y-1.5">
          {preflight.map((c) => (
            <li key={c.id} className="flex items-start gap-2">
              {c.state === "ok" ? (
                <Check size={13} aria-hidden className="mt-0.5 shrink-0 text-teal" />
              ) : c.state === "warn" ? (
                <CircleAlert size={13} aria-hidden className="mt-0.5 shrink-0 text-amber-deep" />
              ) : (
                <CircleAlert size={13} aria-hidden className="mt-0.5 shrink-0 text-risk" />
              )}
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-ink">{c.label}</p>
                <p className={`text-[11.5px] leading-relaxed ${c.state === "block" ? "text-risk" : c.state === "warn" ? "text-amber-deep" : "text-ink-soft"}`}>{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* The confirmations, explained before they are requested */}
      <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
        <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">What your wallet will be asked to confirm</p>
        <ol className="mt-2 space-y-2">
          <Confirmation index={1} now title="Create the job">
            Gas only — opens the job. No USDC moves.
          </Confirmation>
          <Confirmation index={2} when="payment" title="Approve the USDC allowance">
            Lets the escrow take {price} USDC — an approval, not a transfer; moves nothing by itself.
          </Confirmation>
          <Confirmation index={3} when="payment" title="Fund the escrow">
            {price} USDC into the escrow for THIS job — this is the payment.
          </Confirmation>
        </ol>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          Releasing the escrow is your action — money settles only when you accept the deliverable.
        </p>
      </div>

      {createError && <ErrorNotice error={createError} />}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button type="button" onClick={onBack} disabled={busy !== null} className="btn-quiet order-2 w-full !min-h-9 sm:order-1 sm:w-auto">
          <ArrowLeft size={13} aria-hidden /> Edit request
        </button>
        <button
          type="button"
          onClick={onCreateJob}
          disabled={busy !== null || blocked || !networkOk || !walletAddress}
          className="btn-primary order-1 w-full !min-h-9 sm:order-2 sm:w-auto"
          title={blocked ? "Preflight is not clear yet — fix the blocked checks first." : undefined}
        >
          {busy === "create" ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
          {busy === "create" ? "Confirm in your wallet…" : `Create job — sign with your wallet`}
        </button>
      </div>
      {(blocked || !networkOk || !walletAddress) && busy === null && (
        <p className="text-[11.5px] text-ink-faint">
          Create stays disabled until the wallet is on Base and the blocked checks clear. {!networkOk ? "Switch the network above." : !walletAddress ? "Connect the buyer wallet." : "Resolve the blocked preflight items."}
        </p>
      )}
    </section>
  );
}

function Confirmation({ index, title, children, now, when }: { index: number; title: string; children: React.ReactNode; now?: boolean; when?: "payment" }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${now ? "border-teal bg-teal/10 text-teal" : "border-edge bg-panel-2 text-ink-faint"}`} aria-hidden>
        {index}
      </span>
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-ink">
          {title} <span className={`text-[10.5px] font-normal ${now ? "text-teal" : "text-ink-faint"}`}>{now ? "· this step" : "· at the payment step"}</span>
        </p>
        <p className="text-[11.5px] leading-relaxed text-ink-soft">{children}</p>
        {when === "payment" && null}
      </div>
    </li>
  );
}
