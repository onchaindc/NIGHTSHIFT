import { beforeEach, describe, expect, it } from "vitest";
import { resetStore } from "@/lib/engine/store";
import {
  createTask,
  runTask,
  type EngineDeps,
} from "@/lib/engine/engine";
import { TelegraphBlockedError, TelegraphBudgetExceededError } from "@/lib/telegraph/client";
import type { AskOptions } from "@/lib/telegraph/client";
import { isFreeCapableGoal, planForGoal } from "@/lib/engine/planner";
import type { TelegraphAnswer, TelegraphReceipt } from "@/lib/engine/types";
import type { ChainReceipt } from "@/lib/chain/rpc";

/**
 * Free research: the operation path that answers with real public reads
 * (chain RPC + key-less public price APIs) and NEVER signs a payment.
 *
 * The paid path is not removed; these tests also prove that asking for paid
 * explicitly still goes through Telegraph with approval and budget rules
 * intact, that a missing credential blocks honestly, and that a free request
 * can never silently become a paid operation.
 */

const receipt: TelegraphReceipt = {
  receipt_hash: "0xhash",
  rail: "x402",
  payer: "0xpayer",
  miner: "351",
  intent: "CRYPTO_PRICE",
  amount_uusdc: "10000",
  epoch_id: 314,
  settlement: "onchain",
  chain: "eip155:84532",
  tx_hash: "0xtx123",
  timestamp: 1789466181,
};

const GOOD_ANSWER: TelegraphAnswer = {
  answer: { data: { amount: "61000", base: "BTC", currency: "USD" } },
  minerId: "351",
  minerName: "fake-miner",
  costUsd: 0.01,
  signalHash: "0xsignal",
  receipt,
};

const SETTLED: ChainReceipt = { found: true, status: "success", blockNumber: 123456, to: "0xdead", rpcUrl: "https://fake-rpc" };

interface FakeHooks {
  askAuto?: EngineDeps["telegraph"]["askAuto"];
  fetchJSON?: EngineDeps["publicSource"]["fetchJSON"];
  getGasPrice?: EngineDeps["chain"]["getGasPrice"];
}

function makeDeps(hooks: FakeHooks = {}): EngineDeps & { calls: { ask: number; fetch: number; gas: number } } {
  const calls = { ask: 0, fetch: 0, gas: 0 };
  return {
    calls,
    telegraph: {
      askAuto: async (o) => {
        calls.ask++;
        if (hooks.askAuto) return hooks.askAuto(o);
        throw new Error("MUST NOT PAY: telegraph.askAuto was called in a test that must stay free");
      },
      lookupSignal: async (h) => ({ signal_hash: h, result: GOOD_ANSWER.answer, signal: { created_at: new Date().toISOString() } }),
    },
    chain: {
      getReceipt: async () => SETTLED,
      getGasPrice: async (chain) => {
        calls.gas++;
        if (hooks.getGasPrice) return hooks.getGasPrice(chain);
        return { chain: chain ?? "base", gasPriceWei: 50_000_000, gasPriceGwei: 0.05, rpcUrl: "https://fake-rpc" };
      },
    },
    publicSource: {
      fetchJSON: async (url) => {
        calls.fetch++;
        if (hooks.fetchJSON) return hooks.fetchJSON(url);
        throw new Error("unexpected public read: " + url);
      },
    },
    now: () => Date.now(),
  };
}

beforeEach(() => {
  resetStore();
});

/* ------------------------------------------------------------------ */
/* Free capabilities and the planner                                   */
/* ------------------------------------------------------------------ */

describe("free-capable goal recognition", () => {
  it("recognizes gas and single-asset price questions; rejects general questions", () => {
    expect(isFreeCapableGoal("Is the gas price on Base right now under $0.50 for a 21000-gas transfer?")).toBe(true);
    expect(isFreeCapableGoal("What is the current BTC price in USD?")).toBe(true);
    expect(isFreeCapableGoal("Summarize the latest research discussion in the governance forum")).toBe(false);
    expect(isFreeCapableGoal("What is the current price of a sandwich?")).toBe(false);
  });

  it("a free plan never contains a paid step", () => {
    const plan = planForGoal("What is the current ETH price in USD?", 100, "free");
    expect(plan.steps.map((s) => s.kind)).toEqual(["free_public_lookup", "verify_evidence"]);
    expect(plan.criteria.primarySource).toBe("free");
  });
});

/* ------------------------------------------------------------------ */
/* Free execution: real reads, zero spend, no payment machinery        */
/* ------------------------------------------------------------------ */

describe("free research execution", () => {
  it("answers a single-asset price goal from a public API with $0 spend and no Telegraph call", async () => {
    const deps = makeDeps({
      fetchJSON: async (url) => {
        expect(url).toContain("api.coingecko.com");
        return { bitcoin: { usd: 61000 } };
      },
    });
    const task = await createTask({
      goal: "What is the current BTC price in USD?",
      spendLimitUsdCents: 100,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "free",
    });
    expect(task.state).toBe("executing"); // free plans run without approval: nothing can be spent
    const done = await runTask(task.id, deps);
    expect(done.state).toBe("completed");
    expect(done.spend.spentUsdCents).toBe(0);
    expect(deps.calls.ask).toBe(0); // no payment machinery was ever touched
    expect(done.result?.evidence.some((e) => e.kind === "public_source_lookup" && e.priceUsd === 61000)).toBe(true);
    expect(done.result?.summary).toContain("$61000");
  });

  it("answers a gas goal from a public chain RPC with $0 spend and no Telegraph call", async () => {
    const deps = makeDeps();
    const task = await createTask({
      goal: "Is the gas price on Base right now?", // informational gas goal without a USD threshold
      spendLimitUsdCents: 100,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "free",
    });
    const done = await runTask(task.id, deps);
    expect(done.state).toBe("completed");
    expect(done.spend.spentUsdCents).toBe(0);
    expect(deps.calls.ask).toBe(0);
    expect(deps.calls.gas).toBe(1);
    expect(done.result?.evidence.some((e) => e.kind === "chain_read" && e.chain === "base")).toBe(true);
    expect(done.result?.summary).toContain("0.05");
  });

  it("computes the goal's 21000-gas fee threshold from free reads only", async () => {
    // 0.05 gwei -> 0.05e-9 ETH per gas * 21000 = 1.05e-6 ETH * $3000 = $0.00315 < $0.50
    const deps = makeDeps({ fetchJSON: async () => ({ ethereum: { usd: 3000 } }) });
    const task = await createTask({
      goal: "Is the gas price on Base right now under $0.50 for a 21000-gas transfer?",
      spendLimitUsdCents: 100,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "free",
    });
    const done = await runTask(task.id, deps);
    expect(done.state).toBe("completed");
    expect(done.result?.summary).toContain("$0.0032");
  });

  it("fails honestly when the real free reads do NOT meet the goal's threshold", async () => {
    // 50 gwei * 21000 gas * $3000/ETH = $3.15 > the goal's $0.50 requirement
    const deps = makeDeps({
      getGasPrice: async () => ({ chain: "base", gasPriceWei: 5e10, gasPriceGwei: 50, rpcUrl: "https://fake-rpc" }),
      fetchJSON: async () => ({ ethereum: { usd: 3000 } }),
    });
    const task = await createTask({
      goal: "Is the gas price on Base right now under $0.50 for a 21000-gas transfer?",
      spendLimitUsdCents: 100,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "free",
    });
    const done = await runTask(task.id, deps);
    expect(done.state).toBe("failed");
    expect(done.spend.spentUsdCents).toBe(0);
    expect(done.error).toMatch(/under \$0\.5|NOT achieved/);
  });

  it("fails honestly when the public source returns an unusable price", async () => {
    const deps = makeDeps({ fetchJSON: async () => ({ bitcoin: {} }) });
    const task = await createTask({
      goal: "What is the current BTC price in USD?",
      spendLimitUsdCents: 100,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "free",
    });
    const done = await runTask(task.id, deps);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/no usable USD figure/i);
    expect(done.spend.spentUsdCents).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Free requests can never become paid operations                      */
/* ------------------------------------------------------------------ */

describe("free mode never silently pays", () => {
  it("blocks a free request whose question has no free capability, naming the way forward", async () => {
    const deps = makeDeps();
    const task = await createTask({
      goal: "Summarize the latest research discussion in the governance forum",
      spendLimitUsdCents: 100,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "free",
    });
    expect(task.state).toBe("blocked");
    expect(task.error).toMatch(/No free capability/i);
    expect(task.plan ?? []).toHaveLength(0);
    expect(task.spend.spentUsdCents).toBe(0);
    // The paid model was never consulted: block happens at planning.
    expect(deps.calls.ask).toBe(0);
    expect(deps.calls.fetch).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Paid research stays available, labeled and guarded                  */
/* ------------------------------------------------------------------ */

describe("paid mode keeps Telegraph rules intact", () => {
  it("a paid operation waits for approval before buying anything", async () => {
    const deps = makeDeps({ askAuto: async () => GOOD_ANSWER });
    const task = await createTask({
      goal: "What is the current BTC price in USD?",
      spendLimitUsdCents: 100,
      requiresApproval: true,
      origin: { source: "web" },
      mode: "paid",
    });
    expect(task.state).toBe("awaiting_approval");
    expect(deps.calls.ask).toBe(0); // approval gate holds
    expect((task.plan ?? []).some((s) => s.kind === "telegraph_ask")).toBe(true);
  });

  it("blocks honestly when the paid credential is missing, spending nothing", async () => {
    const deps = makeDeps({
      askAuto: async () => {
        throw new TelegraphBlockedError(
          "Telegraph paid inference is not configured: the task would require an X402 payment. Set TELEGRAPH_EVM_PRIVATE_KEY.",
          ["TELEGRAPH_EVM_PRIVATE_KEY"],
        );
      },
    });
    const task = await createTask({
      goal: "Summarize the latest research discussion in the governance forum",
      spendLimitUsdCents: 100,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "paid",
    });
    const done = await runTask(task.id, deps);
    expect(done.state).toBe("blocked");
    expect(done.error).toContain("TELEGRAPH_EVM_PRIVATE_KEY");
    expect(done.spend.spentUsdCents).toBe(0);
  });

  it("refuses a purchase priced above the remaining budget, and never re-sends it", async () => {
    let askCalls = 0;
    const deps = makeDeps({
      askAuto: async (o: AskOptions) => {
        askCalls++;
        throw new TelegraphBudgetExceededError(20, o.remainingBudgetUsdCents);
      },
    });
    const task = await createTask({
      goal: "Summarize the latest research discussion in the governance forum",
      spendLimitUsdCents: 10,
      requiresApproval: false,
      origin: { source: "web" },
      mode: "paid",
    });
    const done = await runTask(task.id, deps);
    expect(done.state).toBe("failed");
    expect(done.spend.spentUsdCents).toBe(0); // nothing was signed
    expect(askCalls).toBe(1); // budget refusals are never retried
    expect(done.events.some((e) => e.type === "spend_denied")).toBe(true);
  });
});
