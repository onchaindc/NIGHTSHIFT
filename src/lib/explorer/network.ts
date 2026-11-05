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

export async function fetchMiners(): Promise<Outcome<NetworkMiner[]>> {
  const out = await getJson<NetworkMiner[]>(`${NODE()}/api/miners`, LONG_TTL);
  if (out.status === "ok") {
    if (!Array.isArray(out.payload)) return { status: "unavailable", detail: "miner catalog returned a non-array body" };
    const miners = out.payload.filter((m) => m && m.kind === "miner");
    return { status: "ok", payload: miners };
  }
  return out;
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
  try {
    const res = await fetch(`${NODE()}/engine/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Telegraph Network Explorer · what is this intent contract?" }),
      next: LIVE_TTL.next,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 402) {
      return { status: "unavailable", detail: `expected the node to challenge the ask (402), got HTTP ${res.status} — nothing was paid` };
    }
    const header = res.headers.get("payment-required");
    if (!header) return { status: "unavailable", detail: "the node challenged the ask without a PAYMENT-REQUIRED header" };
    const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: LiveChallengeOffer[] };
    const offer = (challenge.accepts ?? []).find((a) => a.scheme === "exact" && a.network?.startsWith("eip155:"));
    if (!offer) return { status: "unavailable", detail: "the live challenge carries no exact EVM entry to present" };
    const assetName = (offer as unknown as { extra?: { name?: string } }).extra?.name;
    return { status: "ok", payload: { ...offer, assetName } };
  } catch (err) {
    return { status: "unavailable", detail: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
}
