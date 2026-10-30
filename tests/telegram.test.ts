import { beforeEach, describe, expect, it } from "vitest";

import { handleUpdate, type TelegramDeps, type TgUpdate } from "@/lib/telegram/adapter";
import { resetSeenUpdates } from "@/lib/telegram/offsets";
import { resetStore, listTasks } from "@/lib/engine/store";
import { createTask, type EngineDeps } from "@/lib/engine/engine";

/* Local fakes. */
const GOOD_ANSWER = {
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

function makeBot(overrides: {
  askAuto?: EngineDeps["telegraph"]["askAuto"];
  getReceipt?: EngineDeps["chain"]["getReceipt"];
  getGasPrice?: EngineDeps["chain"]["getGasPrice"];
  fetchJSON?: EngineDeps["publicSource"]["fetchJSON"];
} = {}): TelegramDeps & { calls: { ask: number; create: number }; sent: Array<{ chat: unknown; text: string }> } {
  const calls = { ask: 0, create: 0 };
  const sent: Array<{ chat: unknown; text: string }> = [];
  const engine: EngineDeps = {
    publicSource: {
      fetchJSON: async (url: string) => {
        if (overrides.fetchJSON) return overrides.fetchJSON(url);
        throw new Error("unexpected public source read in this telegram test: " + url);
      },
    },
    telegraph: {
      askAuto: async (o) => {
        calls.ask++;
        return overrides.askAuto ? overrides.askAuto(o) : { ...GOOD_ANSWER };
      },
      lookupSignal: async (h) => ({
        signal_hash: h,
        result: GOOD_ANSWER.answer,
        signal: { created_at: new Date().toISOString() },
      }),
    },
    chain: {
      getReceipt: async (h) =>
        overrides.getReceipt
          ? overrides.getReceipt(h)
          : { found: true, status: "success", blockNumber: 123, to: "0xm", rpcUrl: "https://fake-rpc" },
      getGasPrice: async () =>
        overrides.getGasPrice
          ? overrides.getGasPrice("base")
          : { chain: "base", gasPriceWei: 50_000_000, gasPriceGwei: 0.05, rpcUrl: "https://fake-rpc" },
    },
    now: () => Date.now(),
  };
  return {
    calls,
    sent,
    engine,
    send: async (chat, text) => {
      sent.push({ chat, text });
    },
  };
}

function updateOf(id: number, text: string): TgUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id: 42 },
      from: { id: 42, username: "tester" },
      text,
    },
  };
}

beforeEach(async () => {
  resetStore();
  await resetSeenUpdates();
});

describe("telegram adapter", () => {
  it("processes a duplicate update only once (no second send, no second task)", async () => {
    const bot = makeBot({});
    await handleUpdate(updateOf(1001, "/tasks"), bot);
    const afterFirst = bot.sent.length;
    await handleUpdate(updateOf(1001, "/tasks"), bot); // same update_id redelivered
    expect(bot.sent.length).toBe(afterFirst);
  });

  it("answers /goal with FREE sources: no purchase attempt, $0 spend", async () => {
    let askCalls = 0;
    const bot = makeBot({
      askAuto: async () => {
        askCalls++;
        return { ...GOOD_ANSWER };
      },
      fetchJSON: async () => ({ bitcoin: { usd: 61000 } }),
    });
    await handleUpdate(updateOf(2001, "/goal What is the current BTC price in USD?"), bot);
    expect(askCalls).toBe(0); // /goal NEVER initiates a paid request
    expect(bot.sent.some((s) => s.text.includes("Completed"))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("$61000"))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("Spent: $0.00"))).toBe(true);
  });

  it("refuses /goal questions with no free capability instead of paying, and names the paid alternative", async () => {
    let askCalls = 0;
    const bot = makeBot({
      askAuto: async () => {
        askCalls++;
        return { ...GOOD_ANSWER };
      },
    });
    await handleUpdate(updateOf(2002, "/goal Summarize the latest research discussion in the governance forum"), bot);
    expect(askCalls).toBe(0); // nothing was ever paid or even requested
    expect(bot.sent.some((s) => /BLOCKED/.test(s.text))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("No free capability"))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("paid mode"))).toBe(true);
  });

  it("paid Telegraph research requires the EXPLICIT /paid command and a second /approve", async () => {
    let askCalls = 0;
    const bot = makeBot({
      askAuto: async () => {
        askCalls++;
        return { ...GOOD_ANSWER };
      },
    });
    // An ordinary goal never starts paid work, even for a question without a free answer:
    await handleUpdate(updateOf(2010, "/goal Summarize the latest research discussion in the governance forum"), bot);
    expect(askCalls).toBe(0);
    // The explicit /paid command creates a PAID task awaiting confirmation...
    const before = bot.calls.create;
    await handleUpdate(updateOf(2001, "/paid Summarize the latest research discussion in the governance forum"), bot);
    expect(askCalls).toBe(0); // still nothing spent
    expect(bot.sent.some((s) => s.text.includes("PAID task awaiting"))).toBe(true);
    // classify: the created task is awaiting_approval and identifiably paid
    const created = (await listTasks()).find(
      (t) => t.origin.source === "telegram" && t.state === "awaiting_approval",
    );
    expect(created).toBeDefined();
    expect((created!.plan ?? []).some((s) => s.kind === "telegraph_ask")).toBe(true);
    // ...and ONLY /approve starts the purchase.
    await handleUpdate(updateOf(2003, `/approve ${created!.id.slice(0, 8)}`), bot);
    expect(askCalls).toBe(1);
    expect(bot.sent.some((s) => s.text.includes("Completed"))).toBe(true);
  });

  it("never creates a second purchase for redelivered /paid updates", async () => {
    let askCalls = 0;
    const bot = makeBot({
      askAuto: async () => {
        askCalls++;
        return { ...GOOD_ANSWER };
      },
    });
    await handleUpdate(updateOf(2001, "/paid Summarize the latest research discussion in the governance forum"), bot);
    const created = (await listTasks()).find(
      (t) => t.origin.source === "telegram" && t.state === "awaiting_approval",
    );
    expect(created).toBeDefined();
    const afterFirst = askCalls; // 0
    await handleUpdate(updateOf(2001, "/paid Summarize the latest research discussion in the governance forum"), bot);
    expect(askCalls).toBe(afterFirst); // duplicate delivery → zero new purchases
    const beforeApprove = askCalls;
    await handleUpdate(updateOf(2004, `/approve ${created!.id.slice(0, 8)}`), bot);
    expect(askCalls).toBe(beforeApprove + 1);
    await handleUpdate(updateOf(2004, `/approve ${created!.id.slice(0, 8)}`), bot);
    expect(askCalls).toBe(beforeApprove + 1); // redelivered approval → no second purchase
  });

  it("runs /approve end to end through the same engine", async () => {
    const bot = makeBot({});
    const task = await createTask(
      { goal: "What is the BTC price in USD?", spendLimitUsdCents: 10, requiresApproval: true, origin: { source: "telegram", actor: "@tester" }, mode: "paid" },
      bot.engine,
    );
    const prefix = task.id.slice(0, 8);
    await handleUpdate(updateOf(3001, `/approve ${prefix}`), bot);
    const reviewed = await (await import("@/lib/engine/store")).getTask(task.id);
    expect(reviewed?.state).toBe("completed");
    expect(bot.sent.some((s) => s.text.includes("informational answer delivered, verified against recorded evidence"))).toBe(true);
  });

  it("runs /reject without any purchase", async () => {
    const bot = makeBot({});
    const task = await createTask(
      { goal: "Anything at all", spendLimitUsdCents: 10, requiresApproval: true, origin: { source: "telegram", actor: "@tester" } },
      bot.engine,
    );
    await handleUpdate(updateOf(3002, `/reject ${task.id.slice(0, 8)}`), bot);
    const reviewed = await (await import("@/lib/engine/store")).getTask(task.id);
    expect(reviewed?.state).toBe("rejected");
    expect(bot.calls.ask).toBe(0);
  });

  it("/status reaches a task by id prefix", async () => {
    const bot = makeBot({});
    const task = await createTask(
      { goal: "Idle task", spendLimitUsdCents: 10, requiresApproval: true, origin: { source: "telegram", actor: "@tester" } },
      bot.engine,
    );
    await handleUpdate(updateOf(3003, `/status ${task.id.slice(0, 8)}`), bot);
    expect(bot.sent.some((s) => s.text.includes("AWAITING_APPROVAL"))).toBe(true);
  });

  it("reports an execution goal honestly on Telegram: blocked, nothing spent, no completion claim", async () => {
    // The real bug: "swap to BTC or ETH" returned swap advice and claimed
    // "Completed. Every success criterion was verified against real evidence."
    const bot = makeBot({});
    await handleUpdate(updateOf(4001, "/goal swap to BTC or ETH"), bot);
    expect(bot.calls.ask).toBe(0);
    expect(bot.sent.some((s) => /BLOCKED/.test(s.text))).toBe(true);
    expect(bot.sent.some((s) => /no wallet, exchange or deployment integration|not supported yet/i.test(s.text))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("Completed"))).toBe(false);
    // and the offer of an alternative framing exists
    expect(bot.sent.some((s) => s.text.includes("preparation"))).toBe(true);
  });

  it("reports a failed task as FAILED with its spend, never as completed", async () => {
    const bot = makeBot({
      getReceipt: async () => ({ found: false, status: "not_found" as const, blockNumber: null, to: null, rpcUrl: "https://fake-rpc" }),
    });
    const task = await createTask(
      { goal: "What is the BTC price in USD?", spendLimitUsdCents: 10, requiresApproval: true, origin: { source: "telegram", actor: "@tester" }, mode: "paid" },
      bot.engine,
    );
    await handleUpdate(updateOf(5001, `/approve ${task.id.slice(0, 8)}`), bot);
    expect(bot.sent.some((s) => s.text.includes("FAILED"))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("Completed"))).toBe(false);
    expect(bot.sent.some((s) => s.text.includes("Spent: $0.01"))).toBe(true);
  });
});
