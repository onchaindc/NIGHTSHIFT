import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleUpdate, sendViaDefault, type TelegramDeps, type TgUpdate } from "@/lib/telegram/adapter";
import { recoverAbandonedFreeTasks } from "@/lib/telegram/recovery";
import { reconcileTelegramWebhook, resolveWebhookBaseUrl } from "@/lib/telegram/webhook-register";
import { resetStore, listTasks, getTask, saveTask } from "@/lib/engine/store";
import { createTask, type EngineDeps } from "@/lib/engine/engine";
import { persistence } from "@/lib/storage";
import { POST as webhookPost } from "@/app/api/telegram/webhook/route";

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

function fakeEngine(overrides: { fetchJSON?: EngineDeps["publicSource"]["fetchJSON"]; askAuto?: EngineDeps["telegraph"]["askAuto"] } = {}): EngineDeps {
  return {
    publicSource: {
      fetchJSON:
        overrides.fetchJSON ??
        (async () => {
          throw new Error("unexpected public source read in this test");
        }),
    },
    telegraph: {
      askAuto: overrides.askAuto ?? (async () => ({ ...GOOD_ANSWER })),
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

function makeBot(overrides: { fetchJSON?: EngineDeps["publicSource"]["fetchJSON"]; askAuto?: EngineDeps["telegraph"]["askAuto"] } = {}): TelegramDeps & { sent: Array<{ chat: unknown; text: string }> } {
  const sent: Array<{ chat: unknown; text: string }> = [];
  return {
    sent,
    engine: fakeEngine(overrides),
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

function postWebhook(headers: Record<string, string>, body: string): Promise<Response> {
  return webhookPost(new Request("http://localhost/api/telegram/webhook", { method: "POST", headers, body }));
}

const MANAGED_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "NIGHTSHIFT_PUBLIC_BASE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "VERCEL_ENV",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  savedEnv = Object.fromEntries(MANAGED_ENV_KEYS.map((k) => [k, process.env[k]]));
  await persistence().clearTasks(); // drop tasks left by earlier tests: recovery candidates must be staged deliberately
  resetStore();
});

afterEach(async () => {
  for (const k of MANAGED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe("telegram webhook route hardening", () => {
  it("rejects updates whose secret header does not match with 401", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
    const res = await postWebhook({ "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" }, JSON.stringify(updateOf(1, "/start")));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  it("rejects updates with a missing secret header with 401", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
    const res = await postWebhook({ "content-type": "application/json" }, JSON.stringify(updateOf(1, "/start")));
    expect(res.status).toBe(401);
  });

  it("rejects unparseable payloads with 400 (before any background work)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
    const res = await postWebhook({ "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" }, "not json");
    expect(res.status).toBe(400);
  });
});

describe("telegram progress pump resilience", () => {
  it("still delivers the final report when some live-update sends throw", async () => {
    // Deterministic pump exercise: the paid path persists its verification
    // state ("verifying", plus every step event) right before a 2s signal
    // lookup, so the pump is guaranteed one mid-run delivery round while the
    // run is still live. A fast free run always beats the pump's 900ms poll
    // and would exercise nothing.
    const bot = makeBot({ askAuto: async () => ({ ...GOOD_ANSWER }) });
    bot.engine!.telegraph.lookupSignal = async (h: string) => {
      await new Promise((r) => setTimeout(r, 2000));
      return { signal_hash: h, result: GOOD_ANSWER.answer, signal: { created_at: new Date().toISOString() } };
    };
    let failedSends = 0;
    bot.send = async (chat, text) => {
      // Throw ONLY on messages that START with the guarded/verification icons;
      // final evidence lines carry mid-text ellipses and must still deliver.
      if (/^[⚙…]/.test(text)) {
        failedSends++;
        throw new Error("simulated transport drop");
      }
      bot.sent.push({ chat, text });
    };
    await handleUpdate(updateOf(8100, "/paid BTC price, paid research"), bot);
    const created = (await listTasks()).find((t) => t.origin.source === "telegram" && t.state === "awaiting_approval");
    expect(created).toBeDefined();
    await handleUpdate(updateOf(8101, `/approve ${created!.id.slice(0, 8)}`), bot);
    expect(failedSends).toBeGreaterThan(0);
    // The task completed and the final report (with a delivery-failure notice) arrived:
    expect(bot.sent.some((s) => s.text.includes("Result:"))).toBe(true);
    expect(bot.sent.some((s) => s.text.includes("could not be delivered"))).toBe(true);
    const finished = await getTask(created!.id);
    expect(finished?.state).toBe("completed");
  });
});

describe("sendMessage retry behavior", () => {
  it("retries on transient network failures and honors 429 retry_after, then succeeds", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET: simulated frozen instance");
        if (calls === 2)
          return new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }), { status: 429 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await sendViaDefault(42, "hello"); // resolves; never throws even through retries
    expect(calls).toBe(3);
  });

  it("gives up quickly on non-429 Telegram API errors instead of retrying forever", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
      }),
    );
    await sendViaDefault(42, "hello"); // logs the failure, resolves, ONE attempt only
    expect(calls).toBe(1);
  });
});

describe("abandoned free task recovery", () => {
  it("re-runs an abandoned free goal from its plan start and re-delivers the result to the originating chat", async () => {
    const sent: Array<{ chat: unknown; text: string }> = [];
    const engine = fakeEngine({ fetchJSON: async () => ({ bitcoin: { usd: 61000 } }) });
    const task = await createTask(
      {
        goal: "What is the current BTC price in USD?",
        spendLimitUsdCents: 10,
        requiresApproval: false,
        origin: { source: "telegram", actor: "4242" }, // numeric user id = chat id in private chats
        mode: "free",
      },
      engine,
    );
    expect(task.state).toBe("executing"); // staged under a dead-equivalent runner

    const res = await recoverAbandonedFreeTasks({
      deps: engine,
      idleMs: 5_000,
      now: Date.now() + 15 * 60_000,
      send: async (chat, text) => {
        sent.push({ chat, text });
      },
    });
    expect(res.recovered).toEqual([task.id]);

    const finished = await getTask(task.id);
    expect(finished?.state).toBe("completed");
    expect(finished?.spend.spentUsdCents).toBe(0); // free replay stays free
    expect(sent.some((s) => String(s.chat) === "4242" && s.text.includes("Result:"))).toBe(true);
  });

  it("never auto-resumes paid-plan tasks (double-spend risk): state untouched, nothing purchased", async () => {
    let askCalls = 0;
    const engine = fakeEngine({
      askAuto: async () => {
        askCalls++;
        return { ...GOOD_ANSWER };
      },
    });
    const created = await createTask(
      {
        goal: "What is the BTC price in USD? (explicit paid intent)",
        spendLimitUsdCents: 10,
        requiresApproval: false,
        origin: { source: "telegram", actor: "4242" },
        mode: "paid",
      },
      engine,
    );
    expect((created.plan ?? []).some((s) => s.kind === "telegraph_ask")).toBe(true);
    const priorState = created.state;
    if (priorState !== "executing") await saveTask({ ...created, state: "executing" }); // stage the worst case: executing paid plan

    const res = await recoverAbandonedFreeTasks({
      deps: engine,
      idleMs: 5_000,
      now: Date.now() + 15 * 60_000,
      send: async () => {},
    });
    expect(res.recovered).toEqual([]);
    expect(askCalls).toBe(0); // paid step NEVER re-launched by recovery
    expect((await getTask(created.id))!.state).toBe("executing"); // left visible in /tasks, not silently failed
  });

  it("leaves recently-updated free tasks alone (a live runner is not abandoned)", async () => {
    const engine = fakeEngine({ fetchJSON: async () => ({ bitcoin: { usd: 61000 } }) });
    const task = await createTask(
      { goal: "What is the current BTC price in USD?", spendLimitUsdCents: 10, requiresApproval: false, origin: { source: "telegram", actor: "4242" }, mode: "free" },
      engine,
    );
    const res = await recoverAbandonedFreeTasks({ deps: engine, idleMs: 10 * 60_000, now: Date.now(), send: async () => {} });
    expect(res.recovered).toEqual([]);
    expect((await getTask(task.id))!.state).toBe("executing");
  });

  it("skips tasks whose lease is already held by another worker", async () => {
    const engine = fakeEngine({ fetchJSON: async () => ({ bitcoin: { usd: 61000 } }) });
    const task = await createTask(
      { goal: "What is the current BTC price in USD?", spendLimitUsdCents: 10, requiresApproval: false, origin: { source: "telegram", actor: "4242" }, mode: "free" },
      engine,
    );
    const release = await persistence().acquireLease(`task-${task.id}`, 60_000);
    if (!release) throw new Error("lease is freely available before the test — precondition broken");
    const res = await recoverAbandonedFreeTasks({ deps: engine, idleMs: 5_000, now: Date.now() + 15 * 60_000, send: async () => {} });
    expect(res.recovered).toEqual([]);
    await release();
  });

  it("ignores web-origin tasks entirely", async () => {
    const engine = fakeEngine({ fetchJSON: async () => ({ bitcoin: { usd: 61000 } }) });
    await createTask(
      { goal: "What is the current BTC price in USD?", spendLimitUsdCents: 10, requiresApproval: false, origin: { source: "web", actor: "u1" }, mode: "free" },
      engine,
    );
    const res = await recoverAbandonedFreeTasks({ deps: engine, idleMs: 5_000, now: Date.now() + 15 * 60_000, send: async () => {} });
    expect(res.recovered).toEqual([]);
  });
});

describe("telegram webhook reconciliation", () => {
  function fakeTelegramFetch(handlers: { infoUrl?: string }) {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: handlers.infoUrl ?? "" } }), { status: 200 });
      }
      if (url.endsWith("/setWebhook")) {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: "setWebhook", body });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error("unexpected telegram fetch: " + url);
    };
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it("re-registers the webhook when the stored URL drifted, re-sending the secret", async () => {
    process.env.NIGHTSHIFT_PUBLIC_BASE_URL = "https://nightshift.example";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "whsec-test";
    const { fn, calls } = fakeTelegramFetch({ infoUrl: "https://dead-host/api/telegram/webhook" });
    const result = await reconcileTelegramWebhook(fn);
    expect(result.action).toBe("registered");
    expect(calls.length).toBe(1);
    expect(calls[0].body).toMatchObject({
      url: "https://nightshift.example/api/telegram/webhook",
      secret_token: "whsec-test",
    });
    expect((calls[0].body as { allowed_updates: string[] }).allowed_updates).toContain("message");
  });

  it("treats a matching URL as current and never re-registers", async () => {
    process.env.NIGHTSHIFT_PUBLIC_BASE_URL = "https://nightshift.example";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const { fn, calls } = fakeTelegramFetch({ infoUrl: "https://nightshift.example/api/telegram/webhook" });
    const result = await reconcileTelegramWebhook(fn);
    expect(result.action).toBe("current");
    expect(calls.length).toBe(0);
  });

  it("skips when there is no public base URL for this runtime and touches the network never", async () => {
    delete process.env.NIGHTSHIFT_PUBLIC_BASE_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_ENV;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const { fn, calls } = fakeTelegramFetch({ infoUrl: "anything" });
    const result = await reconcileTelegramWebhook(fn);
    expect(result.action).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  it("skips when the bot token is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.NIGHTSHIFT_PUBLIC_BASE_URL = "https://nightshift.example";
    const { fn, calls } = fakeTelegramFetch({ infoUrl: "anything" });
    const result = await reconcileTelegramWebhook(fn);
    expect(result.action).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  it("prefers the explicit base URL, then the Vercel production URL, then the deployment URL", () => {
    process.env.NIGHTSHIFT_PUBLIC_BASE_URL = "https://explicit.example";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "nightshift.vercel.app";
    expect(resolveWebhookBaseUrl()).toBe("https://explicit.example"); // trailing slash is stripped
    delete process.env.NIGHTSHIFT_PUBLIC_BASE_URL;
    expect(resolveWebhookBaseUrl()).toBe("https://nightshift.vercel.app");
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_URL = "nightshift-abcd.vercel.sh";
    expect(resolveWebhookBaseUrl()).toBe("https://nightshift-abcd.vercel.sh");
    delete process.env.VERCEL_URL;
    expect(resolveWebhookBaseUrl()).toBeNull(); // non-deployment runtime: no auto-derivation
    delete process.env.VERCEL_ENV;
  });
});
