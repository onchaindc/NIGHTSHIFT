import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { GET as tasksGET } from "@/app/api/tasks/route";
import { GET as taskGET } from "@/app/api/tasks/[id]/route";
import { POST as actionPOST } from "@/app/api/tasks/[id]/action/route";
import { GET as investigationsGET } from "@/app/api/mind/investigations/route";
import { GET as statusGET } from "@/app/api/status/route";
import { POST as sessionPOST, DELETE as sessionDELETE } from "@/app/api/session/route";
import { saveTask, resetStore, getTask } from "@/lib/engine/store";
import { isRedactedTask, publicTaskView } from "@/lib/api/public";
import {
  OPERATOR_COOKIE,
  expectedOperatorCookieValue,
  operatorCookieFromHeader,
  requestAuthorizedFromParts,
} from "@/lib/api/auth";
import type { TaskRecord } from "@/lib/engine/types";

/**
 * Read-protection tests for the private-record gate (feat/private-read-protection).
 *
 * The API must never hand private investigation content to an anonymous
 * caller: objectives, plans, event timelines, reports, evidence, Terminal
 * request payloads, and the spend ledger with receipt/signal/tx hashes.
 * Discovery-level fields (existence, kind, state, timestamps, aggregate
 * spend) stay public. The operator keeps full access via the bearer token or
 * the /api/session cookie. The gate fails closed when no token is configured.
 */

const TOKEN = "test-operator-token-0123456789abcdef";
const SECRET_GOAL = 'Investigate "Equinor ASA" (PRIVATE objective for the operator only)';
const SECRET_SUMMARY = "PURCHASED INTELLIGENCE: 9 of 9 registry fields verified by the specialist miner.";
const RECEIPT_HASH = "0xreceipt-abc123-private";
const SIGNAL_HASH = "0xsignal-def456-private";
const TX_HASH = "0xtx-789-private";
const TERMINAL_REQUEST_BODY = { intent: "counterparty_intel", params: { company: "Equinor ASA" } };

let counter = 0;

function fullTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    state: "completed",
    goal: SECRET_GOAL,
    plan: [
      { id: "step-1", kind: "counterparty_ask", description: "PAID specialist ask for Equinor ASA", target: "{}", maxCostUsdCents: 100 },
    ],
    events: [{ id: "evt-1", ts: 1_700_000_050_000, type: "spend_recorded", message: "spent $1.00", data: {} }],
    spend: {
      limitUsdCents: 100,
      spentUsdCents: 100,
      entries: [
        {
          ts: 1_700_000_050_000,
          description: "counterparty_ask",
          amountUsdCents: 100,
          source: "telegraph",
          receiptHash: RECEIPT_HASH,
          signalHash: SIGNAL_HASH,
          txHash: TX_HASH,
        },
      ],
    },
    permissions: { allowedActions: ["telegraph.ask"], requiresApproval: true, maxRetries: 1 },
    criteria: {
      primaryVerifiedAgainstNodeSignal: true,
      answerSane: true,
      answerMaxAgeSeconds: 600,
      ownPaymentSettledOnChain: true,
      reconcileLedgerEntries: true,
      goalIntent: "information",
    },
    result: { summary: SECRET_SUMMARY, evidence: [], completedAt: 1_700_000_060_000 },
    error: null,
    origin: { source: "web" },
    jobType: "mind_investigation",
    terminal: {
      intent: "counterparty_intel",
      request: TERMINAL_REQUEST_BODY,
      offer: { scheme: "exact", network: "eip155:84532", asset: "0xasset", payTo: "0xminer", amount: "1000000" },
      payerAddress: "0xpayer",
    } as unknown as TaskRecord["terminal"],
    labels: ["audit-rehearsal"],
  };
}

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, { headers });
}

const withBearer = (url: string) => req(url, { authorization: `Bearer ${TOKEN}` });
const withCookie = (url: string) => req(url, { cookie: `${OPERATOR_COOKIE}=${expectedOperatorCookieValue()}` });

let dataRoot: string | null = null;

beforeEach(async () => {
  process.env.NIGHTSHIFT_API_TOKEN = TOKEN;
  // Isolated per-test data directory: the store persists to disk, so each
  // test starts from a genuinely empty store.
  const dir = await mkdtemp(path.join(os.tmpdir(), "ns-read-protection-"));
  dataRoot = dir;
  process.env.NIGHTSHIFT_DATA_DIR = dir;
  resetStore();
  await saveTask(fullTask());
});

afterEach(async () => {
  delete process.env.NIGHTSHIFT_API_TOKEN;
  delete process.env.NIGHTSHIFT_DATA_DIR;
  resetStore();
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  dataRoot = null;
});

describe("publicTaskView", () => {
  it("strips every private field and keeps discovery-level fields", () => {
    const view = publicTaskView(fullTask());
    expect(view.goal).toBe("");
    expect(view.plan).toBeNull();
    expect(view.events).toEqual([]);
    expect(view.result).toBeNull();
    expect(view.error).toBeNull();
    expect(view.spend.entries).toEqual([]);
    expect(view.spend.spentUsdCents).toBe(100);
    expect(view.spend.limitUsdCents).toBe(100);
    expect(view.state).toBe("completed");
    expect(view.jobType).toBe("mind_investigation");
    expect(view.origin).toEqual({ source: "web" });
    expect(view.terminal).toBeUndefined();
    expect(view.watch).toBeUndefined();
    expect(view.labels).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(RECEIPT_HASH);
    expect(JSON.stringify(view)).not.toContain(SIGNAL_HASH);
    expect(JSON.stringify(view)).not.toContain(TX_HASH);
    expect(JSON.stringify(view)).not.toContain(SECRET_GOAL);
    expect(JSON.stringify(view)).not.toContain(SECRET_SUMMARY);
    expect(isRedactedTask(view)).toBe(true);
  });

  it("leaves a full record untouched by the redaction marker", () => {
    expect(isRedactedTask(fullTask())).toBe(false);
  });
});

describe("GET /api/tasks", () => {
  it("anonymous callers get only the public projection", async () => {
    const res = await tasksGET(req("/api/tasks"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: TaskRecord[]; redacted: boolean };
    expect(body.redacted).toBe(true);
    expect(body.tasks).toHaveLength(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SECRET_GOAL);
    expect(raw).not.toContain(SECRET_SUMMARY);
    expect(raw).not.toContain(RECEIPT_HASH);
    expect(raw).not.toContain(SIGNAL_HASH);
    expect(raw).not.toContain(TX_HASH);
    expect(raw).not.toContain(JSON.stringify(TERMINAL_REQUEST_BODY));
    expect(body.tasks[0].state).toBe("completed");
    expect(body.tasks[0].spend.spentUsdCents).toBe(100);
  });

  it("the bearer token gets the full record", async () => {
    const res = await tasksGET(withBearer("/api/tasks"));
    const body = (await res.json()) as { tasks: TaskRecord[]; redacted: boolean };
    expect(body.redacted).toBe(false);
    expect(body.tasks[0].goal).toBe(SECRET_GOAL);
    expect(body.tasks[0].spend.entries[0].receiptHash).toBe(RECEIPT_HASH);
    expect(body.tasks[0].spend.entries[0].signalHash).toBe(SIGNAL_HASH);
  });

  it("the operator session cookie gets the full record", async () => {
    const res = await tasksGET(withCookie("/api/tasks"));
    const body = (await res.json()) as { tasks: TaskRecord[]; redacted: boolean };
    expect(body.redacted).toBe(false);
    expect(body.tasks[0].goal).toBe(SECRET_GOAL);
  });
});

describe("GET /api/tasks/:id", () => {
  it("anonymous callers cannot read private content of a known id", async () => {
    const stored = (await getTask(fullTaskId()))!;
    const res = await taskGET(req(`/api/tasks/${stored.id}`), { params: Promise.resolve({ id: stored.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: TaskRecord; redacted: boolean };
    expect(body.redacted).toBe(true);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SECRET_GOAL);
    expect(raw).not.toContain(RECEIPT_HASH);
    expect(raw).not.toContain(JSON.stringify(TERMINAL_REQUEST_BODY));
    expect(body.task.spend.entries).toEqual([]);
  });

  it("the operator keeps full access and unknown ids stay 404", async () => {
    const stored = (await getTask(fullTaskId()))!;
    const full = await taskGET(withBearer(`/api/tasks/${stored.id}`), { params: Promise.resolve({ id: stored.id }) });
    const body = (await full.json()) as { task: TaskRecord; redacted: boolean };
    expect(body.redacted).toBe(false);
    expect(body.task.goal).toBe(SECRET_GOAL);
    expect(body.task.terminal?.request).toEqual(TERMINAL_REQUEST_BODY);

    const missing = await taskGET(withBearer("/api/tasks/does-not-exist"), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/tasks/:id/action", () => {
  it("rejects an anonymous approval attempt before any id lookup", async () => {
    const res = await actionPOST(
      req("/api/tasks/whatever/action", { "content-type": "application/json" }),
      { params: Promise.resolve({ id: "whatever" }) },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sign in with your wallet");
  });

  it("accepts the operator session cookie as identity", async () => {
    // An unknown id: the gate passes with the cookie, then the store 404s —
    // proving cookie authorization without touching any real task.
    const res = await actionPOST(
      new NextRequest("http://localhost/api/tasks/unknown-id/action", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${OPERATOR_COOKIE}=${expectedOperatorCookieValue()}`,
        },
        body: JSON.stringify({ action: "approve" }),
      }),
      { params: Promise.resolve({ id: "unknown-id" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/mind/investigations", () => {
  it("keeps the catalog public but redacts the records anonymously", async () => {
    const res = await investigationsGET(req("/api/mind/investigations"));
    const body = (await res.json()) as { investigations: TaskRecord[]; redacted: boolean; tool: string; modes: string[] };
    expect(body.tool).toBe("nightshift.investigation");
    expect(body.modes).toEqual(["free", "intel"]);
    expect(body.redacted).toBe(true);
    const raw = JSON.stringify(body.investigations);
    expect(raw).not.toContain(SECRET_GOAL);
    expect(raw).not.toContain(SECRET_SUMMARY);
  });

  it("returns full investigations to the operator", async () => {
    const res = await investigationsGET(withBearer("/api/mind/investigations"));
    const body = (await res.json()) as { investigations: TaskRecord[]; redacted: boolean };
    expect(body.redacted).toBe(false);
    expect(body.investigations[0].goal).toBe(SECRET_GOAL);
  });
});

describe("GET /api/status", () => {
  it("hides database endpoint identifiers from anonymous callers", async () => {
    const res = await statusGET(req("/api/status"));
    const body = (await res.json()) as {
      ok: boolean;
      operatorSession: boolean;
      persistence: { connection?: string; hosts?: string[]; target?: string | null };
    };
    expect(body.operatorSession).toBe(false);
    expect(body.persistence.hosts).toBeUndefined();
    expect(body.persistence.target).toBeUndefined();
    expect(body.ok).toBe(true);
  });

  it("keeps endpoint identifiers available to the operator", async () => {
    const res = await statusGET(withBearer("/api/status"));
    const body = (await res.json()) as { operatorSession: boolean; persistence: { hosts?: string[]; target?: string | null } };
    expect(body.operatorSession).toBe(true);
    expect(Array.isArray(body.persistence.hosts)).toBe(true);
  });
});

describe("POST /api/session", () => {
  it("fails closed with a wrong token and never echoes secrets", async () => {
    const bad = await sessionPOST(
      req("/api/session", { "content-type": "application/json" }),
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const res = await sessionPOST(
      new NextRequest("http://localhost/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wrong-token" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.text())).not.toContain(TOKEN);
  });

  it("issues a derived HttpOnly verifier cookie for the correct token", async () => {
    const res = await sessionPOST(
      new NextRequest("http://localhost/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      }),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${OPERATOR_COOKIE}=${expectedOperatorCookieValue()}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain(TOKEN);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(body).toEqual({ ok: true, mode: "operator" });

    const out = await sessionDELETE();
    expect((out.headers.get("set-cookie") ?? "")).toMatch(/max-age=0/i);
  });
});

describe("authorization parts", () => {
  it("fails closed when no token is configured", () => {
    delete process.env.NIGHTSHIFT_API_TOKEN;
    expect(requestAuthorizedFromParts(TOKEN, undefined)).toBe(false);
    expect(requestAuthorizedFromParts(TOKEN, expectedOperatorCookieValue())).toBe(false);
    expect(expectedOperatorCookieValue()).toBe("");
  });

  it("rejects a forged or stale session cookie", () => {
    expect(requestAuthorizedFromParts("", "deadbeef")).toBe(false);
    expect(requestAuthorizedFromParts("", expectedOperatorCookieValue())).toBe(true);
  });

  it("parses the operator cookie from a cookie header", () => {
    const header = `other=1; ${OPERATOR_COOKIE}=abc; third=3`;
    expect(operatorCookieFromHeader(header)).toBe("abc");
    expect(operatorCookieFromHeader(null)).toBeUndefined();
  });
});

/* helper: the beforeEach-seeded task id */
function fullTaskId(): string {
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}
