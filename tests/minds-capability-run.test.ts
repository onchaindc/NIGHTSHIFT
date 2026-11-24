import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/engine/store", () => ({ saveTask: vi.fn(async () => undefined) }));

import type { TaskRecord } from "@/lib/engine/types";
import { MINDS } from "@/lib/minds/registry";
import { CAPABILITIES } from "@/lib/minds/capabilities";
import { CapabilityPlanError, planCapabilityRun, type CapabilityRunPlan } from "@/lib/minds/capability-plan";
import { sampleParams, type CapabilityRunnerDeps } from "@/lib/minds/capability-runner";
import type { ApprovedOffer, ExecuteOutcome, ProbeOutcome, VerifyOutcome } from "@/lib/terminal/ask";
import {
  executeCapabilityAsk,
  executeCapabilityBaseline,
  executeCapabilityReport,
  resetCapabilityDeps,
  setCapabilityDeps,
} from "@/lib/mind/capability-execute";
import { POST as investigate } from "@/app/api/minds/[slug]/investigate/route";

const OFFER: ApprovedOffer = {
  scheme: "exact",
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

function inputsFor(slug: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const dim of CAPABILITIES[slug].dimensions) {
    if (dim.status !== "gap") out[dim.id] = sampleParams(dim);
  }
  return out;
}

function taskFor(plan: CapabilityRunPlan, allowed = true): TaskRecord {
  return {
    id: "task-capability",
    createdAt: 1,
    updatedAt: 1,
    state: "executing",
    goal: `capability ${plan.config.slug}`,
    plan: plan.steps,
    events: [],
    spend: { limitUsdCents: plan.budgetCeilingUsdCents, spentUsdCents: 0, entries: [] },
    permissions: { allowedActions: allowed ? ["telegraph.ask"] : [], requiresApproval: false, maxRetries: 0 },
    criteria: plan.criteria,
    result: null,
    error: null,
    origin: { source: "web" },
    jobType: "capability_run",
  };
}

function fakeDeps(overrides: Partial<CapabilityRunnerDeps> = {}): CapabilityRunnerDeps {
  return {
    probe: vi.fn(async () => CHALLENGE),
    execute: vi.fn(async () => {
      throw new Error("execute must not run in a free mode test");
    }),
    verify: vi.fn(async () => ({ kind: "unverified", detail: "x" }) as VerifyOutcome),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(() => resetCapabilityDeps());

describe("capability run planner", () => {
  it("builds a valid run for every Mind, using only supported dimensions", () => {
    for (const mind of MINDS) {
      const plan = planCapabilityRun(mind.slug, inputsFor(mind.slug), "free");
      expect(plan.steps.map((s) => s.kind)).toEqual(["capability_baseline", "capability_report"]);
      expect(plan.requiredInputs.length).toBe(CAPABILITIES[mind.slug].plan.order.length);
      expect(plan.budgetCeilingUsdCents).toBe(CAPABILITIES[mind.slug].plan.budgetCeilingUsdCents);
      expect(plan.criteria.primarySource).toBe("free");
      expect(plan.criteria.reconcileLedgerEntries).toBe(false);
    }
  });

  it("plans the paid step only in intel mode, with the plan ceiling", () => {
    const plan = planCapabilityRun("portsentinel", inputsFor("portsentinel"), "intel");
    expect(plan.steps.map((s) => s.kind)).toEqual(["capability_baseline", "capability_ask", "capability_report"]);
    expect(plan.steps.find((s) => s.kind === "capability_ask")?.maxCostUsdCents).toBe(7);
    expect(plan.criteria.primarySource).toBe("telegraph");
    expect(plan.criteria.reconcileLedgerEntries).toBe(true);
  });

  it("refuses a run with a missing or incomplete dimension input", () => {
    expect(() => planCapabilityRun("bitcoin-mining-intelligence", {}, "free")).toThrow(CapabilityPlanError);
    const inputs = inputsFor("bitcoin-mining-intelligence");
    delete inputs.energy_price;
    expect(() => planCapabilityRun("bitcoin-mining-intelligence", inputs, "free")).toThrow(/Energy|energy|Missing inputs/i);
    const bad = inputsFor("bitcoin-mining-intelligence");
    bad.hashprice_network = {};
    expect(() => planCapabilityRun("bitcoin-mining-intelligence", bad, "free")).toThrow(/block_height/);
  });

  it("rejects unknown Minds and invalid modes", () => {
    expect(() => planCapabilityRun("nope", {}, "free")).toThrow(/unknown Mind/);
    expect(() => planCapabilityRun("bitcoin-mining-intelligence", inputsFor("bitcoin-mining-intelligence"), "paid" as never)).toThrow(
      /mode/,
    );
  });

  it("does not expose an unauthenticated paid run through the API", async () => {
    const req = new NextRequest("http://localhost/api/minds/portsentinel/investigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: inputsFor("portsentinel"), mode: "intel" }),
    });
    const res = await investigate(req, { params: Promise.resolve({ slug: "portsentinel" }) });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("authorization required");

    const missing = new NextRequest("http://localhost/api/minds/nope/investigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: {}, mode: "free" }),
    });
    const notFound = await investigate(missing, { params: Promise.resolve({ slug: "nope" }) });
    expect(notFound.status).toBe(404);
  });
});

describe("capability run executor", () => {
  it("completes a free run without spend and reports routes plus gaps", async () => {
    setCapabilityDeps(fakeDeps());
    const plan = planCapabilityRun("bitcoin-mining-intelligence", inputsFor("bitcoin-mining-intelligence"), "free");
    const task = taskFor(plan);
    const outputs = {};
    await executeCapabilityBaseline(task, plan.steps[0].target, outputs as never);
    await executeCapabilityReport(task, plan.steps[1].target, outputs as never);

    expect(task.state).toBe("completed");
    expect(task.spend.entries).toHaveLength(0);
    expect(task.spend.spentUsdCents).toBe(0);
    const report = task.result?.capabilityReport;
    expect(report).toBeDefined();
    expect(report?.counts.routable_unverified).toBe(3);
    expect(report?.counts.gap).toBe(2);
    expect(report?.spendUsdCents).toBe(0);
    expect(task.result?.summary).toContain("Free mode");
  });

  it("enforces the telegraph.ask permission before any paid attempt", async () => {
    setCapabilityDeps(fakeDeps());
    const plan = planCapabilityRun("bitcoin-mining-intelligence", inputsFor("bitcoin-mining-intelligence"), "intel");
    const task = taskFor(plan, false);
    const outputs = {};
    await executeCapabilityBaseline(task, plan.steps[0].target, outputs as never);
    await expect(executeCapabilityAsk(task, plan.steps[1].target, outputs as never)).rejects.toThrow(/permission denied/);
    expect(task.spend.entries).toHaveLength(0);
  });

  it("executes approved asks, records spend and completes with a verified report", async () => {
    const execute = vi.fn(async () => {
      return {
        kind: "answered",
        urlPath: "/engine/v1/ask/x",
        requestSent: {},
        offer: OFFER,
        result: { ok: true },
        signalHash: "0xsignal",
        receipt: { receipt_hash: "0xreceipt", amount_uusdc: "10000" },
      } as ExecuteOutcome;
    });
    const verify = vi.fn(async () => ({
      kind: "verified",
      signalHash: "0xsignal",
      record: { payload: { response: { price_usd: 64000, hashprice_sats_per_ph_day: 50000, hashrate_eh_s: 700 } } },
      note: "re-derived",
    }) as VerifyOutcome);
    setCapabilityDeps(fakeDeps({ execute, verify }));

    const plan = planCapabilityRun("bitcoin-mining-intelligence", inputsFor("bitcoin-mining-intelligence"), "intel");
    const task = taskFor(plan);
    task.spend.limitUsdCents = 10;
    const outputs = {};
    await executeCapabilityBaseline(task, plan.steps[0].target, outputs as never);
    await executeCapabilityAsk(task, plan.steps[1].target, outputs as never);
    await executeCapabilityReport(task, plan.steps[2].target, outputs as never);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(task.spend.spentUsdCents).toBe(3);
    expect(task.spend.entries).toHaveLength(3);
    expect(task.state).toBe("completed");
    expect(task.result?.capabilityReport?.counts.verified).toBe(3);
    expect(task.result?.evidence.length).toBe(6);
  });

  it("does not mark a recorded signal as verified", async () => {
    setCapabilityDeps(
      fakeDeps({
        execute: vi.fn(async () => ({
          kind: "answered",
          urlPath: "/engine/v1/ask/x",
          requestSent: {},
          offer: OFFER,
          result: {},
          signalHash: "0xsignal",
          receipt: { receipt_hash: "0xreceipt", amount_uusdc: "10000" },
        }) as ExecuteOutcome),
        verify: vi.fn(async () => ({
          kind: "recorded",
          signalHash: "0xsignal",
          record: { payload: { response: { price_usd: 1 } } },
          note: "hash mismatch",
        }) as VerifyOutcome),
      }),
    );
    const plan = planCapabilityRun("bitcoin-mining-intelligence", inputsFor("bitcoin-mining-intelligence"), "intel");
    const task = taskFor(plan);
    task.spend.limitUsdCents = 10;
    const outputs = {};
    await executeCapabilityBaseline(task, plan.steps[0].target, outputs as never);
    await executeCapabilityAsk(task, plan.steps[1].target, outputs as never);
    await executeCapabilityReport(task, plan.steps[2].target, outputs as never);
    expect(task.result?.capabilityReport?.counts.verified).toBe(0);
    expect(task.result?.capabilityReport?.counts.recorded).toBe(3);
    expect(task.result?.summary).toContain("recorded");
  });
});
