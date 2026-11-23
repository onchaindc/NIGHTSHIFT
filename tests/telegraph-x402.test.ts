import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Address, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  askAuto,
  exactEvmOffer,
  setTelegraphBalanceProbeForTests,
  TelegraphBudgetExceededError,
  TelegraphResponseIntegrityError,
  type TelegraphChallenge,
} from "@/lib/telegraph/client";

/**
 * End-to-end tests of the Telegraph paid ask over x402, against the REAL SDK
 * (wrapFetchWithPayment + ExactEvmScheme) with the network stubbed at the HTTP
 * boundary — the same boundary the challenge/retry loop crosses. Signatures
 * are computed for real (dummy test key), so payload construction, header
 * attachment, request retry and payment failure paths are all exercised
 * without any network or any existent funds.
 */

const NODE = "http://telegraph.test";
const DUMMY_KEY = `0x${"ab".repeat(32)}`;
const ACCOUNT = privateKeyToAccount(DUMMY_KEY as `0x${string}`);

const SEPOLIA = "eip155:11155111";
const TELEGRAPH_TEST_TOKEN = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const PAY_TO = "0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b";

/** The node's AUTHORIZATIVE challenge (PAYMENT-REQUIRED header), per the docs page. */
const EXACT_ENTRY = {
  scheme: "exact",
  network: SEPOLIA,
  asset: TELEGRAPH_TEST_TOKEN,
  amount: "10000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};
const ESCROW_ENTRY = {
  scheme: "escrow",
  network: SEPOLIA,
  asset: TELEGRAPH_TEST_TOKEN,
  amount: "10000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { rail: "telegraph-escrow" },
};

function challengeWith(...accepts: unknown[]): TelegraphChallenge {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: `${NODE}/engine/v1/ask`, description: "Payment required for LLM-routed inference.", mimeType: "application/json" },
    accepts,
  } as unknown as TelegraphChallenge;
}

const DEFAULT_CHALLENGE = challengeWith(EXACT_ENTRY, ESCROW_ENTRY);
/** What the docs page shows as the 402 BODY: a summary without asset/amount. */
const BODY_SUMMARY = {
  error: "payment required",
  accepts: [
    { scheme: "exact", price: "$0.01", network: SEPOLIA, payTo: PAY_TO },
    { scheme: "escrow", price: "$0.01", network: SEPOLIA, payTo: PAY_TO },
  ],
};

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function response402(challenge: TelegraphChallenge = DEFAULT_CHALLENGE): Response {
  return new Response(JSON.stringify(BODY_SUMMARY), {
    status: 402,
    headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(challenge) },
  });
}

function response200(extra: { keepSignalHash?: boolean; keepReceipt?: boolean } = {}): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (extra.keepReceipt !== false) {
    headers["X-TELEGRAPH-RECEIPT"] = b64({
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
    });
    headers["PAYMENT-RESPONSE"] = b64({ success: true, transaction: "0xd851", network: SEPOLIA, payer: ACCOUNT.address });
  }
  const body: Record<string, unknown> = {
    miner_id: "190069",
    miner_name: "Cp Coinbase",
    result: { answer_summary: "ok" },
    result_shape: "intent",
    cost_usd: 0.01,
  };
  if (extra.keepSignalHash !== false) { body.signal_hash = "0x43b4"; }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

interface CapturedCall {
  url: string;
  body: string | null;
  paymentHeader: string | null;
}

/** Scripted node: bare requests get 402+challenge; signed requests follow per-test behavior. */
function stubNode(opts: { onSigned?: (call: CapturedCall) => Response | Promise<Response>; onPaymentRequiredHeader?: (callIndex: number) => string | null; challengeSequence?: TelegraphChallenge[] } = {}) {
  const calls: CapturedCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const paymentHeader = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
    const call: CapturedCall = { url: req.url, body: req.body ? await req.clone().text() : null, paymentHeader };
    calls.push(call);
    if (paymentHeader) {
      if (opts.onSigned) { return opts.onSigned(call); }
      return response200();
    }
    const idx = calls.filter((c) => !c.paymentHeader).length - 1;
    const challenge = opts.challengeSequence ? opts.challengeSequence[idx] : DEFAULT_CHALLENGE;
    const headerValue = opts.onPaymentRequiredHeader ? opts.onPaymentRequiredHeader(idx) : b64(challenge);
    const headers: Record<string, string> = { "content-type": "application/json", ...Object.fromEntries(BODY_SUMMARYHeaders(headerValue)) };
    return new Response(JSON.stringify(BODY_SUMMARY), { status: 402, headers });
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

function BODY_SUMMARYHeaders(paymentRequiredHeaderValue: string | null): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (paymentRequiredHeaderValue !== null) { out.push(["PAYMENT-REQUIRED", paymentRequiredHeaderValue]); }
  return out;
}

function decodeSignedPayload(headerValue: string): { x402Version?: number; accepted?: Record<string, unknown>; payload?: { authorization?: Record<string, unknown> } } {
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as { x402Version?: number; accepted?: Record<string, unknown>; payload?: { authorization?: Record<string, unknown> } };
}

const signedRequests = (calls: CapturedCall[]) => calls.filter((c) => c.paymentHeader);

beforeEach(() => {
  process.env.TELEGRAPH_NODE_URL = NODE;
  process.env.TELEGRAPH_EVM_PRIVATE_KEY = DUMMY_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  setTelegraphBalanceProbeForTests(null);
  delete process.env.TELEGRAPH_EVM_PRIVATE_KEY;
  delete process.env.TELEGRAPH_NODE_URL;
});

describe("x402: 402 challenge parsing", () => {
  it("prices and vetoes against the authoritative header challenge, not the bare-price body summary", async () => {
    const calls = stubNode();
    const seen: Array<{ amountUsdCents: number; asset?: string; payTo?: string; network: string; scheme: string }> = [];
    const answer = await askAuto({
      query: "q",
      remainingBudgetUsdCents: 10,
      onChallenge: (info) => { seen.push(info); },
    });
    expect(seen).toEqual([{ amountUsdCents: 1, scheme: "exact", network: SEPOLIA, asset: TELEGRAPH_TEST_TOKEN, payTo: PAY_TO }]);
    expect(answer.signalHash).toBe("0x43b4");
    expect(answer.receipt?.receipt_hash).toBe("0xcece");
    expect(calls.some((c) => c.paymentHeader)).toBe(true);
  });

  it("refuses to act on a bare 402 with no decodable challenge header", async () => {
    const calls = stubNode({ onPaymentRequiredHeader: () => null });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/could not be read/);
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("refuses a garbled PAYMENT-REQUIRED header", async () => {
    const calls = stubNode({ onPaymentRequiredHeader: () => Buffer.from("not json").toString("base64") });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/could not be read/);
    expect(signedRequests(calls)).toHaveLength(0);
  });
});

describe("x402: accepted-payment-option selection", () => {
  it("signs the exact entry and never the unimplemented escrow entry", async () => {
    const calls = stubNode();
    await askAuto({ query: "q", remainingBudgetUsdCents: 10 });
    const signed = signedRequests(calls);
    expect(signed).toHaveLength(1);
    const payload = decodeSignedPayload(signed[0].paymentHeader!);
    expect(payload.accepted?.scheme).toBe("exact");
    expect((payload.accepted as { network?: string }).network).toBe(SEPOLIA);
  });

  it("refuses the whole challenge when only an unimplemented escrow option is offered", async () => {
    const calls = stubNode({ challengeSequence: [challengeWith(ESCROW_ENTRY)] });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/no priceable exact-scheme EVM option/);
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("exactEvmOffer skips non-EVM and non-exact options", () => {
    expect(
      exactEvmOffer(
        challengeWith({ scheme: "upto", network: SEPOLIA, asset: TELEGRAPH_TEST_TOKEN, amount: "10000", payTo: PAY_TO }, ESCROW_ENTRY),
      ),
    ).toBeNull();
    expect(
      exactEvmOffer(
        challengeWith({ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpYogoGmJvvpYh", amount: "10000", payTo: PAY_TO }, ESCROW_ENTRY),
      ),
    ).toBeNull();
    expect(exactEvmOffer(challengeWith(EXACT_ENTRY, ESCROW_ENTRY))?.asset).toBe(TELEGRAPH_TEST_TOKEN);
  });
});

describe("x402: exact Sepolia payment construction, attachment and retry", () => {
  it("constructs the EIP-3009 authorization from the challenge and sends it once in PAYMENT-SIGNATURE", async () => {
    const calls = stubNode();
    await askAuto({ query: "q", remainingBudgetUsdCents: 10 });

    const bare = calls.filter((c) => !c.paymentHeader);
    const signed = signedRequests(calls);
    expect(bare).toHaveLength(2); // our probe + the SDK's own 402-handling attempt
    expect(signed).toHaveLength(1);
    expect(signed[0].url).toBe(`${NODE}/engine/v1/ask`);
    expect(signed[0].body).toBe(bare[0].body); // identical request, new header only

    const payload = decodeSignedPayload(signed[0].paymentHeader!);
    expect(payload.x402Version).toBe(2);
    const auth = payload.payload?.authorization as Record<string, unknown>;
    expect(getAddress(auth.from as Address)).toBe(getAddress(ACCOUNT.address));
    expect(getAddress(auth.to as Address)).toBe(getAddress(PAY_TO));
    expect(BigInt(auth.value as string)).toBe(10000n); // $0.01 in 6-decimal units
    expect(payload.accepted as unknown).toEqual(
      expect.objectContaining({ scheme: "exact", network: SEPOLIA, asset: expect.any(String) }),
    );
  });
});

describe("x402: rejected and malformed challenges", () => {
  it("refuses a challenge whose exact entry lacks the signing asset", async () => {
    const missingAsset = challengeWith({ ...EXACT_ENTRY, asset: undefined });
    const calls = stubNode({ challengeSequence: [missingAsset] });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/must carry an asset/);
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("refuses a challenge with no payTo recipient", async () => {
    const missingPayTo = challengeWith({ ...EXACT_ENTRY, payTo: undefined });
    const calls = stubNode({ challengeSequence: [missingPayTo] });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/payTo/);
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("refuses a live exact entry that carries no atomic amount to sign", async () => {
    const priceOnly = challengeWith({ ...EXACT_ENTRY, amount: undefined, price: "$0.01" });
    // Challenge 1 (probe) can still be priced from the price string;
    // the selector refuses to SIGN a price without an atomic amount.
    const calls = stubNode({ challengeSequence: [priceOnly, priceOnly] });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/no atomic amount|nothing was signed/);
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("refuses when the live challenge drifts to a different asset than the priced offer", async () => {
    const drifted = challengeWith({ ...EXACT_ENTRY, asset: "0xdead000000000000000000000000000000000001" });
    const calls = stubNode({ challengeSequence: [DEFAULT_CHALLENGE, drifted] });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/refused the payment itself before anything was signed|drifted/);
    expect(signedRequests(calls)).toHaveLength(0);
  });
});

describe("x402: budget ceiling and disallowed assets", () => {
  it("throws TelegraphBudgetExceededError before anything is signed", async () => {
    const calls = stubNode();
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 0 })).rejects.toBeInstanceOf(TelegraphBudgetExceededError);
    expect(calls).toHaveLength(1); // only the free probe
    expect(signedRequests(calls)).toHaveLength(0);
  });

  it("re-checks the budget against the LIVE challenge amount at signature time", async () => {
    const repriced = challengeWith({ ...EXACT_ENTRY, amount: "20000" }); // $0.02 after a mid-flight price drift
    const calls = stubNode({ challengeSequence: [DEFAULT_CHALLENGE, repriced] });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 1 })).rejects.toBeInstanceOf(TelegraphBudgetExceededError);
    expect(signedRequests(calls)).toHaveLength(0);
  });
});

describe("x402: payment failure and ambiguous settlement", () => {
  it("a bare 402 to the signed payment is reported verbatim, never re-sent, with a funding diagnostic", async () => {
    setTelegraphBalanceProbeForTests(async () => "0 whole units (6 decimals; 0 atomic)");
    const calls = stubNode({ onSigned: () => response402() });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(
      /bare 402 to the signed payment.*not re-sent to avoid duplicate authorization.*holds 0 whole units/s,
    );
    expect(signedRequests(calls)).toHaveLength(1); // exactly one signed attempt, no blind retry
  });

  it("a failing public chain read degrades the diagnostic, never the throw", async () => {
    setTelegraphBalanceProbeForTests(async () => null);
    const calls = stubNode({ onSigned: () => response402() });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow(/first thing to verify|verif/);
    expect(signedRequests(calls)).toHaveLength(1);
  });

  it("a 200 without a receipt is an ambiguity, not a success; nothing is re-sent", async () => {
    const calls = stubNode({ onSigned: () => response200({ keepReceipt: false }) });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toBeInstanceOf(TelegraphResponseIntegrityError);
    expect(signedRequests(calls)).toHaveLength(1);
  });

  it("a 200 without a signal_hash is an ambiguity, not a success", async () => {
    const calls = stubNode({ onSigned: () => response200({ keepSignalHash: false }) });
    await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toBeInstanceOf(TelegraphResponseIntegrityError);
    expect(signedRequests(calls)).toHaveLength(1);
  });
});

describe("x402: duplicate-payment prevention", () => {
  it("never re-signs: at most one signed request per askAuto across failure modes", async () => {
    setTelegraphBalanceProbeForTests(async () => null);
    for (const mode of ["verifyFail", "noReceipt"] as const) {
      const calls = stubNode({
        onSigned: mode === "verifyFail" ? () => response402() : () => response200({ keepReceipt: false }),
      });
      await expect(askAuto({ query: "q", remainingBudgetUsdCents: 10 })).rejects.toThrow();
      expect(signedRequests(calls)).toHaveLength(1);
    }
  });
});

describe("x402: successful paid ask and verified result delivery", () => {
  it("delivers only after the node accepts the payment: result, receipt and cost", async () => {
    const calls = stubNode();
    const answer = await askAuto({ query: "q", remainingBudgetUsdCents: 10 });
    expect(answer.answer).toEqual({ answer_summary: "ok" });
    expect(answer.minerId).toBe("190069");
    expect(answer.minerName).toBe("Cp Coinbase");
    expect(answer.costUsd).toBe(0.01);
    expect(answer.signalHash).toMatch(/^0x4/);
    expect(answer.receipt?.amount_uusdc).toBe("10000");
    expect(answer.receipt?.settlement).toBe("onchain");
    expect(answer.receipt?.chain).toBe(SEPOLIA);
    expect(answer.receipt?.receipt_hash).toBe("0xcece");
    expect(signedRequests(calls)).toHaveLength(1);
  });
});
