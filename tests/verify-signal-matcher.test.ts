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
});
