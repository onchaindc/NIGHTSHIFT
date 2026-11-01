/**
 * Telegraph integration module.
 *
 * Implements the OFFICIAL flow documented at anjoman.ai/docs/using/x402-inference
 * ("Pay per Request (x402)", updated 2026-11-01):
 *
 *   1. Discovery is free:   GET /api/miners, GET /engine/v1/intents
 *   2. Inference is paid:   POST /engine/v1/ask  →  HTTP 402 carrying
 *      PAYMENT-REQUIRED (base64 challenge). The CHALLENGE is authoritative for
 *      x402Version, accepts[].{scheme, network, asset, amount (6-decimal USDC
 *      units), payTo, maxTimeoutSeconds, extra {name, version}}. The response
 *      BODY is only a human summary (a bare price, no asset or amount) and must
 *      never be the basis of a payment. Network eip155:11155111 (Ethereum
 *      Sepolia); the asset is the Telegraph test token, which is NOT one of
 *      the x402 library's built-in default assets.
 *   3. Pay & retry: sign the challenge with the x402 client library
 *      (@x402/fetch + @x402/evm, EIP-712 exact scheme) and retry the identical
 *      request with PAYMENT-SIGNATURE. The node verifies via its facilitator
 *      before calling the miner. The node may also offer scheme "escrow"
 *      (Telegraph escrow balance); the installed @x402/* client has no escrow
 *      scheme network client, so we explicitly select the exact scheme only.
 *   4. On 200: the body carries `signal_hash` and cost; the response carries
 *      PAYMENT-RESPONSE (settlement proof) and X-TELEGRAPH-RECEIPT (base64 JSON
 *      receipt; key on `receipt_hash`, NOT `tx_hash`, which may be batched).
 *   5. Verification: GET /engine/v1/signal/{signal_hash} returns the recorded
 *      signal and the result behind it; we compare it against the answer we got.
 *
 * Requirements: Node 20+ (WebCrypto), a wallet private key whose address holds
 * the Telegraph test token ON ETHEREUM SEPOLIA (mint per the documented test
 * token in the node's challenge). A key without that balance produces a bare
 * 402 at verify time: nothing settles and the request is not re-sent. No API
 * key or account exists — the 402 flow IS the authentication. There is
 * deliberately no fake/offline path that returns a purchase, miner answer,
 * ranking, verification or transaction.
 */

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
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

/** One accepted payment option from the node's x402 v2 challenge. */
export interface TelegraphChallengeAccept {
  scheme: string;
  network: string;
  asset?: string;
  amount?: string; // 6-decimal USDC units, e.g. "10000" = $0.01
  price?: string; // body summaries only; NOT sufficient to sign
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** Decoded PAYMENT-REQUIRED challenge. The header version is the authoritative contract. */
export interface TelegraphChallenge {
  x402Version?: number;
  error?: string;
  resource?: Record<string, unknown>;
  accepts: TelegraphChallengeAccept[];
}

function decodeChallenge(headerValue: string | null): TelegraphChallenge | null {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as TelegraphChallenge;
  } catch {
    return null;
  }
}

/**
 * The one priceable, signable EVM offer in a challenge: the exact-scheme
 * EIP-155 entry with an amount we can budget against. Telegraph's second
 * option (scheme "escrow" against its escrow balance on-chain) is NOT
 * supported by the installed @x402/* client, so only exact entries qualify.
 */
export function exactEvmOffer(a:
  | TelegraphChallenge
  | null): { scheme: string; network: string; asset?: string; payTo?: string; amountCents: number } | null {
  const evm = a?.accepts?.find((x) => x.scheme === "exact" && x.network?.startsWith("eip155:"));
  if (!evm) { return null; }
  let amountCents: number | null = null;
  if (evm.amount) {
    amountCents = Number(evm.amount) / 10000; // 6-decimal USDC units: 10000 uUSDC = $0.01 = 1 cent
  } else if (evm.price) {
    const parsed = parseFloat(evm.price.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed)) { amountCents = Math.round(parsed * 100); }
  }
  if (amountCents === null || !Number.isFinite(amountCents)) { return null; }
  return { scheme: evm.scheme, network: evm.network, asset: evm.asset, payTo: evm.payTo, amountCents };
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
  /** Fired once, with the offer the engine itself priced from the live challenge. */
  onChallenge?: (info: {
    amountUsdCents: number;
    scheme: string;
    network: string;
    asset?: string;
    payTo?: string;
  }) => void;
}

/**
 * Explicit payment-requirement selector. Telegraph's challenge is the
 * authority for network/asset/payTo, but never for our budget: even after
 * scheme, flow and spendControls filtering, the chosen requirement MUST still
 * be the exact scheme's EIP-155 entry that we ourselves priced, and its amount
 * MUST still fit this task's remaining budget. Unrecognized options (the
 * node's scheme "escrow" offer) are refused here, never signed.
 */
function selectTelegraphRequirement(
  accepts: Array<{ scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string; price?: string; extra?: Record<string, unknown> }>,
  offer: { network: string; asset?: string; payTo?: string; amountCents: number },
  remainingBudgetUsdCents: number,
): unknown /* x402 PaymentRequirements entry, returned as selected by the core client */ {
  const supported = accepts.filter((a) => a.scheme === "exact" && typeof a.network === "string" && a.network.startsWith("eip155:"));
  if (supported.length === 0) {
    // Preserve the structure in the message; never attempt an unsupported option.
    throw new Error(
      `Telegraph offered no signable exact-payment option (schemes: ${accepts.map((a) => a.scheme).join(", ")}); refusing to pay through an unimplemented rail`,
    );
  }
  const matches = (a: { network?: string; asset?: string; payTo?: string }) =>
    a.network === offer.network &&
    (!offer.asset || a.asset?.toLowerCase() === offer.asset.toLowerCase()) &&
    (!offer.payTo || a.payTo?.toLowerCase() === offer.payTo.toLowerCase());
  const chosen = supported.find(matches) ?? supported[0];
  if (!matches(chosen)) {
    throw new Error(
      `Telegraph's live challenge drifted from the offer the engine priced (network ${offer.network}, asset ${offer.asset}); refusing to sign an unvetted requirement`,
    );
  }
  // Budget ceiling, checked against the LIVE challenge amount (the network may
  // have re-priced between our probe and this signature). Suffix "¢", never a
  // dollar rounding, so the refused amount stays exact.
  const atomic = chosen.amount;
  if (!atomic || !/^\d+$/.test(atomic)) {
    throw new Error(`Telegraph's challenge carries no exact amount to sign (no atomic amount in the accepted entry)`);
  }
  const cents = Number(atomic) / 10000; // 6-decimal USDC units; 10000 uUSDC = 1 cent
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new Error(`Telegraph's challenge carries an unusable amount (${atomic} atomic units)`);
  }
  if (Math.round(cents) > remainingBudgetUsdCents) {
    throw new TelegraphBudgetExceededError(Math.round(cents), remainingBudgetUsdCents);
  }
  return chosen;
}

/*
 * Best-effort payer funding diagnostic for the documented bare-402 case:
 * a payload that does not verify gets a bare 402 "indistinguishable from
 * having sent no payment at all". The most common verify failure is a payer
 * with no balance of the challenge's token on that chain, so we read the
 * PUBLIC chain (eth_call balanceOf, no keys, no credentials) and name the
 * gap instead of leaving a bare 402 for the operator to decode.
 */
let balanceProbeForTests: ((payer: string, asset: string, network: string) => Promise<string | null>) | null = null;

/** Test hook; production always uses the public JSON-RPC read below. */
export function setTelegraphBalanceProbeForTests(fn: ((payer: string, asset: string, network: string) => Promise<string | null>) | null): void {
  balanceProbeForTests = fn;
}

async function diagnosePaymentRejection(payer: string, challenge: TelegraphChallenge | null): Promise<string> {
  const exact = challenge?.accepts?.find((a) => a.scheme === "exact" && a.network?.startsWith("eip155:") && a.asset);
  if (!exact?.asset || !exact.network) {
    return "The fresh challenge carries no exact EVM entry to diagnose against.";
  }
  try {
    const balance = balanceProbeForTests
      ? await balanceProbeForTests(payer, exact.asset, exact.network)
      : await tokenBalanceViaPublicRpc(payer, exact.asset, exact.network);
    if (balance === null) {
      return "A public chain read could not confirm the payer balance; the funding of the paid-research wallet for this token and chain is the first thing to verify (the challenge asset is NOT one of the x402 library's built-in default tokens).";
    }
    return `Public chain read: payer ${payer} holds ${balance} of the challenge asset ${exact.asset} on ${exact.network}, which must cover the signed transfer.`;
  } catch {
    return "A public chain read of the payer balance failed; verify the paid-research wallet holds the challenge asset on that chain.";
  }
}

async function tokenBalanceViaPublicRpc(payer: string, asset: string, network: string): Promise<string | null> {
  if (network !== "eip155:11155111") {
    return null; // public RPC snippet below is Sepolia-configured by the docs
  }
  // balanceOf(address) — public reads only; no key material is read or logged.
  const data = `0x70a08231${payer.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  const rpcUrl = process.env.TELEGRAPH_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: asset, data }, "latest"] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) { return null; }
  const body = (await res.json()) as { result?: string };
  if (!body.result || body.result === "0x") { return null; }
  const raw = BigInt(body.result);
  return `${raw / 1000000n} whole units (6 decimals; ${raw} atomic)`;
}

/**
 * Ask the network through the Engine's auto route. Never charges without going
 * through the `remainingBudgetUsdCents` guard, which checks the amount in the
 * 402 challenge BEFORE signing anything.
 */
export async function askAuto(opts: AskOptions): Promise<TelegraphAnswer> {
  const node = telegraphNodeUrl();
  const body = JSON.stringify({ query: opts.query });
  // The offer we priced ourselves anchors the paying client: its spend
  // allowlist is exactly this asset, and every live requirement must still
  // fit this budget before a signature exists.
  let probedOffer: { network: string; asset?: string; payTo?: string; amountCents: number } | null = null;

  // Step 1: free attempt. Receipt shows the challenge; nothing is charged.
  const probe = await fetch(`${node}/engine/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (probe.status === 402) {
    const challenge = decodeChallenge(probe.headers.get("payment-required"));
    if (!challenge) {
      throw new Error(`Telegraph 402 challenge could not be read (PAYMENT-REQUIRED header missing or not base64 JSON). The response body's accepts summary is a bare price and carries no asset or amount, so it cannot be paid on.`);
    }
    const offer = exactEvmOffer(challenge);
    if (!offer) {
      throw new Error(`Telegraph 402 challenge contains no priceable exact-scheme EVM option (accepted schemes: ${challenge.accepts?.map((a) => a.scheme).join(", ")})`);
    }
    if (!offer.asset || !offer.payTo) {
      throw new Error(`Telegraph 402 challenge is incomplete: the accepted exact entry must carry an asset to sign against and a payTo recipient (this deliberately fails rather than guessing)`);
    }
    if (offer.amountCents > opts.remainingBudgetUsdCents) {
      throw new TelegraphBudgetExceededError(offer.amountCents, opts.remainingBudgetUsdCents);
    }
    opts.onChallenge?.({ amountUsdCents: offer.amountCents, scheme: offer.scheme, network: offer.network, asset: offer.asset, payTo: offer.payTo });
    probedOffer = offer;
  } else if (!probe.ok) {
    throw new Error(`Telegraph ask failed: HTTP ${probe.status} ${(await probe.text()).slice(0, 300)}`);
  }

  // Step 2: paid attempt — the SDK handles the 402 challenge/signature/retry.
  if (!paidCredentialsConfigured()) {
    throw new TelegraphBlockedError(
      "Telegraph paid inference is not configured: the task would require an X402 payment. Set TELEGRAPH_EVM_PRIVATE_KEY to a wallet on the challenge's chain (Ethereum Sepolia, eip155:11155111 on the current network) holding the network's test token, to enable real purchases.",
      missingPaidCredentials(),
    );
  }

  // Build the x402 client lazily so a missing/malformed key only fails when a
  // purchase is actually required. It is registered for the exact network
  // string the challenge used, so nothing else can be selected.
  const account = privateKeyToAccount(process.env.TELEGRAPH_EVM_PRIVATE_KEY as `0x${string}`);
  const offer = probedOffer!;
  const paymentNetwork = offer.network as `${string}:${string}`;
  const client = x402Client.fromConfig({
    schemes: [{ network: paymentNetwork, client: new ExactEvmScheme(account) }],
    // Allow exactly the asset the challenge priced. The node's token is not a
    // built-in default of the payer's library, so without this entry every
    // requirement is rejected by spendControls before any signature exists.
    // Arbitrary assets stay refused: the allowlist mirrors our priced offer.
    spendControls: { allowedAssets: [{ network: paymentNetwork, asset: offer.asset! }] },
    paymentRequirementsSelector: (_version, accepts) =>
      selectTelegraphRequirement(accepts as never, offer, opts.remainingBudgetUsdCents) as never,
  });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  let res: Response;
  try {
    res = await fetchWithPayment(`${node}/engine/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    // Challenge-level refusals (budget, drift, unvetted requirement) and
    // build-level failures are distinguished here; nothing was signed when the
    // selector itself refused.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Failed to create payment payload")) {
      // Restore the typed budget error so the engine's budget handling (and
      // any /exceed/i classification) still routes it as a spend refusal.
      const wrapped = msg.match(/Telegraph asks \$([\d.]+) but only \$([\d.]+)/);
      if (wrapped) {
        throw new TelegraphBudgetExceededError(Math.round(parseFloat(wrapped[1]) * 100), Math.round(parseFloat(wrapped[2]) * 100));
      }
      throw new Error(`Telegraph refused the payment itself before anything was signed: ${msg}`);
    }
    throw err;
  }

  if (res.status === 402) {
    // The signed payload did not verify. This is NOT an ambiguous settlement:
    // x402 verify strictly precedes settle, so nothing moved on chain. Do NOT
    // re-send: a fresh signature would authorize the same payment again.
    const fresh = decodeChallenge(res.headers.get("payment-required"));
    const diagnostic = await diagnosePaymentRejection(account.address, fresh);
    throw new Error(
      `Telegraph returned a bare 402 to the signed payment (the payload did not verify). Nothing settled on chain and the request was not re-sent to avoid duplicate authorization. ${diagnostic}`,
    );
  }

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
