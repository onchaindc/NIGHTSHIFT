import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTask, defaultDeps, runTask } from "@/lib/engine/engine";
import { getTask, saveTask } from "@/lib/engine/store";
import { MindsApiError, type MessageRecord, type MindsClient } from "@animocabrands/minds-client-lib";
import {
  awaitAndRecordMindReply,
  captureSendFingerprint,
  collectMindReply,
  receiveMindReply,
  resetMindsReceiveDeps,
  setMindsReceiveDeps,
  type MindsReceiveDeps,
} from "@/lib/mind/builder-receive";
import { MINDS_BUILDER_ENDPOINT, reportMessage } from "@/lib/mind/builder";
import { planMindInvestigation } from "@/lib/mind/plan";
import { resetMindDeps, setMindDeps } from "@/lib/mind/execute";
import {
  executeCapabilityAsk,
  executeCapabilityBaseline,
  executeCapabilityReport,
  resetCapabilityDeps,
  setCapabilityDeps,
} from "@/lib/mind/capability-execute";
import { planCapabilityRun } from "@/lib/minds/capability-plan";
import { CAPABILITIES } from "@/lib/minds/capabilities";
import { sampleParams } from "@/lib/minds/capability-runner";
import { COUNTERPARTY_INTENT, COUNTERPARTY_PRIMARY_MINER } from "@/lib/counterparty/intel";
import type { ProbeOutcome } from "@/lib/terminal/ask";
import type { TaskRecord } from "@/lib/engine/types";

/* ------------------------------------------------------------------ */
/* Doubles: a MindsClient speaking the documented interface            */
/* ------------------------------------------------------------------ */

const OFFER = {
  scheme: "exact" as const,
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e",
  amount: "10000",
};

const CHALLENGE: ProbeOutcome = {
  kind: "challenge",
  challenge: { accepts: [] },
  approvedOffer: OFFER,
  pricedOffer: { network: OFFER.network, asset: OFFER.asset, payTo: OFFER.payTo, amountCents: 1 },
  referencedUrl: "https://node/engine/v1/ask/x",
};

const probeChallenge = () => ({
  kind: "challenge" as const,
  spec: { intent: COUNTERPARTY_INTENT, params: { company: "Equinor ASA" }, minerId: COUNTERPARTY_PRIMARY_MINER },
  urlPath: `/engine/v1/ask/${COUNTERPARTY_PRIMARY_MINER}`,
  body: { intent: COUNTERPARTY_INTENT, params: { company: "Equinor ASA" } },
  approvedOffer: OFFER,
  priceUsd: 1.0,
});

function mindRow(fingerprint: string, messageText: string, senderType = 0): MessageRecord {
  return { fingerprint, senderType, messageText, createdAt: "2026-11-24T00:00:00Z", messageId: `msg-${fingerprint}` };
}

function fakeClient(overrides: Partial<MindsClient> = {}): MindsClient {
  return {
    getLatestHistoryFingerprint: vi.fn(async () => "fp-before"),
    waitForReply: vi.fn(async () => ({ timedOut: true }) as never),
    getHistory: vi.fn(async () => []),
    ensureConversation: vi.fn(async () => ({ conversationId: "c1", alias: "main", mindId: "mind-1" })),
    ...overrides,
  } as unknown as MindsClient;
}

function receiveDeps(client: MindsClient | null): MindsReceiveDeps {
  return { client: () => client, now: () => 1_700_000_000_000 };
}

function bareTask(): TaskRecord {
  return {
    id: "task-roundtrip",
    createdAt: 1,
    updatedAt: 1,
    state: "completed",
    goal: "investigate something",
    plan: [],
    events: [],
    spend: { limitUsdCents: 100, spentUsdCents: 0, entries: [] },
    permissions: { allowedActions: [], requiresApproval: false, maxRetries: 0 },
    criteria: {
      primaryVerifiedAgainstNodeSignal: false,
      answerSane: false,
      answerMaxAgeSeconds: 0,
      ownPaymentSettledOnChain: false,
      reconcileLedgerEntries: false,
    },
    result: { summary: "The investigation summary.", evidence: [], completedAt: 2 },
    error: null,
    origin: { source: "web" },
    jobType: "mind_investigation",
  };
}

const OK_SEND = { ok: true as const, detail: 'Minds accepted the report for alias "main" (HTTP 200)' };

const ENV_KEYS = ["MINDS_BUILDER_API_KEY", "MINDS_BUILDER_ALIAS", "MINDS_BUILDER_MIND_ID", "NIGHTSHIFT_API_TOKEN"];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.MINDS_BUILDER_API_KEY = "test-key";
  process.env.MINDS_BUILDER_ALIAS = "main";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetMindsReceiveDeps();
  resetMindDeps();
  resetCapabilityDeps();
});

/* ------------------------------------------------------------------ */
/* Receiving primitives (official client surface, injectable)          */
/* ------------------------------------------------------------------ */

describe("receiving primitives", () => {
  it("gates the fingerprint capture on the same environment as the send", async () => {
    delete process.env.MINDS_BUILDER_API_KEY;
    setMindsReceiveDeps(receiveDeps(fakeClient()));
    expect(await captureSendFingerprint("main")).toBeUndefined();
  });

  it("returns not_configured without a client and never calls the network", async () => {
    setMindsReceiveDeps(receiveDeps(null));
    expect(await captureSendFingerprint("main")).toBeUndefined();
    const outcome = await receiveMindReply({ alias: "main", sentMessageText: "x" });
    expect(outcome.status).toBe("not_configured");
    expect(outcome.detail).toContain("MINDS_BUILDER_API_KEY");
  });

  it("captures the pre-send fingerprint and binds the conversation when a Mind id is set", async () => {
    process.env.MINDS_BUILDER_MIND_ID = "mind-1";
    const client = fakeClient();
    setMindsReceiveDeps(receiveDeps(client));
    expect(await captureSendFingerprint("main")).toBe("fp-before");
    expect(client.ensureConversation).toHaveBeenCalledWith("main", "mind-1");
    expect(client.getLatestHistoryFingerprint).toHaveBeenCalledWith("main");
  });

  it("falls back to sentMessageText correlation when the fingerprint capture fails", async () => {
    setMindsReceiveDeps(
      receiveDeps(
        fakeClient({
          getLatestHistoryFingerprint: vi.fn(async () => {
            throw new Error("histories down");
          }),
        }),
      ),
    );
    expect(await captureSendFingerprint("main")).toBeUndefined();
  });

  it("maps a received waitForReply outcome to a typed reply", async () => {
    const client = fakeClient({
      waitForReply: vi.fn(async () => ({ timedOut: false, reply: mindRow("fp-1", "Here is the mining read: hashprice stable.") }) as never),
    });
    setMindsReceiveDeps(receiveDeps(client));
    const outcome = await receiveMindReply({ alias: "main", sentMessageText: "report", fingerprintBefore: "fp-before", timeoutMs: 5000 });
    expect(outcome.status).toBe("reply_received");
    if (outcome.status === "reply_received") {
      expect(outcome.reply.messageText).toContain("hashprice");
      expect(outcome.reply.fingerprint).toBe("fp-1");
      expect(outcome.reply.messageId).toBe("msg-fp-1");
    }
    expect(client.waitForReply).toHaveBeenCalledWith({
      alias: "main",
      timeoutMs: 5000,
      sentMessageText: "report",
      afterFingerprint: "fp-before",
    });
  });

  it("maps a bounded timeout to reply_timeout with collect guidance", async () => {
    setMindsReceiveDeps(receiveDeps(fakeClient()));
    const outcome = await receiveMindReply({ alias: "main", sentMessageText: "report", fingerprintBefore: "fp-before", timeoutMs: 1234 });
    expect(outcome.status).toBe("reply_timeout");
    expect(outcome.detail).toContain("1234ms");
    expect(outcome.detail).toContain("collect");
  });

  it("maps 401/403 to a credential diagnosis, not a bare status", async () => {
    setMindsReceiveDeps(
      receiveDeps(
        fakeClient({
          waitForReply: vi.fn(async () => {
            throw new MindsApiError({ status: 401, code: "missing_builder_api_key", message: "no key" });
          }),
        }),
      ),
    );
    const outcome = await receiveMindReply({ alias: "main", sentMessageText: "x" });
    expect(outcome.status).toBe("error");
    expect(outcome.detail).toContain("credential");
  });

  it("maps 429 to a throttling diagnosis", async () => {
    setMindsReceiveDeps(
      receiveDeps(
        fakeClient({
          waitForReply: vi.fn(async () => {
            throw new MindsApiError({ status: 429, code: "rate_limited", message: "slow down" });
          }),
        }),
      ),
    );
    const outcome = await receiveMindReply({ alias: "main", sentMessageText: "x" });
    expect(outcome.status).toBe("error");
    expect(outcome.detail).toContain("throttled");
  });

  it("refuses to record an empty or non-Mind reply row", async () => {
    setMindsReceiveDeps(
      receiveDeps(
        fakeClient({
          waitForReply: vi.fn(async () => ({ timedOut: false, reply: mindRow("fp-2", "") }) as never),
        }),
      ),
    );
    const outcome = await receiveMindReply({ alias: "main", sentMessageText: "x" });
    expect(outcome.status).toBe("error");
    expect(outcome.detail).toContain("without Mind text");
  });
});

describe("deferred collect from the newest-first transcript", () => {
  it("takes only Mind rows newer than the pre-send fingerprint and stops there", async () => {
    const client = fakeClient({
      getHistory: vi.fn(async () => [
        mindRow("fp-newest", "Second Mind message: the full break-even table."),
        mindRow("fp-human-noise", "a human interjection", 1),
        mindRow("fp-first", "First Mind message: acknowledged, working on it.", 2),
        mindRow("fp-before", "NIGHTSHIFT investigation report", 1),
        mindRow("fp-ancient", "an old Mind row from before the send", 0),
      ]),
    });
    setMindsReceiveDeps(receiveDeps(client));
    const outcome = await collectMindReply({ alias: "main", fingerprintBefore: "fp-before" });
    expect(outcome.status).toBe("reply_received");
    if (outcome.status !== "reply_received") throw new Error("expected reply_received");
    expect(outcome.reply?.fingerprint).toBe("fp-newest");
    expect(outcome.collected?.mindRows.map((r) => r.fingerprint)).toEqual(["fp-first", "fp-newest"]);
    expect(client.getHistory).toHaveBeenCalledWith("main", { limit: 50 });
  });

  it("reports an honest pending state when the Mind has not replied yet", async () => {
    setMindsReceiveDeps(
      receiveDeps(
        fakeClient({
          getHistory: vi.fn(async () => [mindRow("fp-before", "NIGHTSHIFT investigation report", 1)]),
        }),
      ),
    );
    const outcome = await collectMindReply({ alias: "main", fingerprintBefore: "fp-before" });
    expect(outcome.status).toBe("reply_timeout");
    expect(outcome.detail).toContain("has not replied yet");
  });
});

/* ------------------------------------------------------------------ */
/* Round-trip recording on the task result                             */
/* ------------------------------------------------------------------ */

describe("awaitAndRecordMindReply", () => {
  it("does nothing when the send failed", async () => {
    const task = bareTask();
    const events: string[] = [];
    await awaitAndRecordMindReply({
      task,
      notify: { ok: false, detail: "not_configured: x" },
      alias: "main",
      sentMessageText: "t",
      receive: async () => ({ status: "reply_received", reply: { fingerprint: "f", messageText: "m", receivedAt: 1 }, detail: "" }),
      now: () => 1,
      event: async (type) => {
        events.push(type);
      },
    });
    expect(task.result?.mindsDelivery).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("records a received reply, labels its provenance and appends the findings to the summary", async () => {
    const task = bareTask();
    const events: string[] = [];
    await awaitAndRecordMindReply({
      task,
      notify: OK_SEND,
      alias: "main",
      fingerprintBefore: "fp-before",
      sentMessageText: "t",
      receive: async () => ({
        status: "reply_received",
        reply: {
          fingerprint: "fp-r",
          messageId: "m1",
          messageText: "Break-even sits at 18.2 J/TH at current ERCOT LMP.",
          receivedAt: 1_700_000_000_500,
        },
        detail: "ok",
      }),
      now: () => 1_700_000_000_000,
      event: async (type) => {
        events.push(type);
      },
    });
    const record = task.result?.mindsDelivery;
    expect(record?.status).toBe("reply_received");
    expect(record?.fingerprintBeforeSend).toBe("fp-before");
    expect(record?.endpoint).toBe(MINDS_BUILDER_ENDPOINT);
    expect(record?.reply?.messageText).toContain("18.2 J/TH");
    expect(events).toEqual(["mind_reply_received"]);
    expect(task.result?.summary).toContain('provenance "mind-reply"');
    expect(task.result?.summary).toContain("Break-even sits at 18.2 J/TH");
  });

  it("preserves execution state on timeout: status reply_timeout, fingerprint kept, pending event", async () => {
    const task = bareTask();
    const events: string[] = [];
    await awaitAndRecordMindReply({
      task,
      notify: OK_SEND,
      alias: "main",
      fingerprintBefore: "fp-before",
      sentMessageText: "t",
      receive: async () => ({ status: "reply_timeout", detail: "no Mind reply within 20000ms" }),
      now: () => 1,
      event: async (type, message) => {
        events.push(type);
        expect(message).toContain("collect");
      },
    });
    expect(task.result?.mindsDelivery?.status).toBe("reply_timeout");
    expect(task.result?.mindsDelivery?.fingerprintBeforeSend).toBe("fp-before");
    expect(task.result?.summary).not.toContain("Mind reply");
    expect(events).toEqual(["mind_reply_pending"]);
  });

  it("records a receive failure without touching the verified result", async () => {
    const task = bareTask();
    const summaryBefore = task.result?.summary;
    await awaitAndRecordMindReply({
      task,
      notify: OK_SEND,
      alias: "main",
      sentMessageText: "t",
      receive: async () => ({ status: "error", detail: "Minds rejected the credential (HTTP 401)" }),
      now: () => 1,
      event: async () => undefined,
    });
    expect(task.result?.mindsDelivery?.status).toBe("error");
    expect(task.result?.mindsDelivery?.replyErrorDetail).toContain("credential");
    expect(task.result?.summary).toBe(summaryBefore);
  });

  it("keeps the record at sent when receive is not wired (legacy dep shapes)", async () => {
    const task = bareTask();
    await awaitAndRecordMindReply({
      task,
      notify: OK_SEND,
      alias: "main",
      sentMessageText: "t",
      now: () => 1,
      event: async () => undefined,
    });
    expect(task.result?.mindsDelivery?.status).toBe("sent");
  });
});

/* ------------------------------------------------------------------ */
/* The Mind investigation flow stays intact and now records the reply  */
/* ------------------------------------------------------------------ */

describe("mind investigation round trip (free flow)", () => {
  it("delivers the report, receives the reply and persists both on the completed task", async () => {
    const client = fakeClient({
      waitForReply: vi.fn(async () => ({ timedOut: false, reply: mindRow("fp-reply", "Acknowledged. The Equinor read matches your comparison.") }) as never),
    });
    setMindsReceiveDeps(receiveDeps(client));
    setMindDeps({
      probe: async () => probeChallenge(),
      notify: async () => OK_SEND,
    });
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "free");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: false,
    });
    const done = await runTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    expect(done.result?.mindsDelivery?.status).toBe("reply_received");
    expect(done.result?.mindsDelivery?.fingerprintBeforeSend).toBe("fp-before");
    expect(done.result?.mindsDelivery?.alias).toBe("main");
    expect(done.result?.summary).toContain('provenance "mind-reply"');
    expect(done.result?.summary).toContain("Equinor read matches");
    expect(done.events.some((e) => e.type === "delivery_succeeded")).toBe(true);
    expect(done.events.some((e) => e.type === "mind_reply_received")).toBe(true);
    expect(client.waitForReply).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "main", sentMessageText: expect.stringContaining("NIGHTSHIFT investigation report") }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Bitcoin Mining flow: reply attached, workflow unchanged             */
/* ------------------------------------------------------------------ */

describe("bitcoin mining capability flow with the reply attached", () => {
  function inputsFor(slug: string): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const dim of CAPABILITIES[slug].dimensions) {
      if (dim.status !== "gap") out[dim.id] = sampleParams(dim);
    }
    return out;
  }

  function taskFor(plan: ReturnType<typeof planCapabilityRun>): TaskRecord {
    return {
      id: "task-capability",
      createdAt: 1,
      updatedAt: 1,
      state: "executing",
      goal: `capability ${plan.config.slug}`,
      plan: plan.steps,
      events: [],
      spend: { limitUsdCents: plan.budgetCeilingUsdCents, spentUsdCents: 0, entries: [] },
      permissions: { allowedActions: ["telegraph.ask"], requiresApproval: false, maxRetries: 0 },
      criteria: plan.criteria,
      result: null,
      error: null,
      origin: { source: "web" },
      jobType: "capability_run",
    };
  }

  function paidDeps(notify: unknown, receive: unknown) {
    const execute = vi.fn(async () => ({
      kind: "answered",
      urlPath: "/engine/v1/ask/x",
      requestSent: {},
      offer: OFFER,
      result: { ok: true },
      signalHash: "0xsignal",
      receipt: { receipt_hash: "0xreceipt", amount_uusdc: "10000" },
    }));
    const verify = vi.fn(async () => ({
      kind: "verified",
      signalHash: "0xsignal",
      record: { payload: { response: { data: { amount: 64000 }, hashprice_sats_per_ph_day: 50000, hashrate_eh_s: 700 } } },
      note: "re-derived",
    }));
    setCapabilityDeps({
      probe: vi.fn(async () => CHALLENGE),
      execute: execute as never,
      verify: verify as never,
      notify: notify as never,
      receive: receive as never,
      now: () => 1_700_000_000_000,
    });
  }

  async function runMiningFlow(): Promise<TaskRecord> {
    const plan = planCapabilityRun("bitcoin-mining-intelligence", inputsFor("bitcoin-mining-intelligence"), "intel");
    const task = taskFor(plan);
    task.spend.limitUsdCents = 10;
    const outputs = {};
    await executeCapabilityBaseline(task, plan.steps[0].target, outputs as never);
    await executeCapabilityAsk(task, plan.steps[1].target, outputs as never);
    await executeCapabilityReport(task, plan.steps[2].target, outputs as never);
    return task;
  }

  it("completes the verified mining report and attaches the Mind reply with mind-reply provenance", async () => {
    const client = fakeClient({
      waitForReply: vi.fn(async () => ({ timedOut: false, reply: mindRow("fp-mining", "Mining read acknowledged: hashprice looks stable.") }) as never),
    });
    setMindsReceiveDeps(receiveDeps(client));
    const notify = vi.fn(async () => OK_SEND);
    paidDeps(notify, (request: unknown) => receiveMindReply(request as never));

    const task = await runMiningFlow();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(task.state).toBe("completed");
    expect(task.result?.bitcoinMiningReport?.findings.hashpriceUsdPerPhDay).not.toBeNull();
    expect(task.events.some((e) => e.type === "delivery_succeeded")).toBe(true);
    expect(task.result?.mindsDelivery?.status).toBe("reply_received");
    expect(task.result?.mindsDelivery?.fingerprintBeforeSend).toBe("fp-before");
    expect(task.result?.summary).toContain('provenance "mind-reply"');
    expect(task.result?.summary).toContain("Mining read acknowledged");
    expect(task.events.some((e) => e.type === "mind_reply_received")).toBe(true);
    expect(client.waitForReply).toHaveBeenCalledWith(expect.objectContaining({ alias: "main", sentMessageText: expect.any(String) }));
  });

  it("leaves the completed mining report untouched when the reply wait times out", async () => {
    setMindsReceiveDeps(receiveDeps(fakeClient()));
    const notify = vi.fn(async () => OK_SEND);
    paidDeps(notify, (request: unknown) => receiveMindReply(request as never));

    const task = await runMiningFlow();

    expect(task.state).toBe("completed");
    expect(task.result?.bitcoinMiningReport?.findings.hashpriceUsdPerPhDay).not.toBeNull();
    expect(task.result?.mindsDelivery?.status).toBe("reply_timeout");
    expect(task.events.some((e) => e.type === "mind_reply_pending")).toBe(true);
    expect(task.result?.summary).not.toContain("Mind reply");
  });
});

/* ------------------------------------------------------------------ */
/* The deferred collect route                                          */
/* ------------------------------------------------------------------ */

describe("POST /api/mind/minds-delivery", () => {
  const req = (body: unknown, token?: string) =>
    new NextRequest("http://localhost/api/mind/minds-delivery", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  async function persistedAwaitingTask(): Promise<TaskRecord> {
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "free");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: false,
    });
    task.state = "completed";
    task.result = {
      summary: "The investigation summary.",
      evidence: [],
      completedAt: Date.now(),
      mindsDelivery: {
        alias: "main",
        endpoint: MINDS_BUILDER_ENDPOINT,
        sentAt: Date.now(),
        status: "reply_timeout",
        fingerprintBeforeSend: "fp-before",
        sendDetail: "sent",
        replyErrorDetail: "no Mind reply within 20000ms",
        replySource: "inline_wait",
      },
    };
    await saveTask(task);
    return task;
  }

  it("fails closed without the operator token", async () => {
    delete process.env.NIGHTSHIFT_API_TOKEN;
    const { POST } = await import("@/app/api/mind/minds-delivery/route");
    const res = await POST(req({ taskId: "t1" }));
    expect(res.status).toBe(401);
  });

  it("collects a late reply onto the awaiting task with the provenance label", async () => {
    process.env.NIGHTSHIFT_API_TOKEN = "test-token-value";
    const collectClient = fakeClient({
      getHistory: vi.fn(async () => [
        mindRow("fp-late", "Late reply: the Mind's full findings."),
        mindRow("fp-before", "NIGHTSHIFT investigation report", 1),
      ]),
    });
    setMindsReceiveDeps(receiveDeps(collectClient));
    const { POST } = await import("@/app/api/mind/minds-delivery/route");

    const task = await persistedAwaitingTask();
    const res = await POST(req({ taskId: task.id }, process.env.NIGHTSHIFT_API_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { status: string; reply?: { messageText: string } } };
    expect(body.delivery.status).toBe("reply_received");
    expect(body.delivery.reply?.messageText).toContain("Late reply");
    const stored = await getTask(task.id);
    expect(stored?.result?.mindsDelivery?.status).toBe("reply_received");
    expect(stored?.result?.mindsDelivery?.replySource).toBe("deferred_collect");
    expect(stored?.result?.summary).toContain('provenance "mind-reply"');
    expect(stored?.events.some((e) => e.type === "mind_reply_received")).toBe(true);
  });

  it("answers 409 for a task with no Minds round trip", async () => {
    process.env.NIGHTSHIFT_API_TOKEN = "test-token-value";
    const { POST } = await import("@/app/api/mind/minds-delivery/route");
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "free");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: false,
    });
    const res = await POST(req({ taskId: task.id }, process.env.NIGHTSHIFT_API_TOKEN));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no Minds delivery record");
  });
});
