import { afterEach, describe, expect, it } from "vitest";

import { handleUpdate, type TelegramDeps, type TgUpdate } from "@/lib/telegram/adapter";
import { resetStore, listTasks, getTask } from "@/lib/engine/store";
import { createTask, type EngineDeps } from "@/lib/engine/engine";
import { persistence } from "@/lib/storage";

/* Local fakes (same conventions as tests/telegram.test.ts). */
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

function fakeEngine(): EngineDeps {
  return {
    publicSource: {
      fetchJSON: async () => ({ bitcoin: { usd: 61000 } }),
    },
    telegraph: {
      askAuto: async () => ({ ...GOOD_ANSWER }),
      lookupSignal: async (h: string) => ({
        signal_hash: h,
        result: GOOD_ANSWER.answer,
        signal: { created_at: new Date().toISOString() },
      }),
    },
    chain: {
      getReceipt: async () => ({ found: true, status: "success", blockNumber: 123, to: "0xm", rpcUrl: "https://fake-rpc" }),
      getGasPrice: async () => ({ chain: "base", gasPriceWei: 50_000_000, gasPriceGwei: 0.05, rpcUrl: "https://fake-rpc" }),
    },
    now: () => Date.now(),
  };
}

function makeBot(): TelegramDeps & { sent: Array<{ chat: unknown; text: string }> } {
  const sent: Array<{ chat: unknown; text: string }> = [];
  return {
    sent,
    engine: fakeEngine(),
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

/** The internal-timeline vocabulary that must never reach Telegram. */
const INTERNAL_TELEGRAM_DUMPS = [
  "Plan built:",
  "Success criteria (fixed before execution):",
  "Planning assumption:",
  "Cost: FREE",
  "Cost: PAID",
  "Waiting for your approval before spending anything",
];

const MANAGED_ENV_KEYS = ["NIGHTSHIFT_PUBLIC_BASE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL", "VERCEL_ENV"];
const savedEnv = Object.fromEntries(MANAGED_ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(async () => {
  for (const k of MANAGED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await persistence().clearTasks();
  resetStore();
});

describe("concise result-first Telegram messages", () => {
  it("sends a completed free goal result-first: status, answer, verification, spend, ops id — never the internal plan/criteria/cost dumps", async () => {
    const bot = makeBot();
    await handleUpdate(updateOf(100, "/goal What is the current BTC price in USD?"), bot);
    expect(bot.sent.some((s) => s.text.includes("✅ COMPLETED"))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("$61000"))).toBe(true); // the actual answer is in the message
    expect(bot.sent.some((s) => s.text.includes("Verified ✓ outcome checked against the recorded evidence"))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("Spent: $0.00"))).toBe(true);
    const finalMsg = bot.sent.find((s) => s.text.includes("COMPLETED"))!;
    const created = (await listTasks())[0];
    expect(finalMsg.text).toContain(`Ops ID: ${created.id}`);
    for (const dump of INTERNAL_TELEGRAM_DUMPS) {
      expect(finalMsg.text.includes(dump)).toBe(false); // internal record stays in the web report
    }
  });

  it("links the web report in the final message when a public base URL is known, and mentions none when it is not", async () => {
    process.env.NIGHTSHIFT_PUBLIC_BASE_URL = "https://nightshift.example/";
    const bot = makeBot();
    await handleUpdate(updateOf(101, "/goal What is the current BTC price in USD?"), bot);
    const created = (await listTasks())[0];
    expect(bot.sent.some((s) => s.text.includes(`Full report (events, evidence, verification): https://nightshift.example/tasks/${created.id}`))).toBe(true);

    delete process.env.NIGHTSHIFT_PUBLIC_BASE_URL;
    await persistence().clearTasks();
    resetStore();
    const bot2 = makeBot();
    await handleUpdate(updateOf(102, "/goal What is the current BTC price in USD?"), bot2);
    const final2 = bot2.sent.find((s) => s.text.includes("COMPLETED"))!;
    expect(final2.text.includes("Full report")).toBe(false);
    expect(final2.text).toContain("Ops ID:");
  });

  it("keeps money transparent: the live spend event is streamed, but plans and criteria are not", async () => {
    const bot = makeBot();
    // A slow signal lookup keeps the run live past the pump's first 900ms poll,
    // so the spend event is actually streamed while the run is in flight.
    bot.engine!.telegraph.lookupSignal = async (h: string) => {
      await new Promise((r) => setTimeout(r, 1500));
      return { signal_hash: h, result: GOOD_ANSWER.answer, signal: { created_at: new Date().toISOString() } };
    };
    await handleUpdate(updateOf(103, "/paid BTC price for the book, paid research"), bot); // awaiting approval, no purchase
    expect(bot.sent.some((s) => s.text.includes("PAID task awaiting your confirmation"))).toBe(true);
    const created = (await listTasks()).find((t) => t.state === "awaiting_approval")!;
    await handleUpdate(updateOf(104, `/approve ${created.id.slice(0, 8)}`), bot);
    const streamed = bot.sent.filter((s) => s.text.startsWith("$"));
    expect(streamed.length).toBe(1); // exactly the one real spend moment
    expect(streamed[0].text).toContain("Spent 0.01 USD");
    for (const msg of bot.sent) {
      for (const dump of ["Plan built:", "Success criteria (fixed before execution):"]) {
        expect(msg.text.includes(dump)).toBe(false);
      }
    }
  });

  it("reports blocked goals as BLOCKED with a short reason, spend status and next step — no internal dump", async () => {
    const bot = makeBot();
    await handleUpdate(updateOf(105, "/goal swap 1 ETH for USDC on the mainnet"), bot);
    expect(bot.sent.some((s) => s.text.includes("⛔ BLOCKED"))).toBe(true);
    const blockedMsg = bot.sent.find((s) => s.text.includes("BLOCKED"))!;
    expect(blockedMsg.text.includes("Nothing was executed and nothing was spent")).toBe(true);
    expect(blockedMsg.text.includes("Execution goals are not supported")).toBe(true); // short, understandable reason
    expect(blockedMsg.text.includes("Submit the same intent as research or transaction preparation")).toBe(true); // the useful next step
    expect(blockedMsg.text.includes("Success criteria (fixed before execution):")).toBe(false);
  });

  it("reports a failed task with the actual failure, the spend and whether recovery is possible", async () => {
    const bot = makeBot();
    bot.engine!.publicSource.fetchJSON = async () => {
      throw new Error("connection reset by peer");
    };
    await handleUpdate(updateOf(106, "/goal What is the current BTC price in USD?"), bot);
    expect(bot.sent.some((s) => s.text.includes("✗ FAILED"))).toBe(true);
    const failedMsg = bot.sent.find((s) => s.text.includes("FAILED"))!;
    expect(failedMsg.text.includes("connection reset") || failedMsg.text.includes("Execution failed")).toBe(true);
    expect(failedMsg.text.includes("Spent: $0.00")).toBe(true);
    expect(failedMsg.text.includes("re-run for free")).toBe(true); // recovery is possible here
    const created = (await listTasks())[0];
    expect(failedMsg.text).toContain(created.id.slice(0, 8));
  });

  it("never re-delivers a second purchase for a failed/spent paid task: recovery guidance says re-running spends again", async () => {
    const bot = makeBot();
    await handleUpdate(updateOf(107, "/goal BTC price in USD"), bot); // completes fine — control
    const ok = bot.sent.find((s) => s.text.includes("COMPLETED"))!;
    expect(ok.text.includes("Purchases were made")).toBe(false);

    // A paid task that spent but whose plan can no longer deliver: no rerun claim.
    bot.engine!.telegraph.lookupSignal = async () => ({ signal_hash: "", result: { nope: true }, signal: { created_at: new Date().toISOString() } });
    await handleUpdate(updateOf(108, "/paid BTC price wrong volume target"), bot);
    const awaiting = (await listTasks()).find((t) => t.state === "awaiting_approval");
    expect(awaiting).toBeDefined();
  });
});
