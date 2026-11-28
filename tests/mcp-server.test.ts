import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createNightshiftMcpServer, MCP_SERVER_NAME } from "@/lib/mcp/server";
import { defaultMcpDeps, type McpCaller, type McpDeps } from "@/lib/mcp/deps";
import { createTask } from "@/lib/engine/engine";
import { getTask, listTasks, resetStore } from "@/lib/engine/store";
import { userSessionCookieValue } from "@/lib/api/auth";

/**
 * MCP protocol tests for the NIGHTSHIFT MCP server.
 *
 * These run the REAL MCP protocol over the SDK's in-memory transport pair:
 * a real client performs the initialize handshake, lists tools and invokes
 * them. Network-touching services are substituted through McpDeps so the
 * suite is hermetic; the authorization gates, engine lifecycle and redaction
 * run for real (file store isolated by tests/setup.ts).
 */

const TOKEN = "mcp-suite-operator-token";
const USER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const OTHER_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const CAPPED_ADDR = "0xcccccccccccccccccccccccccccccccccccccccc3";
const ACCESS_ADDR = "0xdddddddddddddddddddddddddddddddddddddddd4";

let savedToken: string | undefined;
let savedPrivKey: string | undefined;

beforeAll(() => {
  savedToken = process.env.NIGHTSHIFT_API_TOKEN;
  savedPrivKey = process.env.TELEGRAPH_EVM_PRIVATE_KEY;
  process.env.NIGHTSHIFT_API_TOKEN = TOKEN;
  delete process.env.TELEGRAPH_EVM_PRIVATE_KEY;
});

afterAll(() => {
  if (savedToken === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
  else process.env.NIGHTSHIFT_API_TOKEN = savedToken;
  if (savedPrivKey !== undefined) process.env.TELEGRAPH_EVM_PRIVATE_KEY = savedPrivKey;
});

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore();
});

/** A completed free-run projection the mocked executor hands back. */
async function fakeRunTask(id: string) {
  const task = await getTask(id);
  if (!task) throw new Error(`task ${id} not found`);
  return {
    ...task,
    state: "completed" as const,
    result: {
      summary: `miner miner-1\n\n${JSON.stringify({ answer: "unpaid dossier" })}`,
      evidence: [],
      completedAt: Date.now(),
    },
  };
}

async function connect(caller: McpCaller = {}, depsOverride: Partial<McpDeps> = {}) {
  const deps: McpDeps = { ...defaultMcpDeps(), ...depsOverride };
  const server = createNightshiftMcpServer(caller, deps);
  const client = new Client({ name: "protocol-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callTool(client: Client, name: string, args?: Record<string, unknown>): Promise<CallToolResult & { parsed: Record<string, unknown> }> {
  let result: CallToolResult;
  try {
    result = (await client.callTool({ name, arguments: args ?? {} })) as CallToolResult;
  } catch (err) {
    // Older SDK/spec behavior surfaces invalid params as a protocol error.
    const message = err instanceof Error ? err.message : String(err);
    result = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }] } as unknown as CallToolResult;
  }
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "{}";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { ...result, parsed } as CallToolResult & { parsed: Record<string, unknown> };
}

const userCookie = () => `ns_user=${userSessionCookieValue(USER_ADDR)}`;
const otherCookie = () => `ns_user=${userSessionCookieValue(OTHER_ADDR)}`;
const accessCookie = () => `ns_user=${userSessionCookieValue(ACCESS_ADDR)}`;
const cappedCookie = () => `ns_user=${userSessionCookieValue(CAPPED_ADDR)}`;
const bearer = () => `Bearer ${TOKEN}`;

describe("MCP initialization and tool discovery", () => {
  it("completes the MCP initialize handshake and reports the NIGHTSHIFT server", async () => {
    const client = await connect();
    const info = client.getServerVersion();
    expect(info?.name).toBe(MCP_SERVER_NAME);
    expect(info?.version).toBeTruthy();
    expect(client.getServerCapabilities()).toBeTruthy();
  });

  it("exposes exactly the nine documented tools", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "nightshift_create_free_investigation",
        "nightshift_get_mind_coverage",
        "nightshift_get_task",
        "nightshift_get_task_evidence",
        "nightshift_list_minds",
        "nightshift_request_intelligence",
        "nightshift_verify_task",
        "telegraph_list_intents",
        "telegraph_list_miners",
      ].sort(),
    );
  });

  it("describes every tool and flags paid tools with input schemas", async () => {
    const client = await connect();
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(tool.description, tool.name).toBeTruthy();
    }
    const paid = tools.tools.find((t) => t.name === "nightshift_request_intelligence");
    expect(paid?.inputSchema).toBeTruthy();
    const spend = (paid?.inputSchema as { properties?: Record<string, { maximum?: number }> }).properties?.spendLimitUsdCents;
    expect(spend?.maximum).toBe(20000);
  });
});

describe("discovery tools", () => {
  it("lists intents from the live node and never spends", async () => {
    let calls = 0;
    const client = await connect({}, {
      listIntents: async () => {
        calls += 1;
        return [{ intent_id: "CRYPTO_PRICE_USD", intent_name: "Crypto price", miner_count: 3 }];
      },
    });
    const res = await callTool(client, "telegraph_list_intents");
    expect(res.isError).toBeFalsy();
    expect(res.parsed.count).toBe(1);
    expect(calls).toBe(1);
    const taskCount = (await listTasks()).length;
    expect(taskCount).toBe(0); // discovery creates nothing
  });

  it("lists miners filtered by intent", async () => {
    const client = await connect({}, {
      listMiners: async (intent?: string) => {
        expect(intent).toBe("CRYPTO_PRICE_USD");
        return [{ id: "m1", name: "Price Miner", kind: "market", capabilities: ["CRYPTO_PRICE_USD"] }];
      },
    });
    const res = await callTool(client, "telegraph_list_miners", { intent: "CRYPTO_PRICE_USD" });
    expect(res.isError).toBeFalsy();
    expect(res.parsed.count).toBe(1);
  });

  it("serves the minds catalogue and the committed coverage matrix without network calls", async () => {
    const client = await connect({}, {
      // If anything tried to probe the network, these would explode the test.
      probeMindCoverage: async () => {
        throw new Error("live probe must not run in matrix mode");
      },
    });
    const minds = await callTool(client, "nightshift_list_minds");
    expect(minds.isError).toBeFalsy();
    expect((minds.parsed.count as number) > 0).toBe(true);
    const counterparty = (minds.parsed.minds as Array<{ slug: string; status: string }>).find((m) => m.slug === "counterparty-intelligence");
    expect(counterparty?.status).toBe("available");

    const coverage = await callTool(client, "nightshift_get_mind_coverage", { slug: "counterparty-intelligence" });
    expect(coverage.isError).toBeFalsy();
    expect(coverage.parsed.mode).toBe("matrix");
    expect((coverage.parsed.dimensions as unknown[]).length).toBeGreaterThan(0);
  });

  it("reports unknown Minds honestly and errors on live probe failure", async () => {
    const client = await connect({}, { probeMindCoverage: async () => { throw new Error("node down"); } });
    const unknown = await callTool(client, "nightshift_get_mind_coverage", { slug: "nope" });
    expect(unknown.isError).toBe(true);
    expect((unknown.parsed.availableSlugs as string[]).length).toBeGreaterThan(0);
    const live = await callTool(client, "nightshift_get_mind_coverage", { slug: "counterparty-intelligence", live: true });
    expect(live.isError).toBe(true);
    expect(JSON.stringify(live.parsed)).toContain("node down");
  });
});

describe("free investigation creation", () => {
  it("creates, executes and completes a $0.00 mind investigation", async () => {
    let ran = 0;
    const client = await connect({}, { runTask: (id) => { ran += 1; return fakeRunTask(id); } });
    const res = await callTool(client, "nightshift_create_free_investigation", {
      objective: "Investigate MARA HOLDINGS INC in the US",
    });
    expect(res.isError).toBeFalsy();
    expect(ran).toBe(1);
    expect(res.parsed.state).toBe("completed");
    expect(res.parsed.jobType).toBe("mind_investigation");
    expect((res.parsed.spend as { spentUsdCents: number }).spentUsdCents).toBe(0);

    const stored = await getTask(res.parsed.taskId as string);
    expect(stored?.jobType).toBe("mind_investigation");
    expect(stored?.permissions.requiresApproval).toBe(false);
    expect(stored?.criteria.primarySource).toBe("free");
    expect(stored?.plan?.map((s) => s.kind)).toEqual(["mind_baseline", "mind_report"]);
    expect(stored?.spend.limitUsdCents).toBeGreaterThan(0);
    expect(stored?.spend.entries).toHaveLength(0);
    // No purchase is planned anywhere in a free run.
    expect(stored?.plan?.some((s) => s.kind === "counterparty_ask")).toBe(false);
  });

  it("refuses objectives that name no company and creates nothing", async () => {
    const before = (await listTasks()).length;
    const client = await connect({}, { runTask: fakeRunTask });
    const res = await callTool(client, "nightshift_create_free_investigation", { objective: "What is the meaning of life?" });
    expect(res.isError).toBe(true);
    expect((await listTasks()).length).toBe(before);
  });

  it("rejects invalid inputs at the protocol layer without creating tasks", async () => {
    const before = (await listTasks()).length;
    const client = await connect({}, { runTask: fakeRunTask });
    const missing = await callTool(client, "nightshift_create_free_investigation");
    expect(missing.isError).toBe(true);
    const empty = await callTool(client, "nightshift_create_free_investigation", { objective: "" });
    expect(empty.isError).toBe(true);
    expect((await listTasks()).length).toBe(before);
  });
});

describe("paid intelligence stops at the approval gate", () => {
  it("creates the task at awaiting_approval as the operator and never signs anything", async () => {
    const client = await connect({ authorization: bearer() });
    const res = await callTool(client, "nightshift_request_intelligence", {
      objective: "Investigate MARA HOLDINGS INC in the US",
      spendLimitUsdCents: 5,
    });
    expect(res.isError).toBeFalsy();
    expect(res.parsed.state).toBe("awaiting_approval");
    const approval = res.parsed.approval as { required: boolean; status: string };
    expect(approval.required).toBe(true);
    expect(approval.status).toBe("awaiting_approval");

    const stored = await getTask(res.parsed.taskId as string);
    expect(stored?.state).toBe("awaiting_approval");
    expect(stored?.permissions.requiresApproval).toBe(true);
    expect(stored?.owner).toBeUndefined();
    // NO PAYMENT OCCURRED: zero spend, zero ledger entries, zero challenge events.
    expect(stored?.spend.spentUsdCents).toBe(0);
    expect(stored?.spend.entries).toHaveLength(0);
    expect(stored?.events.filter((e) => e.type === "telegraph_challenge" || e.type === "spend_recorded")).toHaveLength(0);
    // The paid step is planned but fenced behind the gate.
    expect(stored?.plan?.some((s) => s.kind === "counterparty_ask")).toBe(true);
    expect(JSON.stringify(res.parsed)).toContain("NO payment was signed");
  });

  it("stamps ownership for wallet-session callers inside their daily cap", async () => {
    const client = await connect({ cookie: userCookie() });
    const res = await callTool(client, "nightshift_request_intelligence", {
      objective: "Investigate GLEIF in the US",
    });
    expect(res.isError).toBeFalsy();
    const stored = await getTask(res.parsed.taskId as string);
    expect(stored?.owner).toBe(USER_ADDR);
    expect(stored?.state).toBe("awaiting_approval");
    expect(stored?.spend.spentUsdCents).toBe(0);
  });

  it("refuses anonymous paid requests (authentication failure)", async () => {
    const goal = "Investigate GLEIF in the US - anon refusal";
    const client = await connect({});
    const res = await callTool(client, "nightshift_request_intelligence", { objective: goal });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.parsed)).toContain("sign in with your wallet");
    expect((await listTasks()).filter((t) => t.goal === goal)).toHaveLength(0);
  });

  it("refuses a wallet user whose daily cap is exhausted", async () => {
    const goal = "Investigate GLEIF in the US - over cap";
    // Seed spend for this owner inside the 24h window.
    await createTask({
      goal: "seed spend - cap test",
      requiresApproval: false,
      origin: { source: "mcp" },
      owner: CAPPED_ADDR,
      plan: [{ id: "s", kind: "mind_baseline", description: "seed" }],
      criteria: {
        primaryVerifiedAgainstNodeSignal: false,
        answerSane: false,
        answerMaxAgeSeconds: 0,
        ownPaymentSettledOnChain: false,
        reconcileLedgerEntries: false,
      },
    });
    const seeded = (await listTasks()).find((t) => t.goal === "seed spend - cap test")!;
    seeded.spend.entries.push({ ts: Date.now(), description: "seed", amountUsdCents: 200, source: "telegraph", receiptHash: "r", txHash: "t", signalHash: "s" });
    seeded.spend.spentUsdCents = 200;
    const { saveTask } = await import("@/lib/engine/store");
    await saveTask(seeded);

    const client = await connect({ cookie: cappedCookie() });
    const res = await callTool(client, "nightshift_request_intelligence", { objective: goal });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.parsed)).toContain("daily spend cap reached");
    expect((await listTasks()).filter((t) => t.goal === goal)).toHaveLength(0);
  });

  it("rejects invalid spend limits before any task exists", async () => {
    const goal = "Investigate GLEIF in the US - limits";
    const client = await connect({ authorization: bearer() });
    for (const bad of [0, -1, 20001, 1.5]) {
      const res = await callTool(client, "nightshift_request_intelligence", {
        objective: goal,
        spendLimitUsdCents: bad,
      });
      expect(res.isError).toBe(true);
    }
    expect((await listTasks()).filter((t) => t.goal === goal)).toHaveLength(0);
  });
});

describe("task access, ownership and redaction", () => {
  async function seededPaidTask() {
    const goal = "Investigate MARA HOLDINGS INC in the US - access tests";
    const client = await connect({ cookie: accessCookie() });
    const res = await callTool(client, "nightshift_request_intelligence", { objective: goal });
    expect(res.isError).toBeFalsy();
    return res.parsed.taskId as string;
  }

  it("gives the owner the full record and others only the public projection", async () => {
    const taskId = await seededPaidTask();

    const ownerClient = await connect({ cookie: accessCookie() });
    const ownerView = await callTool(ownerClient, "nightshift_get_task", { taskId });
    expect(ownerView.isError).toBeFalsy();
    expect(ownerView.parsed.redacted).toBe(false);
    expect(ownerView.parsed.goal).toContain("MARA HOLDINGS");
    expect((ownerView.parsed.plan as unknown[]).length).toBeGreaterThan(0);

    const otherClient = await connect({ cookie: otherCookie() });
    const otherView = await callTool(otherClient, "nightshift_get_task", { taskId });
    expect(otherView.parsed.redacted).toBe(true);
    expect(otherView.parsed.goal).toBeUndefined();

    const anonClient = await connect({});
    const anonView = await callTool(anonClient, "nightshift_get_task", { taskId });
    expect(anonView.parsed.redacted).toBe(true);
    expect(anonView.parsed.goal).toBeUndefined();
    expect(anonView.parsed.plan).toBeUndefined();
    expect(anonView.parsed.events).toBeUndefined();
  });

  it("redacts private objectives, reports and payment details from anonymous callers", async () => {
    const taskId = await seededPaidTask();
    const anonClient = await connect({});
    const view = await callTool(anonClient, "nightshift_get_task", { taskId });
    const json = JSON.stringify(view.parsed);
    expect(json).not.toContain("MARA");
    // Payment information never crosses the gate: only aggregate totals stay.
    expect(view.parsed.spend).toEqual({ limitUsdCents: expect.any(Number), spentUsdCents: 0 });
    expect(json).not.toContain("receiptHash");
    expect(json).not.toContain("signalHash");
  });

  it("refuses evidence reads for non-owners and unknown tasks", async () => {
    const taskId = await seededPaidTask();
    const anonClient = await connect({});
    const denied = await callTool(anonClient, "nightshift_get_task_evidence", { taskId });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.parsed)).toContain("private");

    const otherClient = await connect({ cookie: otherCookie() });
    const otherDenied = await callTool(otherClient, "nightshift_get_task_evidence", { taskId });
    expect(otherDenied.isError).toBe(true);

    const operatorClient = await connect({ authorization: bearer() });
    const missing = await callTool(operatorClient, "nightshift_get_task_evidence", { taskId: "no-such-task" });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.parsed)).toContain("not found");
  });

  it("serves the evidence trail to the owner with criteria, hashes and ledger", async () => {
    const taskId = await seededPaidTask();
    const ownerClient = await connect({ cookie: accessCookie() });
    const res = await callTool(ownerClient, "nightshift_get_task_evidence", { taskId });
    expect(res.isError).toBeFalsy();
    expect(res.parsed.criteria).toBeTruthy();
    expect(res.parsed.evidence).toEqual([]);
    expect(res.parsed.ledger).toEqual({ limitUsdCents: expect.any(Number), spentUsdCents: 0, entries: [] });
  });
});

describe("verification tool", () => {
  it("refuses anonymous verification of an existing task (evidence is private)", async () => {
    const ownerClient = await connect({ authorization: bearer() });
    const created = await callTool(ownerClient, "nightshift_request_intelligence", {
      objective: "Investigate MARA HOLDINGS INC in the US - verify gate",
    });
    const taskId = created.parsed.taskId as string;

    const client = await connect({});
    const res = await callTool(client, "nightshift_verify_task", { taskId });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.parsed)).toContain("authenticate");

    const unknown = await callTool(ownerClient, "nightshift_verify_task", { taskId: "no-such-task" });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.parsed)).toContain("not found");
  });

  it("returns a full independent report to the operator for a real task", async () => {
    const paidClient = await connect({ authorization: bearer() });
    const created = await callTool(paidClient, "nightshift_request_intelligence", { objective: "Investigate MARA HOLDINGS INC in the US" });
    const taskId = created.parsed.taskId as string;

    const client = await connect({ authorization: bearer() });
    const res = await callTool(client, "nightshift_verify_task", { taskId });
    expect(res.isError).toBeFalsy();
    const report = res.parsed as unknown as {
      taskId: string;
      verdict: string;
      claimedComplete: boolean;
      checks: unknown[];
      unresolvedGaps: string[];
      nodeAssertedLabels: string[];
    };
    expect(report.taskId).toBe(taskId);
    expect(report.claimedComplete).toBe(false);
    expect(["verified", "failed", "unverified"]).toContain(report.verdict);
    expect(report.unresolvedGaps.length).toBeGreaterThan(0);
  });
});

describe("MCP errors when NIGHTSHIFT APIs are unavailable", () => {
  it("surfaces upstream failures as tool errors, not crashes", async () => {
    const client = await connect({}, {
      listIntents: async () => { throw new Error("upstream 503"); },
      getTask: async () => { throw new Error("storage unavailable"); },
    });
    const intents = await callTool(client, "telegraph_list_intents");
    expect(intents.isError).toBe(true);
    expect(JSON.stringify(intents.parsed)).toContain("upstream 503");

    const task = await callTool(client, "nightshift_get_task", { taskId: "x" });
    expect(task.isError).toBe(true);
    expect(JSON.stringify(task.parsed)).toContain("storage unavailable");
  });
});
