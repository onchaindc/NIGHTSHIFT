import { beforeEach, describe, expect, it } from "vitest";

import { getTask, listTasks, resetStore } from "@/lib/engine/store";
import { reconcileLedger } from "@/lib/engine/ledger";
import { recordTerminalOutcome } from "@/lib/terminal/store";
import type { TelegraphReceipt } from "@/lib/engine/types";
import type { AskRequestSpec, ExecuteOutcome } from "@/lib/terminal/ask";

/**
 * Focused checks for Phase 5b: terminal executions become durable activity
 * records in the SAME task store, keyed idempotently on the network's signal
 * hash for paid answers, with failures recorded without any invented payment.
 */

const OFFER = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0xpayto",
  amount: "10000",
};

const RECEIPT: TelegraphReceipt = {
  receipt_hash: "0xreceipt123",
  rail: "x402",
  payer: "0xpayer",
  miner: "351",
  intent: "RESEARCH",
  amount_uusdc: "10000",
  epoch_id: 314,
  settlement: "onchain",
  chain: "eip155:84532",
  tx_hash: "0xtx123",
  timestamp: 1789466181,
};

function answeredOutcome(attempt: number): ExecuteOutcome {
  return {
    kind: "answered",
    urlPath: "/engine/v1/ask",
    requestSent: { query: `question ${attempt}` },
    offer: OFFER,
    result: { note: "answer-ish" },
    minerName: "fake-miner",
    intent: "RESEARCH",
    costUsd: 0.01,
    signalHash: `0xsignal${attempt}`,
    receipt: RECEIPT,
    settlementHeader: "proof-blob",
  };
}

const SPEC: AskRequestSpec = { query: "What is the exchange rate USD to EUR?" };

describe("terminal activity persistence (Phase 5b)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("records a paid answer once, keyed by its signal hash (upsert idempotency)", async () => {
    const first = await recordTerminalOutcome(answeredOutcome(1), SPEC, "0xpayer");
    expect(first.saved).toBe(true);
    expect(first.id).toBe("terminal-0xsignal1");

    // Re-recording the SAME outcome (a retried write, a stale client refresh)
    // upserts the same record instead of duplicating it.
    const again = await recordTerminalOutcome(answeredOutcome(1), SPEC, "0xpayer");
    expect(again.saved).toBe(true);
    expect(again.id).toBe(first.id);

    const rec = await getTask(first.id);
    expect(rec?.jobType).toBe("terminal_request");
    expect(rec?.state).toBe("completed");
    expect(rec?.origin.source).toBe("web");
    expect(rec?.spend.spentUsdCents).toBe(1); // amount_uusdc 10000 = $0.01
    expect(rec?.spend.entries?.[0]?.receiptHash).toBe("0xreceipt123");
    expect(rec?.spend.entries?.[0]?.txHash).toBe("0xtx123");
    expect(rec?.spend.entries?.[0]?.signalHash).toBe("0xsignal1");
    expect(rec?.terminal?.intent).toBe("RESEARCH");
    expect(rec?.terminal?.offer?.network).toBe("eip155:84532");
    expect(rec?.terminal?.settlementHeader).toBe("proof-blob");
    expect(
      (await listTasks()).filter((t) => t.id === `terminal-0xsignal1`),
    ).toHaveLength(1);

    // The ledger contract holds: one entry, one recorded delivery, consistent.
    expect(reconcileLedger(rec as NonNullable<typeof rec>).consistent).toBe(true);

    // No key material is ever written into the record.
    expect(JSON.stringify(rec)).not.toMatch(/private_?key/i);
  });

  it("records a refusal accurately: failed attempt, zero spend, no payment claim", async () => {
    const refused: ExecuteOutcome = { kind: "refused", reason: "the live charge drifted from the approved offer" };
    const out = await recordTerminalOutcome(refused, SPEC);
    expect(out.saved).toBe(true);

    const task = await getTask(out.id);
    expect(task?.jobType).toBe("terminal_request");
    expect(task?.state).toBe("failed");
    expect(task?.spend.spentUsdCents).toBe(0);
    expect(task?.spend.entries ?? []).toHaveLength(0);
    expect(task?.result).toBeNull();
    expect((task?.events ?? []).some((e) => e.type === "step_failed")).toBe(true);
    expect(JSON.stringify(task)).not.toContain("receipt_hash");
  });

  it("separate attempts stay separate records (each is a real, distinct attempt)", async () => {
    const before = (await listTasks()).length;
    const a = await recordTerminalOutcome({ kind: "unpaid_rejected", status: 422, body: null }, SPEC);
    const b = await recordTerminalOutcome({ kind: "unpaid_rejected", status: 422, body: null }, SPEC);
    expect(a.saved).toBe(true);
    expect(b.saved).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith("terminal-attempt-")).toBe(true);
    expect((await listTasks()).length).toBe(before + 2);
  });
});
