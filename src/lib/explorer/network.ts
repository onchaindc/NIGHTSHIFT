/**
 * Server-side data adapters for the public Telegraph Explorer.
 *
 * Everything here reads only the node's PUBLIC discovery endpoints (free
 * GETs, exactly the ones the existing paid-inference client already uses for
 * discovery):
 *
 *   GET /api/miners          — the miner catalog (rich records)
 *   GET /api/validators      — the registered validator set
 *   GET /engine/v1/intents   — the canonical intent registry
 *   POST /engine/v1/ask      — challenged without payment; the 402 challenge
 *                              itself is a free, observable network fact
 *                              (price, asset, network) used to document the
 *                              live payment contract.
 *
 * No key material, no private node-operator endpoints, no invented values:
 * every displayed field is a field the node actually returned.
 */

import { telegraphNodeUrl } from "@/lib/telegraph/client";

export interface EndpointDoc {
  path: string;
  method?: string;
  description?: string;
}

export interface MinerScore {
  intent_id?: string;
  epoch_id?: number;
  rank?: number;
  score?: number;
  scored_at?: string;
}

export interface MinerLimitation {
  code?: string;
  message?: string;
  param?: string;
  property?: string;
  value_num?: number;
  operator?: string;
}

/** The observed shape of the node's public miner catalog entries. */
export interface NetworkMiner {
  id: string;
  slug: string;
  kind: string;
  protocol: string;
  name: string;
  description?: string;
  endpoints: EndpointDoc[];
  input_schema: unknown;
  output_schema: unknown;
  supported_intents: string[];
  base_url: string;
  wallet_address: string;
  fee_address?: string;
  activation_status: string;
  min_price_usdc?: number;
  yaml_url?: string;
  registered_at?: string;
  scored?: boolean;
  last_scored_epoch?: number;
  last_scored_at?: string;
  scores?: MinerScore[];
  docs?: Record<string, string>;
  limitations?: MinerLimitation[];
  total_requests_served?: number;
}

/** The observed shape of the node's public validator registry. */
export interface NetworkValidator {
  address: string;
  peer_id: string;
  domain?: string;
  moniker: string;
  tokensMined?: string;
  transactionsSigned?: number;
  transactionsSubmitted?: number;
}

export interface NetworkIntent {
  intent_id: string;
  intent_name: string;
  miner_count: number;
  description?: string;
  canonical?: boolean;
}

export interface LiveChallengeOffer {
  amount: string;
  network: string;
  asset: string;
  assetName?: string;
  payTo: string;
  scheme: string;
  maxTimeoutSeconds?: number;
}

export type Outcome<T> = { status: "ok"; payload: T } | { status: "unavailable"; detail: string };

const NODE = () => telegraphNodeUrl();

const LONG_TTL = { next: { revalidate: 900 } } as const; // catalogs: 15 min
const LIVE_TTL = { next: { revalidate: 60 } } as const; // registries/badges: 1 min

async function getJson<T>(url: string, opts: { next: { revalidate: number } }): Promise<Outcome<T>> {
  try {
    const res = await fetch(url, { next: opts.next, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { status: "unavailable", detail: `node answered HTTP ${res.status} for ${new URL(url).pathname}` };
    return { status: "ok", payload: (await res.json()) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "unavailable", detail: msg.slice(0, 160) };
  }
}

/**
 * In-process memos for the two reads that dominated page latency. The miner
 * catalog is the largest read in the app (thousands of records) and was
 * refetched from the node on EVERY request; the live-offer probe adds a node
 * round trip to the front page and the node is known to be slow at times.
 *
 * Rules that keep the honesty invariant intact:
 *   only a SUCCESSFUL, non-empty read is memoized — an empty or failed
 *   response is never cached, so the old failure mode (an empty body rendering
 *   as a real "0 miners" catalog for the cache TTL) stays impossible — and a
 *   fresh read is attempted on every TTL expiry. If the node is unreachable,
 *   the last good payload is served rather than a dead page.
 */
const MINER_MEMO_TTL_MS = 60_000;
let minerMemo: { at: number; payload: NetworkMiner[] } | null = null;
let minerStale: NetworkMiner[] | null = null;

const OFFER_MEMO_TTL_MS = 30_000;
let offerMemo: { at: number; payload: LiveChallengeOffer } | null = null;
let offerStale: LiveChallengeOffer | null = null;

export async function fetchMiners(): Promise<Outcome<NetworkMiner[]>> {
  // Serve the memo inside its TTL — the node read is skipped entirely.
  if (minerMemo && Date.now() - minerMemo.at < MINER_MEMO_TTL_MS) {
    return { status: "ok", payload: minerMemo.payload };
  }
  // The catalog is large and changes independently of the intent registry. It
  // must never come from Next's data cache: an empty response cached during a
  // node deploy used to render as a real "0 miners" catalog for 15 minutes.
  // Retry once with an explicit no-store read before declaring it unavailable.
  let detail = "the miner catalog could not be read";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${NODE()}/api/miners`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        detail = `node answered HTTP ${res.status} for /api/miners`;
        continue;
      }
      const payload = (await res.json()) as unknown;
      // /api/miners is the miner registry. Keep a compatibility path for a
      // record without `kind`; filtering strictly to kind==="miner" turned a
      // shape change into a silent empty catalog.
      const miners = Array.isArray(payload)
        ? payload.filter((m): m is NetworkMiner => {
            if (!m || typeof m !== "object") return false;
            const miner = m as NetworkMiner;
            return miner.kind === "miner" || !("kind" in miner);
          })
        : [];
      if (miners.length === 0) {
        detail = "the node returned an empty miner catalog";
        continue;
      }
      minerMemo = { at: Date.now(), payload: miners };
      minerStale = miners;
      return { status: "ok", payload: miners };
    } catch (err) {
      detail = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    }
  }
  // The node is down or lying — the last good catalog is still the true
  // catalog, and a stale page beats a dead one for a discovery read.
  if (minerStale) return { status: "ok", payload: minerStale };
  return { status: "unavailable", detail };
}

export async function fetchValidators(): Promise<Outcome<NetworkValidator[]>> {
  const out = await getJson<{ validators?: unknown[] }>(`${NODE()}/api/validators`, LIVE_TTL);
  if (out.status === "ok") {
    const list = Array.isArray(out.payload.validators) ? (out.payload.validators as NetworkValidator[]) : [];
    return { status: "ok", payload: list };
  }
  return out;
}

export async function fetchIntents(): Promise<Outcome<NetworkIntent[]>> {
  const out = await getJson<{ intents?: unknown[] }>(`${NODE()}/engine/v1/intents`, LONG_TTL);
  if (out.status === "ok") {
    const list = Array.isArray(out.payload.intents) ? (out.payload.intents as NetworkIntent[]) : [];
    return { status: "ok", payload: list };
  }
  return out;
}

/**
 * One live x402 offer from a real, unpaid ask on the node. The 402 challenge
 * is observable without spending anything: it is the network's own payment
 * contract. Nothing is signed, nothing is charged.
 */
export async function fetchLiveOffer(): Promise<Outcome<LiveChallengeOffer>> {
  // A short memo: the challenge contract is stable (the node republishes the
  // same payTo/asset/amount for long stretches), and this read sits on the
  // front page's critical path. Only a well-formed offer is memoized.
  if (offerMemo && Date.now() - offerMemo.at < OFFER_MEMO_TTL_MS) {
    return { status: "ok", payload: offerMemo.payload };
  }
  try {
    const res = await fetch(`${NODE()}/engine/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Telegraph Network Explorer · what is this intent contract?" }),
      next: LIVE_TTL.next,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 402) {
      return offerStale
        ? { status: "ok", payload: offerStale }
        : { status: "unavailable", detail: `expected the node to challenge the ask (402), got HTTP ${res.status} — nothing was paid` };
    }
    const header = res.headers.get("payment-required");
    if (!header) return offerStale ? { status: "ok", payload: offerStale } : { status: "unavailable", detail: "the node challenged the ask without a PAYMENT-REQUIRED header" };
    const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: LiveChallengeOffer[] };
    const offer = (challenge.accepts ?? []).find((a) => a.scheme === "exact" && a.network?.startsWith("eip155:"));
    if (!offer) return offerStale ? { status: "ok", payload: offerStale } : { status: "unavailable", detail: "the live challenge carries no exact EVM entry to present" };
    const assetName = (offer as unknown as { extra?: { name?: string } }).extra?.name;
    const payload = { ...offer, assetName };
    offerMemo = { at: Date.now(), payload };
    offerStale = payload;
    return { status: "ok", payload };
  } catch (err) {
    if (offerStale) return { status: "ok", payload: offerStale };
    return { status: "unavailable", detail: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
}
