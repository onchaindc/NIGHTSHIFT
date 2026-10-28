import { beforeEach, describe, expect, it } from "vitest";

import { handleUpdate, type TelegramDeps, type TgUpdate } from "@/lib/telegram/adapter";
import { resetSeenUpdates } from "@/lib/telegram/offsets";
import { resetStore } from "@/lib/engine/store";
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
} = {}): TelegramDeps & { calls: { ask: number; create: number }; sent: Array<{ chat: unknown; text: string }> } {
  const calls = { ask: 0, create: 0 };
  const sent: Array<{ chat: unknown; text: string }> = [];
  const engine: EngineDeps = {
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

beforeEach(() => {
  resetStore();
  resetSeenUpdates();
});

describe("telegram adapter", () => {
  it("processes a duplicate update only once (no second send, no second task)", async () => {
    const bot = makeBot({});
    await handleUpdate(updateOf(1001, "/tasks"), bot);
    const afterFirst = bot.sent.length;
    await handleUpdate(updateOf(1001, "/tasks"), bot); // same update_id redelivered
    expect(bot.sent.length).toBe(afterFirst);
  });

  it("never creates a second purchase for the same /goal delivery", async () => {
    let askCalls = 0;
    const bot = makeBot({
      askAuto: async () => {
        askCalls++;
        return { ...GOOD_ANSWER };
      },
    });
    await handleUpdate(updateOf(2001, "/goal What is the BTC price in USD?"), bot);
    expect(bot.sent.some((s) => s.text.includes("Completed"))).toBe(true);
    const afterFirst = askCalls;
    await handleUpdate(updateOf(2001, "/goal What is the BTC price in USD?"), bot);
    expect(askCalls).toBe(afterFirst); // duplicate delivery → zero new purchases
    expect(askCalls).toBe(1);
  });

  it("runs /approve end to end through the same engine", async () => {
    const bot = makeBot({});
    const task = await createTask(
      { goal: "What is the BTC price in USD?", spendLimitUsdCents: 10, requiresApproval: true, origin: { source: "telegram", actor: "@tester" } },
      bot.engine,
    );
    const prefix = task.id.slice(0, 8);
    await handleUpdate(updateOf(3001, `/approve ${prefix}`), bot);
    const reviewed = await (await import("@/lib/engine/store")).getTask(task.id);
    expect(reviewed?.state).toBe("completed");
    expect(bot.sent.some((s) => s.text.includes("Completed. Every success criterion was verified"))).toBe(true);
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
});
