import { describe, expect, it } from "vitest";
import { signalRecordMatchesAnswer } from "@/lib/engine/verify";
import type { SignalRecord } from "@/lib/telegraph/client";

/**
 * Verification of the signal-record matching layer. The live network records
 * the RAW miner output in the signal, while the ask response returns the
 * node's intent-shaped normalization of it, so equality must pass across the
 * representation change — and must still refuse materially different answers.
 */

/** Raw miner output shape, copied from a real 2026-11-01 paid ask (minimized). */
const RAW_RECORD: SignalRecord = {
  signal_hash: "0xabc",
  kind: "direct_result",
  result: {
    id: "res-1",
    status: "success",
    created_at: "2026-11-01T08:54:24.090807Z",
    routing_mode: "auto",
    question: { text: "What is the current native gas price floor on Base mainnet in gwei?" },
    execution: {
      result: {
        abstained: false,
        answer:
          "The available evidence supports the claim: current native gas price floor on Base mainnet in gwei. Most relevant evidence: The Jovian upgrade introduced a minimum base fee — a floor that prevents the L2 base fee from collapsing during quiet periods.",
        claims: [{ claim: "current native gas price floor on Base mainnet in gwei", confidence: 0.8338, verdict: "SUPPORTED" }],
        confidence: 0.8338,
        evidence: [{ id: "EV-001", url: "https://basehub.org/network/network-fees/" }, { id: "EV-002", url: "https://docs.base.org/specifications/transactions/network-fees" }],
      },
    },
  },
  payload: {
    intent_id: "FACT_CHECK_GENERAL",
    request: "What is the current native gas price floor on Base mainnet in gwei?",
    response: {
      abstained: false,
      answer:
        "The available evidence supports the claim: current native gas price floor on Base mainnet in gwei. Most relevant evidence: The Jovian upgrade introduced a minimum base fee — a floor that prevents the L2 base fee from collapsing during quiet periods.",
    },
  } as unknown as Record<string, unknown>,
  verification: { algorithm: "keccak256", commitment: "payload", verified: true },
} as unknown as SignalRecord;

const INTENT_ANSWER = {
  claim: "current native gas price floor on Base mainnet in gwei",
  verdict: null,
  reasoning:
    "The available evidence supports the claim: current native gas price floor on Base mainnet in gwei. Most relevant evidence: The Jovian upgrade introduced a minimum base fee — a floor that prevents the L2 base fee from collapsing during quiet periods.",
  sources: ["https://basehub.org/network/network-fees/", "https://docs.base.org/specifications/transactions/network-fees", "https://chaingate.dev/gas-tracker/base"],
};

/**
 * Regression for operation 7188c593-4f13-4d4c-aad4-4de8b6f3c6f4: the actual
 * signal record the node serves for that paid CRYPTO_PRICE_USD purchase
 * (signal 0xe91eec…cdb1b0) keeps the raw miner output wrapped in a data
 * envelope, while the answer our engine holds and checks may carry the same
 * facts in a flat or intent-normalized shape. The matcher must verify the
 * recorded value across those representations and still refuse any answer
 * whose facts are not on the node's record.
 */
const OP7188C593_RECORD: SignalRecord = {
  signal_hash: "0xe91eec1fe0004cf77fe49013648e7dca73c9416e37e63d387b74c092e1cdb1b0",
  kind: "direct_result",
  result: {
    id: "ddf7ebac-fd89-47fc-b068-a56bc616d707",
    type: "direct",
    source: "user",
    status: "success",
    routing_mode: "auto",
    routing: { subnet_id: "190069", subnet_name: "Cp Coinbase", miner_slug: "cp-coinbase" },
    execution: { result: { data: { amount: "78045.525", base: "BTC", currency: "USD" } } },
  },
  payload: {
    intent_id: "CRYPTO_PRICE_USD",
    miner_slug: "cp-coinbase",
    subnet_id: "190069",
    wallet_address: "0xE00Ecb51e1bA79731E78D443A90e3AD200107c4b",
    request: "btc price",
    response: {
      data: { amount: "78045.525", base: "BTC", currency: "USD" },
    },
  } as unknown as Record<string, unknown>,
  verification: { algorithm: "keccak256", commitment: "payload", verified: true },
} as unknown as SignalRecord;

describe("signal record vs accepted answer", () => {
  it("verifies an intent-shaped answer against the raw recorded output (the live case that previously refused)", () => {
    expect(signalRecordMatchesAnswer(RAW_RECORD, INTENT_ANSWER)).toBe(true);
  });

  it("verifies exact structural matches unchanged", () => {
    const record: SignalRecord = { ...RAW_RECORD, result: { execution: { result: INTENT_ANSWER } } } as unknown as SignalRecord;
    expect(signalRecordMatchesAnswer(record, { ...INTENT_ANSWER, verdict: null })).toBe(true);
  });

  it("verifies numeric answers recorded as strings (and vice versa)", () => {
    const record: SignalRecord = { result: { execution: { result: { price_usd: "79423.5" } } } } as unknown as SignalRecord;
    expect(signalRecordMatchesAnswer(record, { price_usd: 79423.5 })).toBe(true);
    expect(signalRecordMatchesAnswer(record, { price_usd: 1 })).toBe(false);
    // Bare scalars (result_shape raw) across string/number representation.
    expect(signalRecordMatchesAnswer({ result: { execution: { result: "79423.5" } } } as unknown as SignalRecord, 79423.5)).toBe(true);
  });

  it("refuses materially different answers recorded for the same hash", () => {
    expect(
      signalRecordMatchesAnswer(RAW_RECORD, { ...INTENT_ANSWER, claim: "a different claim entirely, about token vesting schedules" }),
    ).toBe(false);
    expect(
      signalRecordMatchesAnswer(RAW_RECORD, { ...INTENT_ANSWER, reasoning: "Fabricated reasoning that appears nowhere in the node record at all." }),
    ).toBe(false);
  });

  it("refuses empty, missing or unparsable records", () => {
    expect(signalRecordMatchesAnswer(null, INTENT_ANSWER)).toBe(false);
    expect(signalRecordMatchesAnswer({} as SignalRecord, INTENT_ANSWER)).toBe(false);
    expect(
      signalRecordMatchesAnswer({ result: { execution: { result: { unrelated: true } } }, payload: {} } as unknown as SignalRecord, INTENT_ANSWER),
    ).toBe(false);
  });

  it("refuses answers too short to substantiate against the record rather than waving them through", () => {
    expect(signalRecordMatchesAnswer(RAW_RECORD, { ok: true })).toBe(false);
  });

  describe("operation 7188c593 (real CRYPTO_PRICE_USD record structure)", () => {
    it("verifies the exact shape retained on the node", () => {
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, { data: { amount: "78045.525", base: "BTC", currency: "USD" } })).toBe(true);
    });

    it("verifies the flat miner shape the ask response returns", () => {
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, { amount: "78045.525", base: "BTC", currency: "USD" })).toBe(true);
    });

    it("verifies an intent-normalized numeric shape carrying the same recorded facts", () => {
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, { price_usd: 78045.525, asset: "BTC" })).toBe(true);
    });

    it("verifies the bare recorded amount as a number or its string form", () => {
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, 78045.525)).toBe(true);
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, "78045.525")).toBe(true);
    });

    it("refuses an answer whose numeric facts were not recorded for that signal", () => {
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, { amount: "78045.525", base: "BTC", currency: "USD", realized: 99999 })).toBe(false);
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, 99999)).toBe(false);
    });

    it("refuses an answer whose recorded label was swapped", () => {
      expect(signalRecordMatchesAnswer(OP7188C593_RECORD, { amount: "78045.525", base: "BTC", currency: "USDT" })).toBe(false);
    });

    it("refuses an answer carrying an unrecorded field of its own", () => {
      expect(
        signalRecordMatchesAnswer(OP7188C593_RECORD, { amount: "78045.525", base: "BTC", currency: "USD", note: "own commentary that is nowhere in the node record" }),
      ).toBe(false);
    });
  });
});
