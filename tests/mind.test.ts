import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { defaultDeps, approveTask, createTask, runTask } from "@/lib/engine/engine";
import { getTask } from "@/lib/engine/store";
import { COUNTERPARTY_INTENT, COUNTERPARTY_PRIMARY_MINER, type CounterpartyClassification } from "@/lib/counterparty/intel";
import type { ExecuteInput } from "@/lib/terminal/ask";
import { parseInvestigationObjective, planMindInvestigation } from "@/lib/mind/plan";
import { resetMindDeps, setMindDeps } from "@/lib/mind/execute";
import { mindsBuilderConfigured, notifyMindReport } from "@/lib/mind/builder";
import { POST as investigationsPOST } from "@/app/api/mind/investigations/route";

/**
 * Mind investigation pipeline tests. All network effects are injected through
 * setMindDeps: the unpaid probe, the paid ask, the post-purchase analysis and
 * the Minds delivery. Nothing here touches the real Telegraph node, so the
 * suite is hermetic and spends nothing.
 */

const SIGNAL = `0x${"ab".repeat(32)}`;
const OFFER = {
  scheme: "exact",
  network: "eip155:11155111",
  asset: "0x036CbD531e46eE0A60F9E5BA78E9a8efCFBD2d35",
  payTo: "0x1234567890abcdef1234567890abcdef12345678",
  amount: "1000000", // $1.00 in 6-decimal USDC units
};

const receipt = () => ({
  receipt_hash: "0xreceipt",
  rail: "x402",
  payer: "0x1234567890abcdef1234567890abcdef12345678",
  miner: COUNTERPARTY_PRIMARY_MINER,
  intent: COUNTERPARTY_INTENT,
  amount_uusdc: "1000000",
  epoch_id: 1,
  settlement: "settled",
  chain: "base-sepolia",
  timestamp: Date.now(),
});

const probeChallenge = () => ({
  kind: "challenge" as const,
  spec: { intent: COUNTERPARTY_INTENT, params: { company: "Equinor ASA" }, minerId: COUNTERPARTY_PRIMARY_MINER },
  urlPath: `/engine/v1/ask/${COUNTERPARTY_PRIMARY_MINER}`,
  body: { intent: COUNTERPARTY_INTENT, params: { company: "Equinor ASA" } },
  approvedOffer: OFFER,
  priceUsd: 1.0,
});

function classification(): CounterpartyClassification {
  return {
    facts: [
      { field: "legal_name", value: "EQUINOR ASA" },
      { field: "registration_id", value: "923 609 016" },
      { field: "lei", value: "OW6OFBNCKXC4US5C7523" },
      { field: "active", value: true },
      { field: "jurisdiction", value: "NO" },
    ],
    missing: ["registered_address", "incorporated", "legal_form", "register"],
    disagreements: [
      {
        field: "active",
        left: { source: "committed payload", value: true },
        right: { source: "paid body result", value: false },
        note: "the router summary disagrees with the committed answer",
      },
    ],
    extras: {},
    meta: {
      confidence: 0.9,
      asOf: "2026-11-22T19:59:25.203Z",
      register: "Brønnøysund Register Centre",
      sources: ["https://api.gleif.org/api/v1/lei-records/OW6OFBNCKXC4US5C7523"],
    },
  };
}

function answeredOutcome() {
  return {
    kind: "answered" as const,
    urlPath: `/engine/v1/ask/${COUNTERPARTY_PRIMARY_MINER}`,
    requestSent: {},
    offer: OFFER,
    result: { summary: "EQUINOR ASA is active" },
    resultShape: COUNTERPARTY_INTENT,
    signalHash: SIGNAL,
    receipt: receipt(),
  };
}

beforeEach(() => {
  resetMindDeps();
});
afterEach(() => {
  resetMindDeps();
  vi.restoreAllMocks();
  delete process.env.MINDS_BUILDER_API_KEY;
  delete process.env.MINDS_BUILDER_ALIAS;
  delete process.env.MINDS_BUILDER_SEND_URL;
});

describe("objective parsing", () => {
  it("extracts a quoted company verbatim", () => {
    const p = parseInvestigationObjective('Investigate "Equinor ASA"');
    expect(p.entity?.company).toBe("Equinor ASA");
    expect(p.entity?.jurisdiction).toBeUndefined();
  });

  it("extracts a verb-framed company plus a known jurisdiction code", () => {
    const p = parseInvestigationObjective("Due diligence on Equinor ASA in Norway");
    expect(p.entity?.company).toBe("Equinor ASA");
    expect(p.entity?.jurisdiction).toBe("NO");
    expect(p.assumptions.some((a) => a.includes("NO"))).toBe(true);
  });

  it("reads a bare objective as a company name and says so", () => {
    const p = parseInvestigationObjective("Equinor ASA in Norway");
    expect(p.entity?.company).toBe("Equinor ASA");
    expect(p.entity?.jurisdiction).toBe("NO");
    expect(p.assumptions.some((a) => a.startsWith("no explicit investigation verb"))).toBe(true);
  });

  it("refuses to invent an entity from an unparseable objective", () => {
    expect(parseInvestigationObjective("???").entity).toBeNull();
    expect(parseInvestigationObjective("").entity).toBeNull();
  });
});

describe("planning", () => {
  it("intel mode plans baseline → paid ask → report", () => {
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "intel");
    expect(plan.blocker).toBeUndefined();
    expect(plan.steps.map((s) => s.kind)).toEqual(["mind_baseline", "counterparty_ask", "mind_report"]);
    expect(plan.criteria.primarySource).toBe("telegraph");
    expect(plan.steps[1].description).toContain("no retry");
  });

  it("free mode never plans a purchase", () => {
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "free");
    expect(plan.steps.map((s) => s.kind)).toEqual(["mind_baseline", "mind_report"]);
    expect(plan.criteria.primarySource).toBe("free");
  });

  it("an unparseable objective yields a blocker instead of a plan", () => {
    const plan = planMindInvestigation("???", "intel");
    expect(plan.blocker).toBeTruthy();
    expect(plan.steps).toHaveLength(0);
  });
});

describe("free-mode investigation (no purchase path)", () => {
  it("completes with the honest baseline and $0 spend", async () => {
    setMindDeps({
      probe: async () => probeChallenge(),
      notify: async () => ({ ok: false, detail: "not_configured" }),
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
    expect(task.state).toBe("executing");
    const done = await runTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    expect(done.spend.spentUsdCents).toBe(0);
    expect(done.result?.mindReport?.intelUsed).toBe(false);
    expect(done.result?.mindReport?.confidence).toBe("routing-only");
    expect(done.result?.mindReport?.baseline?.unknownFields).toHaveLength(9);
    expect(done.result?.summary).toContain("free mode");
    expect(done.result?.summary).toContain("$1.00 per ask");
    const finding = done.result?.evidence.find((e) => e.kind === "counterparty_finding");
    expect(finding && finding.kind === "counterparty_finding" ? finding.probeStatus : null).toBe("challenge");
  });
});

describe("intel-mode investigation (approval-gated paid ask)", () => {
  it("stops at awaiting_approval with zero spend before approval", async () => {
    const execute = vi.fn(async () => answeredOutcome());
    setMindDeps({ probe: async () => probeChallenge(), execute });
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "intel");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: true,
    });
    expect(task.state).toBe("awaiting_approval");
    expect(task.spend.spentUsdCents).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("approval runs the paid ask once, verifies, and compares with the baseline", async () => {
    const execute = vi.fn(async (_input: ExecuteInput) => answeredOutcome());
    setMindDeps({
      probe: async () => probeChallenge(),
      execute,
      analyze: async () => ({
        kind: "analyzed" as const,
        signalHash: SIGNAL,
        verification: { kind: "verified" as const, signalHash: SIGNAL, record: {}, note: "keccak match" },
        committed: { legal_name: "EQUINOR ASA" },
        classification: classification(),
      }),
      notify: async () => ({ ok: false, detail: "not_configured" }),
    });
    const plan = planMindInvestigation('Investigate "Equinor ASA" in Norway', "intel");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA" in Norway',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: true,
      spendLimitUsdCents: 100,
    });
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1); // one paid attempt, no retry
    expect(execute.mock.calls[0][0].approved).toBe(true);
    expect(execute.mock.calls[0][0].approvedOffer).toEqual(OFFER);

    expect(done.spend.spentUsdCents).toBe(100); // $1.00 against the $1.00 limit
    expect(done.spend.entries[0]?.signalHash).toBe(SIGNAL);

    const report = done.result?.mindReport;
    expect(report?.intelUsed).toBe(true);
    expect(report?.confidence).toBe("signal-verified");
    expect(report?.entity?.jurisdiction).toBe("NO");
    expect(report?.comparison?.verified).toBe(true);
    expect(report?.comparison?.fieldsKnownBefore).toBe(0);
    expect(report?.comparison?.fieldsKnownAfter).toBe(5);
    expect(report?.comparison?.fieldsTotal).toBe(9);
    expect(report?.comparison?.remainingGaps).toHaveLength(4);
    expect(report?.comparison?.conflicts).toHaveLength(1);
    expect(report?.comparison?.costUsdCents).toBe(100);
    expect(report?.reasoning.some((r) => r.includes("signal-verified") === false && r.includes("verified against the registry"))).toBe(true);

    expect(done.result?.summary).toContain("With specialist intelligence: 5/9");
    expect(done.result?.summary).toContain("Conflicts left unresolved: active");

    const types = done.events.map((e) => e.type);
    expect(types).toContain("plan_approved");
    expect(types).toContain("mind_baseline_ready");
    expect(types).toContain("spend_recorded");
    expect(types).toContain("verification_passed");
    expect(types).toContain("task_completed");

    const finding = done.result?.evidence.find((e) => e.kind === "counterparty_finding");
    if (finding && finding.kind === "counterparty_finding") {
      expect(finding.signalHash).toBe(SIGNAL);
      expect(finding.verificationStatus).toBe("verified");
      expect(finding.facts).toHaveLength(5);
    } else {
      throw new Error("counterparty_finding evidence missing");
    }
  });

  it("an unverified purchase is reported but excluded from the comparison", async () => {
    setMindDeps({
      probe: async () => probeChallenge(),
      execute: async () => answeredOutcome(),
      analyze: async () => ({
        kind: "unverified" as const,
        signalHash: SIGNAL,
        verification: { kind: "unverified" as const, detail: "the node returned no record" },
      }),
      notify: async () => ({ ok: false, detail: "not_configured" }),
    });
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "intel");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: true,
    });
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    expect(done.result?.mindReport?.confidence).toBe("unverified");
    expect(done.result?.mindReport?.comparison?.verified).toBe(false);
    expect(done.result?.mindReport?.comparison?.fieldsKnownAfter).toBe(0);
    expect(done.result?.mindReport?.comparison?.conflicts).toHaveLength(0);
    expect(done.result?.summary).toContain("excluded from the fact set");
  });

  it("a drifted live offer refuses before anything is signed, with no retry", async () => {
    const execute = vi.fn(async () => ({
      kind: "refused" as const,
      reason: "The live challenge drifted from what was approved (amount changed).",
    }));
    setMindDeps({ probe: async () => probeChallenge(), execute, notify: async () => ({ ok: false, detail: "not_configured" }) });
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "intel");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: true,
    });
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(1); // terminal refusal, never retried
    expect(done.spend.spentUsdCents).toBe(0);
    expect(done.error).toContain("drifted");
    expect(done.result).toBeNull();
  });

  it("an unreconcilable paid delivery fails the task and is never re-sent", async () => {
    const execute = vi.fn(async () => ({ kind: "integrity" as const, detail: "settlement header missing" }));
    setMindDeps({ probe: async () => probeChallenge(), execute, notify: async () => ({ ok: false, detail: "not_configured" }) });
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "intel");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: true,
    });
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(done.error).toContain("NEVER");
    // Conservative accounting: the settlement may have begun, so the approved
    // price is booked even though no receipt came back.
    expect(done.spend.spentUsdCents).toBe(100);
    expect(done.events.map((e) => e.type)).toContain("spend_recorded");
  });

  it("a settled-but-failed paid ask books the approved amount conservatively", async () => {
    const execute = vi.fn(async () => ({
      kind: "failed" as const,
      status: 500,
      paymentSettled: true,
      detail: 'The paid request failed after settlement may have begun: HTTP 500 {"error":"miner error 404 [NOT_FOUND]"}',
    }));
    setMindDeps({ probe: async () => probeChallenge(), execute, notify: async () => ({ ok: false, detail: "not_configured" }) });
    const plan = planMindInvestigation('Investigate "Equinor ASA"', "intel");
    const task = await createTask({
      goal: 'Investigate "Equinor ASA"',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: true,
      spendLimitUsdCents: 300,
    });
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(1); // one paid attempt, no retry
    expect(done.spend.spentUsdCents).toBe(100); // the approved $1.00, booked conservatively
    const types = done.events.map((e) => e.type);
    expect(types).toContain("spend_recorded");
    expect(types).toContain("step_failed");
  });

  it("the paid ask resends the identity-resolved params from the pre-flight, not a rebuild from the entity", async () => {
    const execute = vi.fn(async (_input: ExecuteInput) => answeredOutcome());
    const resolvedProbe = {
      ...probeChallenge(),
      body: { intent: COUNTERPARTY_INTENT, params: { company: "MARA HOLDINGS, INC.", jurisdiction: "US", lei: "549300M8ISKPTX2W7F94" } },
      resolvedIdentity: { lei: "549300M8ISKPTX2W7F94", legalName: "MARA HOLDINGS, INC.", country: "US", status: "ACTIVE" },
    };
    setMindDeps({
      probe: async () => resolvedProbe,
      execute,
      analyze: async () => ({
        kind: "analyzed" as const,
        signalHash: SIGNAL,
        verification: { kind: "verified" as const, signalHash: SIGNAL, record: {}, note: "keccak match" },
        committed: { legal_name: "EQUINOR ASA" },
        classification: classification(),
      }),
      notify: async () => ({ ok: false, detail: "not_configured" }),
    });
    const plan = planMindInvestigation('Investigate "MARA Holdings" in United States', "intel");
    const task = await createTask({
      goal: 'Investigate "MARA Holdings" in United States',
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: plan.assumptions,
      requiresApproval: true,
      spendLimitUsdCents: 300,
    });
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].spec.params).toEqual({ company: "MARA HOLDINGS, INC.", jurisdiction: "US", lei: "549300M8ISKPTX2W7F94" });
    // The approval trail names the resolved legal identity explicitly.
    const ready = done.events.find((e) => e.type === "mind_baseline_ready");
    expect(ready?.message).toContain("MARA HOLDINGS, INC.");
    expect(ready?.message).toContain("549300M8ISKPTX2W7F94");
  });
});

describe("Minds Builder API adapter (official interface)", () => {
  it("skips honestly when the key or a bound alias is missing", async () => {
    expect(mindsBuilderConfigured()).toBe(false);
    const r = await notifyMindReport({ task: { id: "t1", goal: "g", state: "completed" }, report: { objective: "g", confidence: "none", intelUsed: false, reasoning: [] } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not_configured");
    process.env.MINDS_BUILDER_API_KEY = "builder-key";
    expect(mindsBuilderConfigured()).toBe(false);
  });

  it("posts {alias, messageText} with X-Api-Key to the documented endpoint", async () => {
    process.env.MINDS_BUILDER_API_KEY = "builder-key";
    process.env.MINDS_BUILDER_ALIAS = "nightshift";
    expect(mindsBuilderConfigured()).toBe(true);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response("{}", { status: 200 }));
    const r = await notifyMindReport(
      {
        task: { id: "t1", goal: "g", state: "completed", summary: "s" },
        report: { objective: "g", confidence: "signal-verified", intelUsed: true, reasoning: ["r"] },
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.build.hellominds.ai/v1/messaging/message");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("X-Api-Key")).toBe("builder-key");
    expect(headers.get("X-Builder-Api-Key")).toBeNull();
    expect(headers.get("X-Access-Key")).toBeNull();
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.alias).toBe("nightshift");
    expect(body.messageText).toContain("signal-verified");
    expect(body.kind).toBeUndefined();
  });
});

describe("investigations tool endpoint", () => {
  const originalToken = process.env.NIGHTSHIFT_API_TOKEN;

  const req = (init: { body?: string; auth?: string }) =>
    new NextRequest("http://localhost/api/mind/investigations", {
      method: "POST",
      headers: init.auth ? { Authorization: init.auth } : {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    });

  beforeEach(() => {
    process.env.NIGHTSHIFT_API_TOKEN = "unit-test-operator-token";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = originalToken;
  });

  it("rejects unauthenticated investigation requests with 401", async () => {
    const res = await investigationsPOST(req({ body: JSON.stringify({ objective: "x" }) }));
    expect(res.status).toBe(401);
  });

  it("validates the body after authentication", async () => {
    const res = await investigationsPOST(req({ body: "not json", auth: "Bearer unit-test-operator-token" }));
    expect(res.status).toBe(400);
    const res2 = await investigationsPOST(
      req({ body: JSON.stringify({ objective: "Equinor ASA", mode: "sneaky" }), auth: "Bearer unit-test-operator-token" }),
    );
    expect(res2.status).toBe(400);
  });

  it("returns 422 with the planner's blocker for an unparseable objective", async () => {
    const res = await investigationsPOST(
      req({ body: JSON.stringify({ objective: "???" }), auth: "Bearer unit-test-operator-token" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not name a company");
  });

  it("describes the tool on GET", async () => {
    const { GET } = await import("@/app/api/mind/investigations/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://localhost/api/mind/investigations"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tool: string; modes: string[] };
    expect(body.tool).toBe("nightshift.investigation");
    expect(body.modes).toEqual(["free", "intel"]);
  });
});

describe("task record integrity", () => {
  it("persists the mind jobType and is retrievable through the shared store", async () => {
    setMindDeps({ probe: async () => probeChallenge(), notify: async () => ({ ok: false, detail: "not_configured" }) });
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
    await runTask(task.id, defaultDeps());
    const stored = await getTask(task.id);
    expect(stored?.jobType).toBe("mind_investigation");
    expect(stored?.state).toBe("completed");
    expect(stored?.result?.mindReport?.baseline?.entity.company).toBe("Equinor ASA");
  });
});
