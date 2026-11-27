/**
 * The buyer storefront's catalog loader — the client half of the
 * "offerings never load" fix.
 *
 * The failure it replaces: `loadCatalog` did one bare fetch with no res.ok
 * check, no timeout and no retry; any failure left the storefront printing
 * "Loading the published offerings…" forever, and a 500-with-JSON-body was
 * even stored as the catalog (crashing the page on `offerings.map`). The
 * contract now:
 *
 *   - every attempt is bounded by an AbortController timeout,
 *   - a non-OK status, a malformed payload or a network failure is RETRYABLE
 *     (the first attempt often lands on a cold serverless instance),
 *   - the payload is validated to BE a catalog before it reaches the UI,
 *   - the failure is returned as a plain-language reason; the desk renders
 *     it with a Retry affordance and never calls the state "loading".
 */
import { friendlyNetworkError } from "@/lib/api/client-errors";

export interface BuyerCatalog {
  offerings: Array<{ id: string; name: string; [key: string]: unknown }>;
  provider: {
    walletAddress: string | null;
    chainId: number;
    evaluatorAddress: string;
    live: boolean;
    mode: string;
  };
  contracts: { acp: string; usdc: string } | null;
  observedAt?: string | null;
}

export type CatalogOutcome =
  | { ok: true; catalog: BuyerCatalog; attempts: number }
  | { ok: false; reason: string; attempts: number };

export interface CatalogLoadOptions {
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  url?: string;
  /** Per-attempt wall-clock budget. */
  timeoutMs?: number;
  /** TOTAL attempts including the first. Default 3 (first + 2 retries). */
  attempts?: number;
  /** Base backoff between attempts (doubles per retry). Default 400 ms. */
  backoffMs?: number;
  /** Injectable delay for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_URL = "/api/acp/buyer/catalog";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 400;

function isAborted(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}

/** A catalog payload must be a catalog — never trust a 200's body shape. */
function parseCatalog(body: unknown): BuyerCatalog | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.offerings) || b.offerings.length === 0) return null;
  const first = b.offerings[0];
  if (typeof first !== "object" || first === null) return null;
  const f = first as Record<string, unknown>;
  if (typeof f.id !== "string" || typeof f.name !== "string") return null;
  if (typeof b.provider !== "object" || b.provider === null) return null;
  const p = b.provider as Record<string, unknown>;
  if (typeof p.chainId !== "number" || typeof p.mode !== "string") return null;
  return body as BuyerCatalog;
}

export async function loadBuyerCatalog(opts: CatalogLoadOptions = {}): Promise<CatalogOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = opts.url ?? DEFAULT_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalAttempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastReason = "The request did not complete.";
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { cache: "no-store", signal: controller.signal });
      if (!res.ok) {
        lastReason = `The services endpoint answered HTTP ${res.status}.`;
      } else {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const catalog = body === null ? null : parseCatalog(body);
        if (catalog) return { ok: true, catalog, attempts: attempt };
        lastReason = "The services endpoint answered, but the answer was not a valid catalog.";
      }
    } catch (err) {
      if (isAborted(err)) {
        lastReason = `The services endpoint did not answer within ${Math.round(timeoutMs / 1000)} s.`;
      } else {
        lastReason = friendlyNetworkError(err);
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < totalAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
  }
  return {
    ok: false,
    reason: `${lastReason} This does not affect anything you already signed — your wallet and any open job are untouched.`,
    attempts: totalAttempts,
  };
}
