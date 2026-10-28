import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveTask,
  createTask,
  defaultDeps,
  EngineError,
  rejectTask,
  runTask,
  BudgetExceededError,
  type EngineDeps,
  type ExecutionOutputs,
} from "@/lib/engine/engine";
import { resetStore, saveTask } from "@/lib/engine/store";
import { verifyTask } from "@/lib/engine/verify";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  isTerminal,
  type TelegraphAnswer,
} from "@/lib/engine/types";
import {
  TelegraphBlockedError,
  TelegraphBudgetExceededError,
  TelegraphResponseIntegrityError,
} from "@/lib/telegraph/client";

/* ------------------------------------------------------------------ */
/* Fakes: scripted Telegraph + chain tools with call counters          */
/* ------------------------------------------------------------------ */

const GOOD_ANSWER: TelegraphAnswer = {
  answer: { data: { amount: "68000.25", base: "BTC", currency: "USD" } },
  minerId: "351",
  minerName: "alchemy-price-fake",
  costUsd: 0.01,
  signalHash: "0xsignal123",
  receipt: {
    receipt_hash: "0xreceipt123",
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
  },
};

const SETTLED: ChainReceiptFixed = {
  found: true,
  status: "success",
  blockNumber: 123456,
  to: "0xmulticall3",
  rpcUrl: "https://fake-rpc",
};
interface ChainReceiptFixed {
  found: boolean;
  status: "success" | "reverted" | "not_found";
  blockNumber: number | null;
  to: string | null;
  rpcUrl: string;
}

interface FakeHooks {
  askAuto?: EngineDeps["telegraph"]["askAuto"];
  lookupSignal?: EngineDeps["telegraph"]["lookupSignal"];
  getReceipt?: EngineDeps["chain"]["getReceipt"];
  getGasPrice?: EngineDeps["chain"]["getGasPrice"];
}

function makeDeps(hooks: FakeHooks = {}): EngineDeps & {
  calls: { ask: number; signal: number; chain: number };
} {
  const calls = { ask: 0, signal: 0, chain: 0 };
  return {
    calls,
    telegraph: {
      askAuto: async (o) => {
        calls.ask++;
        return hooks.askAuto ? hooks.askAuto(o) : { ...GOOD_ANSWER };
      },
      lookupSignal: async (h) => {
        calls.signal++;
        return hooks.lookupSignal
          ? hooks.lookupSignal(h)
          : { signal_hash: h, result: GOOD_ANSWER.answer, signal: { created_at: new Date().toISOString() } };
      },
    },
    chain: {
      getReceipt: async (h) => {
        calls.chain++;
        return hooks.getReceipt ? hooks.getReceipt(h) : { ...SETTLED };
      },
      getGasPrice: async (chain) => {
        calls.chain++; // counts independent chain reads (settlement + cross-check)
        return hooks.getGasPrice
          ? hooks.getGasPrice(chain)
          : { chain: "base", gasPriceWei: 50_000_000, gasPriceGwei: 0.05, rpcUrl: "https://fake-rpc" };
      },
    },
    now: () => Date.now(),
  };
}

async function createdTask(goal = "What is the BTC price?", requiresApproval = true) {
  return createTask({
    goal,
    spendLimitUsdCents: 10, // $0.10 — above the $0.01 charge in fakes
    requiresApproval,
    origin: { source: "web" },
  });
}

beforeEach(() => {
  resetStore();
});

describe("task-state transitions", () => {
  it("defines a closed transition map with terminal end states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("blocked")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("executing")).toBe(false);
    for (const from of Object.keys(ALLOWED_TRANSITIONS) as Array<keyof typeof ALLOWED_TRANSITIONS>) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
    expect(canTransition("completed", "executing")).toBe(false);
    expect(canTransition("failed", "verifying")).toBe(false);
    expect(canTransition("rejected", "executing")).toBe(false);
  });

  it("creates tasks in created → planning with pre-execution success criteria", async () => {
    const task = await createdTask("goal one", true);
    expect(task.state).toBe("awaiting_approval");
    const types = task.events.map((e) => e.type);
    expect(types).toContain("goal_accepted");
    expect(types).toContain("plan_created");
    expect(types).toContain("criteria_defined");
    expect(types).toContain("approval_required");
    expect(task.criteria.ownPaymentSettledOnChain).toBe(true);
  });

  it("rejecting an awaiting plan stops it without any spend", async () => {
    const dep = makeDeps({});
    const task = await createdTask("goal two", true);
    const rejected = await rejectTask(task.id, dep);
    expect(rejected.state).toBe("rejected");
    expect(rejected.spend.spentUsdCents).toBe(0);
    expect(dep.calls.ask).toBe(0);
    await expect(rejectTask(rejected.id, dep)).rejects.toThrow(/illegal task transition rejected → rejected/);
  });

  it("approving an awaiting plan executes all steps and completes with evidence", async () => {
    const dep = makeDeps({});
    const task = await createdTask("goal three", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("completed");
    expect(done.result).not.toBeNull();
    const kinds = done.result!.evidence.map((e) => e.kind);
    expect(kinds).toContain("telegraph_signal");
    expect(kinds).toContain("telegraph_receipt");
    expect(kinds).toContain("on_chain_settlement");
    expect(done.spend.entries[0].receiptHash).toBe("0xreceipt123");
    expect(dep.calls.signal).toBe(1);
    expect(dep.calls.chain).toBe(1); // the agent went and checked the chain itself
  });

  it("runs straight away when approval is not required", async () => {
    const dep = makeDeps({});
    let task = await createdTask("goal four", false);
    expect(task.state).toBe("executing");
    task = await runTask(task.id, dep);
    console.log("DEBUG-ERR", task.error, JSON.stringify(task.events.filter((e) => e.type === "criteria_failed" || e.type === "task_failed")));
    expect(task.state).toBe("completed");
  });

  it("refuses runTask outside the executing state", async () => {
    const task = await createdTask("goal five", true);
    await expect(runTask(task.id, defaultDeps())).rejects.toThrow(EngineError);
  });
});

describe("real execution loop (paid response feeds the next action)", () => {
  it("the purchase's settlement tx becomes the settlement read's input", async () => {
    let capturedTx: string | null = null;
    const ethAnswer = { data: { amount: "4000.50", base: "ETH", currency: "USD" } };
    const dep = makeDeps({
      askAuto: async () => ({ ...GOOD_ANSWER, answer: ethAnswer }),
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: ethAnswer,
        signal: { created_at: new Date().toISOString() },
      }),
      getReceipt: async (txHash) => {
        capturedTx = txHash;
        return { ...SETTLED };
      },
    });
    const task = await createdTask("What is the ETH price?", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("completed");
    // must be the tx hash the purchase produced — NOT a hardcoded value
    expect(capturedTx).toBe("0xtx123");
  });
});

describe("permission boundaries", () => {
  it("never purchases when the action is not in allowedActions", async () => {
    const dep = makeDeps({});
    const task = await createdTask("goal six", true);
    task.permissions.allowedActions = [];
    await saveTask(task); // persist the boundary mutation before approving
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.events.map((e) => e.type)).toContain("permission_denied");
    expect(done.spend.entries).toHaveLength(0);
    expect(dep.calls.ask).toBe(0);
  });

  it("never reads the chain without the chain.read permission", async () => {
    const dep = makeDeps({});
    const task = await createdTask("goal six-b", true);
    task.permissions.allowedActions = ["telegraph.ask"]; // chain.read revoked
    await saveTask(task);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.events.map((e) => e.type)).toContain("permission_denied");
    expect(dep.calls.ask).toBe(1); // purchase happened...
    expect(dep.calls.chain).toBe(0); // ...but nothing was read without permission
  });
});

describe("spending limits", () => {
  it("refuses to sign a payment when the challenge exceeds the remaining budget", async () => {
    const dep = makeDeps({
      askAuto: async (o) => {
        // Mirror the real client: the 402 challenge is checked against remaining budget BEFORE payment.
        const requested = 50; // $0.50, remaining after approval is less than limit minus spent
        if (requested > o.remainingBudgetUsdCents) {
          throw new TelegraphBudgetExceededError(requested, o.remainingBudgetUsdCents);
        }
        return { ...GOOD_ANSWER };
      },
    });
    const task = await createdTask("goal seven", true);
    task.spend.spentUsdCents = 8; // $0.08 of the $0.10 ceiling already spent
    await saveTask(task);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    const denied = done.events.filter((e) => e.type === "spend_denied");
    expect(denied).toHaveLength(1);
    expect(done.spend.spentUsdCents).toBe(8); // the refused purchase was never accounted
    expect(done.result).toBeNull(); // no fake completion without evidence
  });

  it("exhausts the budget across purchases and never over-spends", async () => {
    const dep = makeDeps({});
    const task = await createdTask("goal seven-b", true);
    task.spend.limitUsdCents = 1; // exactly one cent
    await saveTask(task);
    const done = await approveTask(task.id, dep);
    // The $0.01 purchase fits exactly; the budget did not grow beyond the ceiling.
    expect(done.spend.spentUsdCents).toBe(1);
    expect(done.spend.spentUsdCents).toBeLessThanOrEqual(done.spend.limitUsdCents);
  });
});

describe("failure handling and recovery", () => {
  it("retries transient failures up to maxRetries, then fails the task", async () => {
    const dep = makeDeps({
      askAuto: async () => {
        throw new Error("HTTP 502 request failed");
      },
    });
    const task = await createdTask("goal eight", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(dep.calls.ask).toBe(3); // 1 attempt + 2 retries
    expect(done.events.map((e) => e.type)).toContain("step_failed");
    expect(done.events.map((e) => e.type)).toContain("recovery_selected");
    expect(done.spend.spentUsdCents).toBe(0); // only a delivered 200 ever costs money
  });

  it("recovers from a transient routing failure: retry succeeds and completes", async () => {
    let n = 0;
    const dep = makeDeps({
      askAuto: async () => {
        n++;
        if (n === 1) throw new Error("routing failed: miner \"x\" is not currently routable for intent");
        return { ...GOOD_ANSWER };
      },
    });
    const task = await createdTask("goal nine", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("completed"); // recovery worked
    expect(dep.calls.ask).toBe(2);
    expect(done.events.filter((e) => e.type === "recovery_selected")).toHaveLength(1);
    expect(done.spend.spentUsdCents).toBe(1); // the one delivered answer, $0.01
  });

  it("does not retry paid-response integrity failures (double-charge guard)", async () => {
    const dep = makeDeps({
      askAuto: async () => {
        throw new TelegraphResponseIntegrityError("Telegraph returned 200 without a signal_hash");
      },
    });
    const task = await createdTask("goal ten", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(dep.calls.ask).toBe(1); // NEVER re-sent: an uncertain paid outcome must not double-charge
    expect(done.error).toMatch(/200 without a/);
  });

  it("does not retry budget or credential refusals", async () => {
    const dep = makeDeps({
      askAuto: async () => {
        throw new TelegraphBlockedError("credentials missing", ["TELEGRAPH_EVM_PRIVATE_KEY"]);
      },
    });
    const task = await createdTask("goal eleven", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("blocked");
    expect(dep.calls.ask).toBe(1);
    const blockedEvent = done.events.find((e) => e.type === "task_blocked");
    expect(blockedEvent?.data).toMatchObject({ missingEnvKeys: ["TELEGRAPH_EVM_PRIVATE_KEY"] });
  });

  it("classifies an unknown protocol error and stops without pointless retries", async () => {
    const dep = makeDeps({
      askAuto: async () => {
        throw new Error("HTTP 400 request rejected: malformed");
      },
    });
    const task = await createdTask("goal twelve", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(dep.calls.ask).toBe(1); // deterministic error — not retried
  });
});

describe("criteria-based verification", () => {
  it("fails the goal when the on-chain settlement is not mined", async () => {
    const dep = makeDeps({
      getReceipt: async () => ({ ...SETTLED, found: false, status: "not_found", blockNumber: null }),
    });
    const task = await createdTask("goal thirteen", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.result).toBeNull();
    expect(done.error).toMatch(/not confirmed on-chain/);
    expect(done.events.map((e) => e.type)).toContain("criteria_failed");
  });

  it("fails the goal when the purchased answer is implausible (non-positive price)", async () => {
    const badAnswer = { data: { amount: "-3", base: "BTC", currency: "USD" } };
    const dep = makeDeps({
      askAuto: async () => ({ ...GOOD_ANSWER, answer: badAnswer }),
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: badAnswer,
        signal: { created_at: new Date().toISOString() },
      }),
    });
    const task = await createdTask("goal fourteen", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.result).toBeNull();
    expect(done.error).toMatch(/plausible|positive finite/);
  });

  it("fails the goal when the answer is stale beyond the criterion", async () => {
    const dep = makeDeps({
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: GOOD_ANSWER.answer,
        signal: { created_at: new Date(Date.now() - 3600_000).toISOString() }, // 1h old, limit 600s
      }),
    });
    const task = await createdTask("goal fifteen", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/fresh/);
  });

  it("never completes when execution produced no signal hash", async () => {
    const dep = makeDeps({
      askAuto: async () => ({ ...GOOD_ANSWER, signalHash: null, receipt: null }),
    });
    const task = await createdTask("goal sixteen", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.result).toBeNull();
  });

  it("completes on chain-read settlement even when a miner misclaims the tx is not found", async () => {
    // Real live case: a paid miner claimed "transaction not found" while the
    // public RPC recorded success. Verification reads the chain itself.
    const notFoundAnswer: Record<string, unknown> = {
      answer: "transaction not found",
      resolved: false,
      error: "TX_NOT_FOUND",
    };
    const dep = makeDeps({
      // The miner's claim — that the settlement tx does not exist — is what the
      // agent bought. The node corroborates the miner (record == delivered).
      askAuto: async () => {
        return { ...GOOD_ANSWER, answer: notFoundAnswer };
      },
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: notFoundAnswer,
        signal: { created_at: new Date().toISOString() },
      }),
      // Independent truth: the public chain RPC shows the tx was mined successfully.
      getReceipt: async () => ({ ...SETTLED }),
    });
    const task = await createdTask("goal seventeen", true);
    const done = await approveTask(task.id, dep);
    // The agent completes on verified evidence — the answer matched its
    // commitment AND the settlement was read directly from the chain, which is
    // exactly how the live testnet run behaved (miner's claim was wrong,
    // chain was right, and the agent said so explicitly).
    expect(done.state).toBe("completed");
  });

  it("blocks without fake success when paid inference is not configured", async () => {
    const noop = defaultDeps();
    noop.telegraph.askAuto = async () => {
      throw new TelegraphBlockedError(
        "Telegraph paid inference is not configured: the task would require an X402 payment.",
        ["TELEGRAPH_EVM_PRIVATE_KEY"],
      );
    };
    const task = await createdTask("goal eighteen", true);
    const done = await approveTask(task.id, noop);
    expect(done.state).toBe("blocked");
    expect(done.result).toBeNull();
  });
});

describe("verification module (unit)", () => {
  it("throws rather than completing without evidence even when the plan says verify", async () => {
    const dep = makeDeps({});
    const task = await createdTask("goal nineteen", true);
    task.state = "executing";
    const outputs: ExecutionOutputs = {};
    await expect(verifyTask(task, outputs, dep)).rejects.toThrow(/no verifiable evidence/);
    expect(task.result).toBeNull();
  });

  it("records evidence and a summary when every criterion checks out", async () => {
    const dep = makeDeps({});
    const task = await createdTask("goal twenty", true);
    task.state = "executing";
    const outputs: ExecutionOutputs = { primary: GOOD_ANSWER, settlement: { txHash: "0xtx123", ...SETTLED } };
    await verifyTask(task, outputs, dep);
    expect(task.result!.evidence.map((e) => e.kind)).toEqual([
      "telegraph_signal",
      "telegraph_receipt",
      "on_chain_settlement",
    ]);
    expect(task.result!.summary).toContain("alchemy-price-fake");
  });

  it("sanity-checks that BudgetExceededError is an Error subclass", () => {
    expect(new BudgetExceededError("x")).toBeInstanceOf(Error);
  });

  it("extracts the transfer cost but never an unrelated eth_price_usd field", async () => {
    const { extractUsdCost, extractGasGwei } = await import("@/lib/engine/planner");
    expect(
      extractUsdCost({
        data: { chain: "base", gas_price_gwei: "0.05", eth_price_usd: "2346.8", usd_cost_21000: "0.0011" },
      }),
    ).toBeCloseTo(0.0011);
    expect(extractUsdCost({ data: { chain: "base", eth_price_usd: "2346.8" } })).toBeNull();
    expect(extractUsdCost({ data: { chain: "base", cost_usd_21000: "0.0012" } })).toBeCloseTo(0.0012);
    expect(extractUsdCost({ data: { chain: "base", fee_usd_transfer: "0.0021" } })).toBeCloseTo(0.0021);
    expect(extractGasGwei({ a: { gasPriceGwei: 1.2 }, b: { foo: 3 } })).toBeCloseTo(1.2);
    expect(extractGasGwei({ price_usd: 4 })).toBeNull();
  });
});

describe("goal-specific verification", () => {
  it("completes a gas goal when purchased telemetry agrees with our own chain read", async () => {
    const gasAnswer: TelegraphAnswer = {
      answer: { data: { chain: "base", gas_price_gwei: "0.050", usd_cost_21000: "0.0010" } },
      minerId: "5",
      minerName: "gas-fake",
      costUsd: 0.01,
      signalHash: "0xgasignal",
      receipt: { ...GOOD_ANSWER.receipt!, intent: "GAS_PRICE" },
    };
    const dep = makeDeps({
      askAuto: async () => ({ ...gasAnswer }),
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: gasAnswer.answer,
        signal: { created_at: new Date().toISOString() },
      }),
      getReceipt: async () => ({ ...SETTLED }),
      getGasPrice: async () => ({ chain: "base", gasPriceWei: 50_000_000, gasPriceGwei: 0.052, rpcUrl: "https://fake-rpc" }),
    });
    const task = await createdTask("Is gas on Base right now under $0.05 for a 21000-gas transfer?", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("completed");
    expect(dep.calls.chain).toBe(2); // settlement read + gas cross-check
    const kinds = done.result!.evidence.map((e) => e.kind);
    expect(kinds).toContain("chain_gas_crosscheck");
  });

  it("fails a gas goal when the purchased telemetry disagrees with the chain read", async () => {
    const gasAnswer: TelegraphAnswer = {
      answer: { data: { chain: "base", gas_price_gwei: "50" } },
      minerId: "5",
      minerName: "gas-fake",
      costUsd: 0.01,
      signalHash: "0xgasignal",
      receipt: { ...GOOD_ANSWER.receipt!, intent: "GAS_PRICE" },
    };
    const dep = makeDeps({
      askAuto: async () => ({ ...gasAnswer }),
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: gasAnswer.answer,
        signal: { created_at: new Date().toISOString() },
      }),
      getReceipt: async () => ({ ...SETTLED }),
      getGasPrice: async () => ({ chain: "base", gasPriceWei: 3_000_000_000, gasPriceGwei: 3, rpcUrl: "https://fake-rpc" }),
    });
    const task = await createdTask("Is gas on Base right now under $0.05 for a 21000-gas transfer?", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/disagrees with our own chain read/);
    expect(done.result).toBeNull();
  });

  it("fails a gas goal whose answer carries no gas figure to cross-check", async () => {
    const gasAnswer: TelegraphAnswer = {
      answer: { data: { chain: "base", note: "gas is fine" } },
      minerId: "5",
      minerName: "gas-fake",
      costUsd: 0.01,
      signalHash: "0xgasignal",
      receipt: { ...GOOD_ANSWER.receipt!, intent: "GAS_PRICE" },
    };
    const dep = makeDeps({
      askAuto: async () => ({ ...gasAnswer }),
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: gasAnswer.answer,
        signal: { created_at: new Date().toISOString() },
      }),
      getReceipt: async () => ({ ...SETTLED }),
      getGasPrice: async () => ({ chain: "base", gasPriceWei: 50_000_000, gasPriceGwei: 0.05, rpcUrl: "https://fake-rpc" }),
    });
    const task = await createdTask("Is gas on Base right now under $0.05 for a 21000-gas transfer?", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/generic lookup|gwei/);
  });

  it("fails a gas goal whose cost threshold is not met by the purchased answer's evidence", async () => {
    const gasAnswer: TelegraphAnswer = {
      answer: { data: { chain: "base", gas_price_gwei: "0.05", usd_cost_21000: "0.20" } },
      minerId: "5",
      minerName: "gas-fake",
      costUsd: 0.01,
      signalHash: "0xgasignal",
      receipt: { ...GOOD_ANSWER.receipt!, intent: "GAS_PRICE" },
    };
    const dep = makeDeps({
      askAuto: async () => ({ ...gasAnswer }),
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: gasAnswer.answer,
        signal: { created_at: new Date().toISOString() },
      }),
      getReceipt: async () => ({ ...SETTLED }),
      getGasPrice: async () => ({ chain: "base", gasPriceWei: 50_000_000, gasPriceGwei: 0.05, rpcUrl: "https://fake-rpc" }),
    });
    const task = await createdTask("Is gas on Base right now under $0.05 for a 21000-gas transfer?", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/goal's requirement of under \$0\.05|NOT achieved/);
  });

  it("fails a price goal whose answer is about the wrong asset", async () => {
    const wrongAsset = { data: { amount: "3000.00", base: "SOL", currency: "USD" } };
    const dep = makeDeps({
      askAuto: async () => ({ ...GOOD_ANSWER, answer: wrongAsset }),
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: wrongAsset,
        signal: { created_at: new Date().toISOString() },
      }),
    });
    const task = await createdTask("What is the BTC price in USD?", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/not about the requested asset/);
  });

  it("whenever a priced attempt never delivers, the ledger flags it as uncertain instead of silently zero", async () => {
    let n = 0;
    const dep = makeDeps({
      askAuto: async (o) => {
        n++;
        if (n === 1) {
          // Settled-challenge scenario: priced, then routing failed.
          o.onChallenge?.({ amountUsdCents: 1 });
          throw new Error("HTTP 502 request failed");
        }
        o.onChallenge?.({ amountUsdCents: 1 });
        return { ...GOOD_ANSWER };
      },
    });    const task = await createdTask("goal twenty-one", true);
    const done = await approveTask(task.id, dep);
    expect(done.state).toBe("completed");
    const flagged = done.events.find((e) => e.type === "criteria_check_passed" && /uncertain|uncollectable|priced attempt/i.test(e.message),
    );
    expect(flagged).toBeDefined();
    expect(done.spend.spentUsdCents).toBe(1); // only the delivered answer is accounted
  });
});
