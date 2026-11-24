import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { type TelegraphChallenge } from "@/lib/telegraph/client";
import { executeAsk, railsOfChallenge, unionRails, type ApprovedRail } from "@/lib/terminal/ask";

/**
 * Multi-rail approval tests. The provider's backend pool alternates rail
 * compositions per request (observed live 2026-11-24: probes drew an
 * Ethereum-Sepolia exact rail while the paid request drew Base Sepolia), so
 * the approval covers a SET of rails. These tests pin down the contract:
 * any approved rail may be signed, nothing outside the set ever is, and the
 * UNSIGNED challenge fetch retries until it draws an approved rail — while a
 * SIGNED request is always attempted exactly once.
 */

const NODE = "http://telegraph.test";
const DUMMY_KEY = `0x${"cd".repeat(32)}`;
const ACCOUNT = privateKeyToAccount(DUMMY_KEY as `0x${string}`);

const SEPOLIA = "eip155:11155111";
const BASE = "eip155:84532";
const SEPOLIA_TOKEN = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const BASE_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SEPOLIA_PAYTO = "0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b";
const BASE_PAYTO = "0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e";

const SEPOLIA_EXACT = {
  scheme: "exact",
  network: SEPOLIA,
  asset: SEPOLIA_TOKEN,
  amount: "10000",
  payTo: SEPOLIA_PAYTO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};
const BASE_EXACT = {
  scheme: "exact",
  network: BASE,
  asset: BASE_TOKEN,
  amount: "10000",
  payTo: BASE_PAYTO,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};
const BASE_EXACT_REPRICED = { ...BASE_EXACT, amount: "20000" };

function challengeWith(...accepts: unknown[]): TelegraphChallenge {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: `${NODE}/engine/v1/ask`, description: "Payment required for LLM-routed inference.", mimeType: "application/json" },
    accepts,
  } as unknown as TelegraphChallenge;
}

const SEPOLIA_RAIL: ApprovedRail = {
  network: SEPOLIA,
  asset: SEPOLIA_TOKEN,
  payTo: SEPOLIA_PAYTO,
  amount: "10000",
  amountCents: 1,
};
const BASE_RAIL: ApprovedRail = {
  network: BASE,
  asset: BASE_TOKEN,
  payTo: BASE_PAYTO,
  amount: "10000",
  amountCents: 1,
};

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const BODY_SUMMARY = {
  error: "payment required",
  accepts: [
    { scheme: "exact", price: "$0.01", network: SEPOLIA, payTo: SEPOLIA_PAYTO },
    { scheme: "exact", price: "$0.01", network: BASE, payTo: BASE_PAYTO },
  ],
};

interface CapturedCall {
  url: string;
  paymentHeader: string | null;
}

/** Scripted node: bare requests walk `challengeSequence`; signed requests settle. */
function stubNode(opts: { challengeSequence?: TelegraphChallenge[] } = {}) {
  const calls: CapturedCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const paymentHeader = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
    calls.push({ url: req.url, paymentHeader });
    if (paymentHeader) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "X-TELEGRAPH-RECEIPT": b64({
          receipt_hash: "0xcece",
          rail: "x402",
          payer: ACCOUNT.address,
          miner: "4664",
          intent: "GENERIC",
          amount_uusdc: "10000",
          epoch_id: 1954,
          settlement: "onchain",
          chain: SEPOLIA,
          tx_hash: "0xd851",
          timestamp: 1793504275,
        }),
        "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xd851", network: SEPOLIA, payer: ACCOUNT.address }),
      };
      return new Response(
        JSON.stringify({ miner_id: "190069", miner_name: "Cp Coinbase", result: { answer_summary: "ok" }, result_shape: "intent", cost_usd: 0.01, signal_hash: "0x43b4" }),
        { status: 200, headers },
      );
    }
    const idx = calls.filter((c) => !c.paymentHeader).length - 1;
    const challenge = opts.challengeSequence ? opts.challengeSequence[Math.min(idx, opts.challengeSequence.length - 1)] : challengeWith(SEPOLIA_EXACT);
    return new Response(JSON.stringify(BODY_SUMMARY), {
      status: 402,
      headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(challenge) },
    });
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

function decodeSignedPayload(headerValue: string): { accepted?: Record<string, unknown> } {
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as { accepted?: Record<string, unknown> };
}

const signedRequests = (calls: CapturedCall[]) => calls.filter((c) => c.paymentHeader);

beforeEach(() => {
  process.env.TELEGRAPH_NODE_URL = NODE;
  process.env.TELEGRAPH_EVM_PRIVATE_KEY = DUMMY_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAPH_EVM_PRIVATE_KEY;
  delete process.env.TELEGRAPH_NODE_URL;
});

const INPUT = {
  spec: { intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL", params: { company: "MARA Holdings", jurisdiction: "United States" } },
  approved: true as const,
};

describe("multi-rail approval: the provider alternates rails per request", () => {
  it("signs an approved rail even when it is not the approval's first one", async () => {
    // Approval recorded the Sepolia rail first, but the pool serves Base.
    const calls = stubNode({ challengeSequence: [challengeWith(BASE_EXACT), challengeWith(BASE_EXACT)] });
    const outcome = await executeAsk({
      ...INPUT,
      approvedOffer: { scheme: "exact", network: SEPOLIA, asset: SEPOLIA_TOKEN, payTo: SEPOLIA_PAYTO, amount: "10000" },
      approvedRails: [SEPOLIA_RAIL, BASE_RAIL],
    });
    expect(outcome.kind).toBe("answered");
    const signed = signedRequests(calls);
    expect(signed).toHaveLength(1);
    const accepted = decodeSignedPayload(signed[0].paymentHeader as string).accepted;
    expect(accepted?.network).toBe(BASE);
  });

  it("refuses a live challenge that carries none of the approved rails", async () => {
    const calls = stubNode({ challengeSequence: [challengeWith(BASE_EXACT), challengeWith(BASE_EXACT)] });
    const outcome = await executeAsk({
      ...INPUT,
      approvedOffer: { scheme: "exact", network: SEPOLIA, asset: SEPOLIA_TOKEN, payTo: SEPOLIA_PAYTO, amount: "10000" },
      approvedRails: [SEPOLIA_RAIL],
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("none of the approved rails");
    }
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("refuses when the pool repriced an approved rail's network", async () => {
    const calls = stubNode({ challengeSequence: [challengeWith(BASE_EXACT_REPRICED), challengeWith(BASE_EXACT_REPRICED)] });
    const outcome = await executeAsk({
      ...INPUT,
      approvedOffer: { scheme: "exact", network: SEPOLIA, asset: SEPOLIA_TOKEN, payTo: SEPOLIA_PAYTO, amount: "10000" },
      approvedRails: [SEPOLIA_RAIL, BASE_RAIL],
    });
    expect(outcome.kind).toBe("refused");
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("re-fetches the UNSIGNED challenge until it draws an approved rail, then signs once", async () => {
    // Fresh probe draws Sepolia (passes the rail-set check); the paid phase
    // draws Base twice before Sepolia comes back. The first two are bare 402s
    // (nothing signed); the retry never touches a signed request.
    const calls = stubNode({
      challengeSequence: [challengeWith(SEPOLIA_EXACT), challengeWith(BASE_EXACT), challengeWith(BASE_EXACT), challengeWith(SEPOLIA_EXACT)],
    });
    const outcome = await executeAsk({
      ...INPUT,
      approvedOffer: { scheme: "exact", network: SEPOLIA, asset: SEPOLIA_TOKEN, payTo: SEPOLIA_PAYTO, amount: "10000" },
      approvedRails: [SEPOLIA_RAIL],
    });
    expect(outcome.kind).toBe("answered");
    const signed = signedRequests(calls);
    expect(signed).toHaveLength(1);
    const unsigned = calls.filter((c) => !c.paymentHeader);
    // 1 fresh probe + 3 paid-phase challenge fetches (initial + 2 retries)
    expect(unsigned).toHaveLength(4);
    const accepted = decodeSignedPayload(signed[0].paymentHeader as string).accepted;
    expect(accepted?.network).toBe(SEPOLIA);
  });

  it("never retries a request that already carries a payment header", async () => {
    // The signed request gets a bare 402 (payload did not verify): the outcome
    // is terminal, the signed request is sent exactly once, never re-tried.
    const calls: CapturedCall[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const paymentHeader = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
      calls.push({ url: req.url, paymentHeader });
      if (paymentHeader) {
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(BODY_SUMMARY), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(challengeWith(SEPOLIA_EXACT)) },
      });
    });
    vi.stubGlobal("fetch", impl);
    const outcome = await executeAsk({
      ...INPUT,
      approvedOffer: { scheme: "exact", network: SEPOLIA, asset: SEPOLIA_TOKEN, payTo: SEPOLIA_PAYTO, amount: "10000" },
      approvedRails: [SEPOLIA_RAIL],
    });
    expect(outcome.kind).toBe("payment_rejected");
    expect(signedRequests(calls)).toHaveLength(1);
    expect(calls.filter((c) => !c.paymentHeader)).toHaveLength(2); // fresh probe + paid phase 1
  });
});

describe("rail helpers", () => {
  it("extracts every complete exact-scheme EVM rail, networks canonicalized", () => {
    const rails = railsOfChallenge(challengeWith(BASE_EXACT, { scheme: "escrow", network: SEPOLIA, asset: SEPOLIA_TOKEN, amount: "10000", payTo: SEPOLIA_PAYTO }, { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC", amount: "10000", payTo: "G53" }));
    expect(rails).toHaveLength(1);
    expect(rails[0]).toMatchObject({ network: BASE, amountCents: 1 });
  });

  it("unions rails on the full contract identity", () => {
    const merged = unionRails([SEPOLIA_RAIL, BASE_RAIL], [BASE_RAIL, { ...SEPOLIA_RAIL, amount: "20000", amountCents: 2 }]);
    expect(merged).toHaveLength(3);
    expect(merged.map((r) => `${r.network}:${r.amountCents}`)).toEqual([`${SEPOLIA}:1`, `${BASE}:1`, `${SEPOLIA}:2`]);
  });
});
