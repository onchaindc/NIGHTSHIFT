/**
 * Telegraph Daemon signals client (server-side).
 *
 * Reads only the node's free, keyless, read-only endpoints:
 *
 *   GET /daemon/api/questions        — the Daemon's collected signals
 *                                      (supported filters: type, category,
 *                                      since_hours, sort, order, limit, offset)
 *   GET /daemon/api/categories       — valid categories + per-category stats
 *   GET /engine/v1/signal/{hash}     — a stored recording for one signal hash
 *
 * The Daemon's WebSocket push for signals requires a wallet-authenticated
 * connection with an on-chain escrow balance and a per-session spend limit;
 * it is a billed channel and is deliberately not used here. Anonymous
 * WebSocket use in the UI is limited to the actions the official interface
 * allows without credentials (ping), for live-connection status.
 */

import { telegraphNodeUrl } from "@/lib/telegraph/client";
import type { Outcome } from "@/lib/explorer/network";

export interface DaemonSignalQuestion {
  hash?: string;
  text?: string;
  category?: string;
  interest_score?: number;
  affected_pct?: number;
  audience_pct?: number;
  source_url?: string;
}

export interface DaemonSignalRouting {
  subnet_id?: string;
  subnet_name?: string;
  miner_slug?: string;
  reasoning?: string;
  intent?: string | null;
}

export interface DaemonSignalExecution {
  result?: {
    answer?: string;
    brief?: string;
    attribution?: string;
    confidence?: number;
    licence?: unknown;
    as_of?: string;
    error?: string;
    [key: string]: unknown;
  };
  error?: string;
  [key: string]: unknown;
}

/** One entry of the Daemon feed as the node returns it. */
export interface DaemonSignal {
  id: string;
  type: "daemon" | "direct" | string;
  source: string;
  status: string;
  created_at: string;
  signal_hash: string;
  routing_mode?: string;
  question?: DaemonSignalQuestion;
  routing?: DaemonSignalRouting;
  execution?: DaemonSignalExecution;
}

export interface DaemonSignalPage {
  results: DaemonSignal[];
  total: number;
  limit: number;
  offset: number;
}

export interface DaemonCategoryStat {
  category: string;
  count: number;
  avg_interest: number;
  max_interest: number;
}

export interface DaemonCategories {
  categories: string[];
  stats: DaemonCategoryStat[];
}

/** One engine-side recording of a stored signal. */
export interface SignalRecording {
  signal_hash: string;
  kind: string;
  signal?: {
    id?: string;
    wallet_address?: string;
    miner_slug?: string;
    subnet_id?: string;
    intent_id?: string;
    result_id?: string;
    created_at?: string;
  };
  payload?: {
    intent_id?: string;
    miner_slug?: string;
    subnet_id?: string;
    wallet_address?: string;
    request?: string;
    response?: string;
    timestamp?: string;
    [key: string]: unknown;
  };
  result?: DaemonSignal;
  verification?: { algorithm?: string; commitment?: string; verified?: boolean };
}

export type FeedOpts = { type?: string; category?: string; sinceHours?: number };

/** The one Daemon WebSocket URL the official interface publishes. */
export function daemonWsUrl(): string {
  return telegraphNodeUrl().replace(/^http/, "ws") + "/engine/ws";
}

const daemona = () => `${telegraphNodeUrl()}/daemon`;

async function getJson<T>(url: string): Promise<Outcome<T>> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { status: "unavailable", detail: `Daemon answered HTTP ${res.status} for ${new URL(url).pathname}` };
    }
    return { status: "ok", payload: (await res.json()) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "unavailable", detail: msg.slice(0, 160) };
  }
}

/** The exact subset of query params the live Daemon API supports; unknown ones are ignored. */
function buildFeedQuery(o: FeedOpts, limit: number, offset: number): string {
  const qs = new URLSearchParams();
  if (o.type === "daemon" || o.type === "direct") qs.set("type", o.type);
  if (o.category) qs.set("category", o.category.toUpperCase());
  if (Number.isFinite(o.sinceHours) && (o.sinceHours as number) > 0) qs.set("since_hours", String(o.sinceHours));
  qs.set("status", "success");
  qs.set("sort", "recent");
  qs.set("order", "desc");
  qs.set("limit", String(Math.min(100, Math.max(1, Math.trunc(limit)))));
  qs.set("offset", String(Math.max(0, Math.trunc(offset))));
  return qs.toString();
}

/**
 * Fetch one page of the Daemon feed, newest first. The API does not support
 * server-side text search or intent filtering, so callers filter those on the
 * rows that have been loaded (see the Signals UI).
 */
export async function fetchSignals(o: FeedOpts & { limit?: number; offset?: number }): Promise<Outcome<DaemonSignalPage>> {
  const out = await getJson<DaemonSignalPage>(
    `${daemona()}/api/questions?${buildFeedQuery(o, o.limit ?? 40, o.offset ?? 0)}`,
  );
  if (out.status === "ok" && !Array.isArray(out.payload.results)) {
    return { status: "unavailable", detail: "the Daemon returned a feed without a results array" };
  }
  return out;
}

export async function fetchSignalCategories(): Promise<Outcome<DaemonCategories>> {
  const out = await getJson<DaemonCategories>(`${daemona()}/api/categories`);
  if (out.status === "ok" && !Array.isArray(out.payload.categories)) {
    return { status: "unavailable", detail: "the Daemon returned categories without a list" };
  }
  return out;
}

/** Recording lookup is by the signal's permanent hash only. */
const HASH_RE = /^0x[0-9a-f]{64}$/i;

export async function fetchSignalRecording(hash: string): Promise<Outcome<SignalRecording>> {
  if (!HASH_RE.test(hash)) {
    return { status: "unavailable", detail: "not a signal hash (expected 0x… 64 hex characters)" };
  }
  const out = await getJson<SignalRecording & { error?: string }>(
    `${telegraphNodeUrl()}/engine/v1/signal/${hash}`,
  );
  if (out.status === "ok" && !out.payload.signal_hash) {
    return { status: "unavailable", detail: "the engine returned no signal record for this hash" };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lean row shape shared by the feed page and polling API route        */
/* ------------------------------------------------------------------ */

/** What the Signals UI needs per feed row — computed once, sent everywhere. */
export interface SignalRow {
  id: string;
  hash: string;
  kind: "Daemon" | "Direct";
  intent: string | null;
  miner: string | null;
  category: string;
  source: string;
  status: string;
  interest: number;
  text: string;
  at: string;
}

export function toRow(s: DaemonSignal): SignalRow {
  return {
    id: s.id,
    hash: s.signal_hash,
    kind: s.type === "daemon" ? "Daemon" : "Direct",
    intent: s.routing?.intent ?? null,
    miner: s.routing?.miner_slug ?? null,
    category: s.question?.category ?? "",
    source: s.source,
    status: s.status,
    interest: typeof s.question?.interest_score === "number" ? s.question.interest_score : 0,
    text: s.question?.text ?? "",
    at: s.created_at,
  };
}

export function toRows(page: DaemonSignalPage): SignalRow[] {
  return page.results.map(toRow);
}
