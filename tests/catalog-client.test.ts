import { describe, expect, it, vi } from "vitest";

import { loadBuyerCatalog, type CatalogLoadOptions } from "@/lib/api/catalog-client";

/**
 * The storefront's catalog loading contract — the client half of the
 * "offerings never load" regression. Every attempt is timed, non-OK and
 * malformed answers retry, and the failure comes back as a plain-language
 * reason the desk can render with a Retry — "Loading…" must never outlive
 * a failure, and a 500's JSON body must never be stored as the catalog.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const GOOD_CATALOG = {
  offerings: [{ id: "nightshift/counterparty-due-diligence", name: "Counterparty Due Diligence" }],
  provider: { walletAddress: "0xprovider", chainId: 8453, evaluatorAddress: "0x0", live: true, mode: "real" },
  contracts: { acp: "0xacp", usdc: "0xusdc" },
  observedAt: new Date().toISOString(),
};

function opts(fetchImpl: typeof fetch, sleep = async () => undefined): CatalogLoadOptions {
  return { fetchImpl, sleep, timeoutMs: 250, backoffMs: 1 };
}

describe("loadBuyerCatalog — success", () => {
  it("accepts a well-formed catalog on the first attempt", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(GOOD_CATALOG));
    const out = await loadBuyerCatalog(opts(fetchImpl as unknown as typeof fetch));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.attempts).toBe(1);
      expect(out.catalog.offerings).toHaveLength(1);
      expect(out.catalog.provider.chainId).toBe(8453);
      expect(out.catalog.contracts?.acp).toBe("0xacp");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("loadBuyerCatalog — retryable failures", () => {
  it("retries a 500 and accepts the next good answer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    // Call 1 → 500, call 2 → the good catalog (queued overrides, then default).
    fetchImpl.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    fetchImpl.mockResolvedValueOnce(jsonResponse(GOOD_CATALOG, 200));
    const sleeps: number[] = [];
    const out = await loadBuyerCatalog({ ...(opts(fetchImpl as unknown as typeof fetch) as CatalogLoadOptions), sleep: async (ms) => void sleeps.push(ms) });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.attempts).toBe(2);
    expect(sleeps).toEqual([1]);
  });

  it("gives up after the configured attempts with an HTTP reason", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 503));
    const out = await loadBuyerCatalog({ ...opts(fetchImpl as unknown as typeof fetch), attempts: 2 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("HTTP 503");
      expect(out.reason).toContain("anything you already signed");
      expect(out.attempts).toBe(2);
    }
  });

  it("treats a timeout as retryable and says so", async () => {
    const aborted = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const fetchImpl = vi.fn(async () => {
      throw aborted;
    });
    const out = await loadBuyerCatalog({ ...opts(fetchImpl as unknown as typeof fetch), attempts: 2 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("did not answer within");
  });

  it("renders a network drop in the shared friendly language", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const out = await loadBuyerCatalog({ ...opts(fetchImpl as unknown as typeof fetch), attempts: 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("connection to the server dropped");
  });
});

describe("loadBuyerCatalog — malformed payloads are failures, never catalogs", () => {
  it.each([
    ["empty object", {}],
    ["offerings missing", { provider: GOOD_CATALOG.provider }],
    ["offerings not an array", { offerings: "nope", provider: GOOD_CATALOG.provider }],
    ["offering items unshaped", { offerings: [{ nope: true }], provider: GOOD_CATALOG.provider }],
    ["provider missing", { offerings: GOOD_CATALOG.offerings }],
    ["provider unshaped", { offerings: GOOD_CATALOG.offerings, provider: { chainId: "8453" } }],
  ])("%s is rejected", async (_label, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const out = await loadBuyerCatalog({ ...opts(fetchImpl as unknown as typeof fetch), attempts: 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not a valid catalog");
  });

  it("rejects a non-JSON 200 (an error page that claimed success)", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>FUNCTION_TIMEOUT</html>", { status: 200 }));
    const out = await loadBuyerCatalog({ ...opts(fetchImpl as unknown as typeof fetch), attempts: 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not a valid catalog");
  });
});
