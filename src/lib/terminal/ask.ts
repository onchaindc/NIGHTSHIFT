/**
 * Interactive Terminal request layer (Phase 2).
 *
 * Reuses the engine's x402 client machinery from `@/lib/telegraph/client`
 * (challenge decoding, exact-scheme offer pricing/selection, receipt
 * extraction, payment-rejection diagnostics) — nothing about the payment
 * rail is duplicated. What this module adds is the human-facing sequence the
 * Terminal needs:
 *
 *   probe   — the UNPAID pre-flight: POST the exact body the user assembled
 *             (guided {intent, params} / {query}, or an advanced/JSON body,
 *             optionally to /engine/v1/ask/{miner}) and read what the node
 *             answers before any payment exists. The node validates input and
 *             routing BEFORE charging, so this is real validation for free;
 *             a valid request returns the live 402 challenge.
 *   execute — only with an explicit user approval that pins an exact offer
 *             (network + asset + payTo + atomic amount). Before signing, the
 *             live challenge is re-fetched and must match the approved offer
 *             field for field; any drift refuses with the fresh offer and
 *             nothing is signed. On success the response carries the answer,
 *             signal hash, settlement proof and the Telegraph receipt.
 *   verify  — GET /engine/v1/signal/{hash} plus the documented re-derivation
 *             of the signal hash (keccak over the payload, compact JSON with
 *             sorted keys, wallet_address lower-cased, < > & escaped). Only a
 *             re-derived match is reported as verified.
 */

import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import {
  decodeChallenge,
  diagnosePaymentRejection,
  exactEvmOffer,
  extractReceipt,
  paidCredentialsConfigured,
  selectTelegraphRequirement,
  telegraphNodeUrl,
  type TelegraphChallenge,
  type TelegraphChallengeAccept,
} from "@/lib/telegraph/client";
import type { TelegraphReceipt } from "@/lib/engine/types";

/** The exact, priceable contract one request will settle under. */
export interface ApprovedOffer {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string; // atomic 6-decimal USDC units, exactly as challenged
}

export type ProbeOutcome =
  | {
      kind: "challenge";
      challenge: TelegraphChallenge;
      /** The offer exactly as the user will see/approve it. */
      approvedOffer: ApprovedOffer;
      /** The internally priced offer for the pay client's requirement selector. */
      pricedOffer: { network: string; asset: string; payTo: string; amountCents: number };
      referencedUrl: string;
    }
  | { kind: "rejected"; status: number; body: Record<string, unknown> | null; text: string }
  | { kind: "unavailable"; detail: string };

/** The exact body the node will be paid to answer, assembled per request mode. */
export interface AskRequestSpec {
  /** Guided/canonical: the intent's canonical name (e.g. WEATHER_CHECK_TEMPERATURE). */
  intent?: string;
  /** Guided/canonical: typed params matching the intent's input schema. */
  params?: Record<string, unknown>;
  /** Guided fallback when the intent carries no input schema: free question. */
  query?: string;
  /** Direct mode: pin the chosen miner by id or slug (/engine/v1/ask/{miner}). */
  minerId?: string;
  /** Advanced mode: a fully user-supplied JSON body (validated structurally). */
  rawBody?: unknown;
}

/** Structural validation of what the terminal may actually send. No invented rules. */
export function assembleAskBody(spec: AskRequestSpec): { body: unknown; urlPath: string } | { error: string } {
  if (spec.rawBody !== undefined) {
    if (spec.intent || spec.params || spec.query) {
      return { error: "Choose one form: either advanced JSON or the guided fields, not both." };
    }
    if (typeof spec.rawBody !== "object" || spec.rawBody === null || Array.isArray(spec.rawBody)) {
      return { error: "The request body must be a JSON object." };
    }
    const b = spec.rawBody as Record<string, unknown>;
    const hasQuery = typeof b.query === "string" && b.query.trim().length > 0;
    const hasCanonical = typeof b.intent === "string" && b.intent.length > 0 && typeof b.params === "object" && b.params !== null;
    if (!hasQuery && !hasCanonical) {
      return { error: 'The body must carry a non-empty "query", or "intent" together with "params".' };
    }
    return { body: b, urlPath: askPath(spec.minerId) };
  }

  const urlPath = askPath(spec.minerId);
  if (spec.intent !== undefined && spec.params !== undefined) {
    return { body: { intent: spec.intent, params: spec.params }, urlPath };
  }
  if (typeof spec.query === "string" && spec.query.trim().length > 0) {
    return { body: { query: spec.query.trim() }, urlPath };
  }
  return { error: 'Assemble the request first: an intent with params, or a non-empty "query".' };
}

function askPath(minerId?: string): string {
  return minerId && minerId.trim().length > 0 ? `/engine/v1/ask/${encodeURIComponent(minerId.trim())}` : "/engine/v1/ask";
}

/**
 * The UNPAID pre-flight. The node refuses invalid bodies BEFORE payment
 * (docs: 400/404/429/503 arrive without any charge), and a valid body answers
 * with the live 402 challenge. Nothing is signed here — ever.
 */
export async function probeAsk(spec: AskRequestSpec): Promise<ProbeOutcome> {
  const assembled = assembleAskBody(spec);
  if ("error" in assembled) {
    return { kind: "rejected", status: 0, body: { error: assembled.error } as Record<string, unknown>, text: assembled.error };
  }
  const { body, urlPath } = assembled;
  const node = telegraphNodeUrl();
  try {
    const res = await fetch(`${node}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 402) {
      const challenge = decodeChallenge(res.headers.get("payment-required"));
      const accepted = challenge?.accepts?.find((a) => a.scheme === "exact" && a.network?.startsWith("eip155:"));
      const priced = exactEvmOffer(challenge);
      if (!challenge || !priced || !accepted?.asset || !accepted.payTo || !accepted.amount || !/^\d+$/.test(accepted.amount)) {
        return {
          kind: "unavailable",
          detail: "The node challenged this request, but the challenge carries no complete signable exact-scheme EVM entry (needs asset, payTo and an atomic amount).",
        };
      }
      return {
        kind: "challenge",
        challenge,
        approvedOffer: { scheme: priced.scheme, network: priced.network, asset: accepted.asset, payTo: accepted.payTo, amount: accepted.amount },
        pricedOffer: { network: priced.network, asset: priced.asset!, payTo: priced.payTo!, amountCents: priced.amountCents },
        referencedUrl: `${node}${urlPath}`,
      };
    }
    // The node's own pre-payment verdict, surfaced as-is.
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON refusal body */
    }
    if (parsed) {
      return { kind: "rejected", status: res.status, body: parsed, text: JSON.stringify(parsed).slice(0, 500) };
    }
    return { kind: "rejected", status: res.status, body: null, text: (await res.text().catch(() => "")).slice(0, 500) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(msg) || /abort/i.test(msg)) {
      return { kind: "unavailable", detail: "The node did not answer the pre-flight probe in time. Try again shortly." };
    }
    return { kind: "unavailable", detail: `The node could not be reached for the pre-flight probe: ${msg.slice(0, 200)}` };
  }
}

/** Does the live challenge still spell the exact contract the user approved? */
export function approvedOfferMatches(
  approved: ApprovedOffer,
  live: { network: string; asset?: string; payTo?: string; amount?: string },
): { ok: boolean; reason?: string } {
  if (approved.network !== live.network) return { ok: false, reason: `network changed (approved ${approved.network}, live ${live.network})` };
  if (approved.payTo && live.payTo && approved.payTo.toLowerCase() !== live.payTo.toLowerCase()) {
    return { ok: false, reason: `the recipient changed (approved ${approved.payTo}, live ${live.payTo})` };
  }
  if (approved.asset && live.asset && approved.asset.toLowerCase() !== live.asset.toLowerCase()) {
    return { ok: false, reason: `the asset changed (approved ${approved.asset}, live ${live.asset})` };
  }
  if (approved.amount && live.amount && approved.amount !== live.amount) {
    return { ok: false, reason: `the price changed (approved ${approved.amount} atomic units, live ${live.amount})` };
  }
  return { ok: true };
}

/** The configured payer's public address (never any key material). */
export function payerAddress(): string | null {
  if (!paidCredentialsConfigured()) return null;
  try {
    return privateKeyToAccount(process.env.TELEGRAPH_EVM_PRIVATE_KEY as `0x${string}`).address;
  } catch {
    return null;
  }
}

export interface ExecuteInput {
  spec: AskRequestSpec;
  /** The offer the user explicitly approved. Execution refuses without it. */
  approved: true;
  approvedOffer: ApprovedOffer;
}

export type ExecuteOutcome =
  | {
      kind: "answered";
      urlPath: string;
      requestSent: unknown;
      offer: ApprovedOffer;
      result: unknown;
      resultShape?: string;
      shapeError?: string;
      fieldStatus?: Record<string, unknown>;
      minerId?: string;
      minerName?: string;
      endpoint?: string;
      intent?: string;
      input?: unknown;
      costUsd?: number;
      durationMs?: number;
      timestamp?: string;
      warnings?: unknown;
      signalHash: string;
      receipt: TelegraphReceipt;
      settlementHeader?: string;
    }
  | { kind: "refused"; reason: string; fresh?: ProbeOutcome }
  | { kind: "unpaid_rejected"; status: number; body: Record<string, unknown> | null }
  | { kind: "payment_rejected"; detail: string }
  | { kind: "failed"; status?: number; detail: string }
  | { kind: "integrity"; detail: string };

/**
 * The paid attempt. Requires `approved: true` AND an approval whose fields
 * still match the LIVE challenge — a fresh unpaid probe re-reads it first, so
 * a drifted price/recipient/network can never be signed silently.
 */
export async function executeAsk(input: ExecuteInput): Promise<ExecuteOutcome> {
  if (input.approved !== true) {
    return { kind: "refused", reason: "Execution requires an explicit user approval that was never given." };
  }
  if (!paidCredentialsConfigured()) {
    return { kind: "refused", reason: "No payer wallet is configured on this deployment (TELEGRAPH_EVM_PRIVATE_KEY missing); nothing can be signed." };
  }

  const assembled = assembleAskBody(input.spec);
  if ("error" in assembled) return { kind: "refused", reason: assembled.error };
  const { body, urlPath } = assembled;

  const fresh = await probeAsk(input.spec);
  if (fresh.kind === "challenge") {
    const match = approvedOfferMatches(input.approvedOffer, {
      network: fresh.approvedOffer.network,
      asset: fresh.approvedOffer.asset,
      payTo: fresh.approvedOffer.payTo,
      amount: fresh.approvedOffer.amount,
    });
    if (!match.ok) {
      return { kind: "refused", reason: `The live challenge drifted from what was approved (${match.reason}). Nothing was signed; review and approve the fresh offer to continue.`, fresh };
    }
  } else if (fresh.kind === "rejected") {
    return { kind: "unpaid_rejected", status: fresh.status, body: fresh.body };
  } else {
    return { kind: "refused", reason: `The pre-flight probe failed before anything was paid: ${fresh.detail}`, fresh };
  }

  const node = telegraphNodeUrl();
  const account = privateKeyToAccount(process.env.TELEGRAPH_EVM_PRIVATE_KEY as `0x${string}`);
  const priced = fresh.pricedOffer;
  const paymentNetwork = priced.network as `${string}:${string}`;
  const client = x402Client.fromConfig({
    schemes: [{ network: paymentNetwork, client: new ExactEvmScheme(account) }],
    spendControls: { allowedAssets: [{ network: paymentNetwork, asset: priced.asset }] },
    // The human approved exactly this offer and the fresh challenge was
    // drift-checked against it above, so the budget ceiling is not re-derived
    // here; the selector still pins the signed requirement to the priced entry.
    paymentRequirementsSelector: (_version, accepts) =>
      selectTelegraphRequirement(
        accepts as never,
        { network: priced.network, asset: priced.asset, payTo: priced.payTo, amountCents: priced.amountCents },
        Number.POSITIVE_INFINITY,
      ) as never,
  });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  let res: Response;
  try {
    res = await fetchWithPayment(`${node}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "failed", detail: `The paid request could not be completed: ${msg.slice(0, 300)}` };
  }

  if (res.status === 402) {
    // Bare 402 to a signed payload: the payload did not verify. x402 verifies
    // strictly before settle, so nothing moved on chain. Do NOT re-send.
    const freshChallenge = decodeChallenge(res.headers.get("payment-required"));
    const diagnostic = await diagnosePaymentRejection(account.address, freshChallenge);
    return { kind: "payment_rejected", detail: `The network rejected the signed payment (bare 402; the payload did not verify). Nothing settled and the request was not re-tried. ${diagnostic}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { kind: "failed", status: res.status, detail: `The paid request failed after settlement may have begun: HTTP ${res.status} ${text.slice(0, 300)}` };
  }

  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const receipt = extractReceipt(res.headers);
  const signalHash = typeof parsed?.signal_hash === "string" ? parsed.signal_hash : null;
  if (!signalHash) {
    return {
      kind: "integrity",
      detail: receipt
        ? "HTTP 200, but the body carries no signal_hash: the answer cannot be reconciled against the network, so it is NOT presented as a confirmed result."
        : "HTTP 200 without a signal_hash and without an X-TELEGRAPH-RECEIPT: the spend cannot be accounted, so it is NOT presented as a confirmed result.",
    };
  }
  if (!receipt) {
    return { kind: "integrity", detail: "HTTP 200 with a signal hash, but the X-TELEGRAPH-RECEIPT header is missing: the spend cannot be accounted, so it is NOT presented as a confirmed result." };
  }

  return {
    kind: "answered",
    urlPath,
    requestSent: body,
    offer: input.approvedOffer,
    result: parsed?.result ?? null,
    resultShape: typeof parsed?.result_shape === "string" ? parsed.result_shape : undefined,
    shapeError: typeof parsed?.shape_error === "string" ? parsed.shape_error : undefined,
    fieldStatus: (parsed?.field_status as Record<string, unknown> | undefined) ?? undefined,
    minerId: parsed?.miner_id != null ? String(parsed.miner_id) : undefined,
    minerName: typeof parsed?.miner_name === "string" ? parsed.miner_name : undefined,
    endpoint: typeof parsed?.endpoint === "string" ? parsed.endpoint : undefined,
    intent: typeof parsed?.intent === "string" ? parsed.intent : undefined,
    input: parsed?.input,
    costUsd: typeof parsed?.cost_usd === "number" ? parsed.cost_usd : undefined,
    durationMs: typeof parsed?.duration_ms === "number" ? parsed.duration_ms : undefined,
    timestamp: typeof parsed?.timestamp === "string" ? parsed.timestamp : undefined,
    warnings: parsed?.warnings,
    signalHash,
    receipt,
    settlementHeader: res.headers.get("payment-response") ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Verification: the documented keccak re-derivation                   */
/* ------------------------------------------------------------------ */

export type VerifyOutcome =
  | { kind: "verified"; signalHash: string; record: unknown; note: string }
  | { kind: "recorded"; signalHash: string; record: unknown; note: string }
  | { kind: "unverified"; detail: string };

function canonicalSignalPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const compact = JSON.stringify(sortKeys(payload));
  if (compact === undefined) return null;
  // The node's recipe: wallet_address participates lower-case; <, > and & are
  // escaped as unicode escapes, in that spirit — matching `jq`'s sed corner.
  const lowered = /"wallet_address"\s*:\s*"([0-9a-fA-FxX]+)"/.exec(compact);
  const withWallet = lowered ? compact.replace(lowered[0], `"wallet_address":"${lowered[1].toLowerCase()}"`) : compact;
  return withWallet.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/**
 * The answer the user accepted is checked, not assumed: the recorded signal
 * must exist AND its payload must re-derive the exact signal hash (keccak
 * over the canonically-serialized payload, per the node's docs). Only a
 * re-derived match is reported as fully verified.
 */
export async function verifySignal(signalHash: string): Promise<VerifyOutcome> {
  const node = telegraphNodeUrl();
  let record: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${node}/engine/v1/signal/${encodeURIComponent(signalHash)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { kind: "unverified", detail: `The signal registry answered HTTP ${res.status} — this call is not recorded there yet. A settlement usually appears within minutes; nothing is claimed verified until it does.` };
    }
    record = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { kind: "unverified", detail: `The signal lookup failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
  }

  const verification = record?.verification as { verified?: boolean } | null | undefined;
  const nodeVerified = verification?.verified === true;
  const canonical = canonicalSignalPayload(record?.payload);
  if (canonical) {
    const derived = keccak256(toHex(canonical));
    if (derived.toLowerCase() === signalHash.toLowerCase()) {
      return { kind: "verified", signalHash, record, note: nodeVerified ? "Independent re-derivation matches: keccak256 over the recorded payload equals the signal hash, and the node's own verified flag is true." : "Independent re-derivation matches: the recorded payload is exactly the one this signal hash commits to." };
    }
    return { kind: "recorded", signalHash, record, note: `The signal is recorded, but re-deriving the hash over the recorded payload gave ${derived}, which does not match. The node's own verified flag: ${nodeVerified ? "true" : "false"}.` };
  }
  if (nodeVerified) {
    return { kind: "recorded", signalHash, record, note: "The node reports verification.verified = true, but the payload could not be re-serialized here for an independent re-derivation, so treat this as the network's word, not proof." };
  }
  return { kind: "recorded", signalHash, record, note: "The signal is recorded, but neither the node's verified flag nor an independent re-derivation confirms it. Treat as unconfirmed." };
}
