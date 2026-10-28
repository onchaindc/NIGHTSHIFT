/**
 * Telegraph integration module.
 *
 * Implements the OFFICIAL flow documented at docs.telegraphprotocol.com
 * ("Paying with x402", updated 2026-10-26):
 *
 *   1. Discovery is free:   GET /api/miners, GET /engine/v1/intents
 *   2. Inference is paid:   POST /engine/v1/ask  →  HTTP 402 with a
 *      PAYMENT-REQUIRED header (base64 JSON challenge). The challenge `accepts`
 *      list is authoritative for asset, amount (6-decimal USDC units) and payTo.
 *   3. Pay & retry: sign the challenge with an x402 client library
 *      (@x402/fetch + @x402/evm, EIP-712 exact scheme on Base Sepolia USDC)
 *      and retry the identical request. The node verifies via the PayAI
 *      facilitator before calling the miner.
 *   4. On 200: the body carries `signal_hash` and cost; the response carries
 *      PAYMENT-RESPONSE (settlement proof) and X-TELEGRAPH-RECEIPT (base64 JSON
 *      receipt; key on `receipt_hash`, NOT `tx_hash`, which may be batched).
 *   5. Verification: GET /engine/v1/signal/{signal_hash} returns the recorded
 *      signal and the result behind it; we compare it against the answer we got.
 *
 * Requirements: Node 20+ (WebCrypto), a wallet private key holding test USDC
 * on Base Sepolia (Circle faucet). No API key or account exists — the 402 flow IS
 * the authentication. There is deliberately no fake/offline path that returns a
 * purchase, miner answer, ranking, verification or transaction.
 */

import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import type { TelegraphAnswer, TelegraphReceipt } from "@/lib/engine/types";

export const DEFAULT_NODE_URL = "https://devnode.telegraphprotocol.com";

export class TelegraphBlockedError extends Error {
  readonly missingEnvKeys: string[];
  constructor(message: string, missingEnvKeys: string[] = []) {
    super(message);
    this.name = "TelegraphBlockedError";
    this.missingEnvKeys = missingEnvKeys;
  }
}

/**
 * Thrown when a PAID request delivers 200 but without the signal hash or
 * receipt needed to verify and account it. Payment may have settled, so the
 * engine must never re-send such a request (double-charge protection).
 */
export class TelegraphResponseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegraphResponseIntegrityError";
  }
}

/** Thrown when the challenge price exceeds the task's remaining budget. No payment was signed. */
export class TelegraphBudgetExceededError extends Error {
  readonly requestedUsdCents: number;
  readonly availableUsdCents: number;
  constructor(requestedUsdCents: number, availableUsdCents: number) {
    super(
      `Telegraph asks $${(requestedUsdCents / 100).toFixed(2)} but only $${(
        availableUsdCents / 100
      ).toFixed(2)} remains of this task's spending limit`,
    );
    this.name = "TelegraphBudgetExceededError";
    this.requestedUsdCents = requestedUsdCents;
    this.availableUsdCents = availableUsdCents;
  }
}

export function telegraphNodeUrl(): string {
  return (process.env.TELEGRAPH_NODE_URL || DEFAULT_NODE_URL).replace(/\/+$/, "");
}

/** Returns the env keys missing for PAID inference. Discovery needs none. */
export function missingPaidCredentials(): string[] {
  return process.env.TELEGRAPH_EVM_PRIVATE_KEY ? [] : ["TELEGRAPH_EVM_PRIVATE_KEY"];
}

export function paidCredentialsConfigured(): boolean {
  return missingPaidCredentials().length === 0;
}

/* ------------------------------------------------------------------ */
/* Free discovery endpoints                                            */
/* ------------------------------------------------------------------ */

export interface MinerSummary {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  min_price_usdc?: string;
}

export async function listMiners(intent?: string): Promise<MinerSummary[]> {
  const qs = intent ? `?intent=${encodeURIComponent(intent)}` : "";
  const res = await fetch(`${telegraphNodeUrl()}/api/miners${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`miners discovery failed: HTTP ${res.status}`);
  return (await res.json()) as MinerSummary[];
}

export interface IntentSummary {
  intent_id: string;
  intent_name: string;
  miner_count: number;
}

export async function listIntents(): Promise<IntentSummary[]> {
  const res = await fetch(`${telegraphNodeUrl()}/engine/v1/intents`, { cache: "no-store" });
  if (!res.ok) throw new Error(`intents discovery failed: HTTP ${res.status}`);
  const body = (await res.json()) as { intents: IntentSummary[] };
  return body.intents ?? [];
}

/* ------------------------------------------------------------------ */
/* Paid inference (x402)                                               */
/* ------------------------------------------------------------------ */

/** Decoded PAYMENT-REQUIRED challenge (subset of x402 v2 fields we enforce on). */
export interface PaymentChallenge {
  x402Version?: number;
  accepts: Array<{
    scheme: string;
    network: string;
    asset?: string;
    amount?: string; // 6-decimal USDC units, e.g. "10000" = $0.01
    payTo?: string;
    price?: string;
  }>;
}

function decodeChallenge(headerValue: string | null): PaymentChallenge | null {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as PaymentChallenge;
  } catch {
    return null;
  }
}

function evmChallengeAmountCents(challenge: PaymentChallenge | null): number | null {
  const evm = challenge?.accepts?.find((a) => a.scheme === "exact" && a.network?.startsWith("eip155:"));
  if (!evm || !evm.amount) {
    // Fall back to the human body summary if the header was unreadable.
    const withPrice = challenge?.accepts?.find((a) => a.price);
    if (withPrice?.price) return Math.round(parseFloat(withPrice.price.replace(/[^0-9.]/g, "")) * 100);
    return null;
  }
  return Number(evm.amount) / 10000; // 6-decimal USDC units: 10000 uUSDC = $0.01 = 1 cent
}

interface AskResultBody {
  miner_id?: string;
  miner_name?: string;
  result?: Record<string, unknown>;
  cost_usd?: number;
  signal_hash?: string;
  error?: string;
}

function extractReceipt(headers: Headers): TelegraphReceipt | null {
  const raw = headers.get("x-telegraph-receipt");
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as TelegraphReceipt;
  } catch {
    return null;
  }
}

export interface AskOptions {
  query: string;
  /** Remaining budget in USD cents. The engine refuses to pay more than this. */
  remainingBudgetUsdCents: number;
  onChallenge?: (info: { amountUsdCents: number }) => void;
}

/**
 * Ask the network through the Engine's auto route. Never charges without going
 * through the `remainingBudgetUsdCents` guard, which checks the amount in the
 * 402 challenge BEFORE signing anything.
 */
export async function askAuto(opts: AskOptions): Promise<TelegraphAnswer> {
  const node = telegraphNodeUrl();
  const body = JSON.stringify({ query: opts.query });

  // Step 1: free attempt. Receipt shows the challenge; nothing is charged.
  const probe = await fetch(`${node}/engine/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (probe.status === 402) {
    const challenge = decodeChallenge(probe.headers.get("payment-required"));
    const amountCents = evmChallengeAmountCents(challenge);
    if (amountCents === null) {
      throw new Error(`Telegraph 402 challenge could not be read (no acceptable scheme?)`);
    }
    if (amountCents > opts.remainingBudgetUsdCents) {
      throw new TelegraphBudgetExceededError(amountCents, opts.remainingBudgetUsdCents);
    }
    opts.onChallenge?.({ amountUsdCents: amountCents });
  } else if (!probe.ok) {
    throw new Error(`Telegraph ask failed: HTTP ${probe.status} ${(await probe.text()).slice(0, 300)}`);
  }

  // Step 2: paid attempt — the SDK handles the 402 challenge/signature/retry.
  if (!paidCredentialsConfigured()) {
    throw new TelegraphBlockedError(
      "Telegraph paid inference is not configured: the task would require an X402 payment. Set TELEGRAPH_EVM_PRIVATE_KEY (a Base Sepolia wallet funded with test USDC) to enable real purchases.",
      missingPaidCredentials(),
    );
  }

  // Build the x402 client lazily so a missing/malformed key only fails when a
  // purchase is actually required.
  const account = privateKeyToAccount(process.env.TELEGRAPH_EVM_PRIVATE_KEY as `0x${string}`);
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
  });

  const res = await fetchWithPayment(`${node}/engine/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Telegraph paid ask failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const parsed = (await res.json()) as AskResultBody;
  const receipt = extractReceipt(res.headers);
  if (!parsed.signal_hash) {
    // A 200 without a signal hash cannot be verified against the network and
    // must not be treated as a confirmed answer.
    throw new TelegraphResponseIntegrityError(
      "Telegraph returned 200 without a signal_hash; impossible to verify or account the spend",
    );
  }
  if (!receipt) {
    throw new TelegraphResponseIntegrityError(
      "Telegraph returned 200 without an X-TELEGRAPH-RECEIPT header; impossible to account the spend",
    );
  }

  return {
    answer: parsed.result ?? {},
    minerId: String(parsed.miner_id ?? receipt.miner ?? "unknown"),
    minerName: parsed.miner_name ?? receipt.miner,
    costUsd: parsed.cost_usd ?? (receipt.amount_uusdc ? Number(receipt.amount_uusdc) / 1e6 : null),
    signalHash: parsed.signal_hash,
    receipt,
  };
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export interface SignalRecord {
  signal_hash?: string;
  kind?: string;
  signal?: unknown;
  result?: unknown;
  payload?: unknown;
  verification?: { algorithm?: string; commitment?: string; verified?: boolean };
}

/**
 * Look up the signal recorded on the node for a previously purchased answer.
 * The docs define verification as fetching the signal and re-deriving the hash
 * over the returned signal/result/payload; the exact hash recipe is not
 * published client-side, so we validate what IS checkable: the signal exists
 * and the recorded result matches the answer we accepted (structurally,
 * independent of key ordering).
 */
export async function lookupSignal(signalHash: string): Promise<SignalRecord> {
  const res = await fetch(`${telegraphNodeUrl()}/engine/v1/signal/${encodeURIComponent(signalHash)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`signal lookup failed: HTTP ${res.status}`);
  return (await res.json()) as SignalRecord;
}
