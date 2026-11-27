/**
 * The Buyer Desk's journey, as pure functions — the stage machine the UI
 * renders, testable without a browser.
 *
 * The purchase journey (visible as the stepper):
 *
 *   Storefront → Configure → Review → Payment → Tracking → Deliverable
 *
 * Storefront/Configure/Review are desk stages; Payment, Tracking and
 * Deliverable are phases of a live ACP job (the stepper reads the job's
 * real phase: awaiting_payment lights Payment, processing lights Tracking,
 * review_delivery/completed light Deliverable).
 */

import type { AcpServiceOffering } from "./types";
import type { BuyerPhase } from "./buyer";

export type BuyerStage = "storefront" | "configure" | "review" | "tracking" | "history";

export const STAGE_ORDER: BuyerStage[] = ["storefront", "configure", "review", "tracking"];

/** The six journey steps, in order — the labels the stepper renders. */
export const JOURNEY_STEPS = ["Storefront", "Configure", "Review", "Payment", "Tracking", "Deliverable"] as const;

/**
 * Which journey step (1-6) is lit for a desk stage / live job phase.
 * Payment is lit from the moment a job needs funding; Deliverable from
 * delivery onward. Tracking is lit while the provider works.
 */
export function journeyStep(stage: BuyerStage, phase: BuyerPhase | null): number {
  if (stage === "storefront") return 1;
  if (stage === "configure") return 2;
  if (stage === "review") return 3;
  // stage === "tracking" | "history" — the job's real phase decides.
  switch (phase) {
    case "submitted":
    case "reading":
    case "rejected_intake":
      return 4; // the provider prices the job; the next journey step is payment
    case "awaiting_payment":
      return 4;
    case "processing":
    case "expired":
    case "failed":
    case "rejected":
      return 5;
    case "review_delivery":
    case "completed":
      return 6;
    default:
      return 5;
  }
}

/**
 * The required inputs still missing from a request — the gate between
 * stages. Empty means the stage may advance.
 */
export function missingRequired(offering: AcpServiceOffering, subject: Record<string, string>): string[] {
  return offering.inputs
    .filter((f) => f.required && !(subject[f.name] ?? "").trim())
    .map((f) => f.label);
}

/**
 * The buyer's sample values for one offering: ONLY keys the offering's
 * schema knows, every required field present. Samples are declared inputs,
 * never facts — they must be safe to submit.
 */
export function usableSamples(offering: AcpServiceOffering, samples: Record<string, string>): Record<string, string> {
  const known = new Set(offering.inputs.map((f) => f.name));
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(samples)) {
    if (known.has(key) && typeof value === "string" && value.trim() !== "") clean[key] = value;
  }
  for (const field of offering.inputs) {
    if (field.required && !(clean[field.name] ?? "").trim()) clean[field.name] = ""; // surfacing, not inventing
  }
  return clean;
}

/* ------------------------------------------------------------------ */
/* Preflight — the reads before any signature                          */
/* ------------------------------------------------------------------ */

export type PreflightState = "ok" | "warn" | "block";

export interface PreflightCheck {
  id: "wallet_chain" | "gas" | "usdc" | "allowance";
  label: string;
  state: PreflightState;
  detail: string;
}

/** Advisory gas floor: under this, three Base signatures may not be covered. */
export const MIN_GAS_WEI = 100_000_000_000_000n; // 0.0001 ETH

export function preflightChecks(input: {
  walletChainId: number | null;
  requiredChainId: number;
  gasWei: bigint | null;
  usdcBase: bigint | null;
  priceBase: bigint;
  allowanceBase: bigint | null;
}): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const { walletChainId, requiredChainId, gasWei, usdcBase, priceBase, allowanceBase } = input;

  if (walletChainId === null) {
    checks.push({ id: "wallet_chain", label: "Wallet network", state: "block", detail: "The wallet has not reported its network yet — signing stays blocked until Base is confirmed." });
  } else if (walletChainId === requiredChainId) {
    checks.push({ id: "wallet_chain", label: "Wallet network", state: "ok", detail: "Base (8453) — the chain NIGHTSHIFT's ACP jobs run on." });
  } else {
    checks.push({ id: "wallet_chain", label: "Wallet network", state: "block", detail: `The wallet is on chain ${walletChainId}. NIGHTSHIFT transactions only sign on Base (${requiredChainId}).` });
  }

  if (gasWei === null) {
    checks.push({ id: "gas", label: "Base ETH for gas", state: "warn", detail: "Not read yet — the wallet will confirm at signature time." });
  } else if (gasWei === 0n) {
    checks.push({ id: "gas", label: "Base ETH for gas", state: "block", detail: "The wallet holds no ETH on Base. Gas is paid in Base ETH; without it, signing is refused before any transaction is built." });
  } else if (gasWei < MIN_GAS_WEI) {
    checks.push({ id: "gas", label: "Base ETH for gas", state: "warn", detail: "Very low — this may not cover gas for all three signatures (job, allowance, funding)." });
  } else {
    checks.push({ id: "gas", label: "Base ETH for gas", state: "ok", detail: "Enough for the signatures this purchase needs." });
  }

  if (usdcBase === null) {
    checks.push({ id: "usdc", label: "USDC balance", state: "warn", detail: "Not read yet." });
  } else if (usdcBase < priceBase) {
    checks.push({ id: "usdc", label: "USDC balance", state: "block", detail: `The wallet's USDC on Base is below the ${formatUsdcShort(priceBase)} price. Nothing can be funded until it covers the price.` });
  } else {
    checks.push({ id: "usdc", label: "USDC balance", state: "ok", detail: `Covers the ${formatUsdcShort(priceBase)} price.` });
  }

  if (allowanceBase === null) {
    checks.push({ id: "allowance", label: "USDC permission", state: "warn", detail: "Not read yet — the payment step requests it when short." });
  } else if (allowanceBase < priceBase) {
    checks.push({ id: "allowance", label: "USDC permission", state: "ok", detail: `Short — the payment step will request an approval for ${formatUsdcShort(priceBase)} first. That is its own wallet confirmation.` });
  } else {
    checks.push({ id: "allowance", label: "USDC permission", state: "ok", detail: "The escrow can already take the price — no extra approval needed." });
  }
  return checks;
}

export function preflightBlocking(checks: PreflightCheck[]): boolean {
  return checks.some((c) => c.state === "block");
}

function formatUsdcShort(baseUnits: bigint): string {
  return `$${(Number(baseUnits) / 1_000_000).toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* Stalled-job view — waiting honestly, never pretending progress      */
/* ------------------------------------------------------------------ */

/** A job with no provider movement for this long tells the buyer so. */
const ACK_STALL_MINUTES = 15;
/** A funded investigation running this long names the approval gate. */
const PROCESSING_STALL_MINUTES = 120;

export interface StallView {
  /** Minutes since the job was created on-chain. */
  waitingMinutes: number;
  /** Minutes since the job last moved (provider record or creation). */
  sinceProgressMinutes: number;
  /** True when this phase's wait is unusually long and must be said so. */
  stalled: boolean;
  stallTitle: string | null;
  stallDetail: string | null;
  /** On-chain expiry: a countdown while open, past tense once expired. */
  expiryNote: string | null;
  expired: boolean;
}

/**
 * The buyer's honest view of a WAITING job. Never invents progress: "stalled"
 * here means only "this is taking unusually long, and here is what that
 * means" — always with the money-truth attached (nothing is at risk until
 * the buyer's own signature funds the escrow).
 */
export function stallView(input: {
  phase: BuyerPhase;
  createdAt: string;
  /** The provider record's last transition (its updatedAt); null when the
   *  provider has not acknowledged the job at all. */
  providerUpdatedAt: string | null;
  /** The on-chain expiry in epoch seconds (from the live job read or the
   *  buyer's creation record). null when unknown. */
  expiresAtSeconds: number | null;
  nowMs?: number;
}): StallView {
  const now = input.nowMs ?? Date.now();
  const createdMs = Date.parse(input.createdAt);
  const waitingMinutes = Number.isFinite(createdMs) ? Math.max(0, Math.floor((now - createdMs) / 60_000)) : 0;
  const progressMs = input.providerUpdatedAt ? Date.parse(input.providerUpdatedAt) : NaN;
  const lastProgress = Number.isFinite(progressMs) && Number.isFinite(createdMs) ? Math.max(progressMs, createdMs) : createdMs;
  const sinceProgressMinutes = Number.isFinite(createdMs) ? Math.max(0, Math.floor((now - lastProgress) / 60_000)) : waitingMinutes;

  let stalled = false;
  let stallTitle: string | null = null;
  let stallDetail: string | null = null;
  if (input.phase === "submitted" && sinceProgressMinutes > ACK_STALL_MINUTES) {
    stalled = true;
    stallTitle = `NIGHTSHIFT has not acknowledged this job for ${sinceProgressMinutes} minutes`;
    stallDetail =
      "The job exists on-chain and the requirement rides its description. The provider either prices it or refuses it at intake — nothing is at risk: the escrow is funded only by your own signature.";
  } else if (input.phase === "reading" && sinceProgressMinutes > ACK_STALL_MINUTES) {
    stalled = true;
    stallTitle = `The request has been with NIGHTSHIFT for ${sinceProgressMinutes} minutes without being priced`;
    stallDetail =
      "Pricing is the provider's on-chain acceptance act. Until it lands there is nothing to pay and nothing at risk. If this does not clear, contact support with the job id shown above.";
  } else if (input.phase === "processing" && sinceProgressMinutes > PROCESSING_STALL_MINUTES) {
    const hours = Math.floor(sinceProgressMinutes / 60);
    const minutes = sinceProgressMinutes % 60;
    stalled = true;
    stallTitle = `The investigation has been running for ${hours} h ${minutes} m`;
    stallDetail =
      "Paid runs park at NIGHTSHIFT's human approval gate before execution — a long wait here is usually that gate, not a failure. The escrow settles only when you accept the deliverable.";
  }

  let expiryNote: string | null = null;
  let expired = false;
  if (input.expiresAtSeconds !== null && input.expiresAtSeconds !== undefined && Number.isFinite(input.expiresAtSeconds)) {
    const remainingMs = input.expiresAtSeconds * 1000 - now;
    if (remainingMs <= 0) {
      expired = true;
      expiryNote = "The job expired on-chain. An unfunded job simply lapses; if you already funded the escrow, contact support with the job id — the escrow is accounted for on-chain.";
    } else {
      const totalMin = Math.floor(remainingMs / 60_000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      expiryNote = h > 0 ? `Job expires on-chain in ${h} h ${m} m — after expiry the escrow can no longer be funded.` : `Job expires on-chain in ${m} m — after expiry the escrow can no longer be funded.`;
    }
  }
  return { waitingMinutes, sinceProgressMinutes, stalled, stallTitle, stallDetail, expiryNote, expired };
}
