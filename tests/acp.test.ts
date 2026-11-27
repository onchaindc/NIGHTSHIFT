import { afterEach, describe, expect, it, vi } from "vitest";

import { getTask } from "@/lib/engine/store";
import { approveTask } from "@/lib/engine/engine";
import type { TaskRecord } from "@/lib/engine/types";
import { setDeskCapabilityDeps, resetDeskCapabilityDeps } from "@/lib/desk/execute";
import { getDeskInvestigation } from "@/lib/desk/store";
import type { CapabilityRunnerDeps } from "@/lib/minds/capability-runner";
import type { ApprovedOffer, ProbeOutcome, VerifyOutcome } from "@/lib/terminal/ask";

import { ACP_OFFERINGS, offeringById, validateRequirement } from "@/lib/acp/offerings";
import { handleAcpEntry, tickAcpJobs } from "@/lib/acp/lifecycle";
import { getAcpJob } from "@/lib/acp/store";
import { acpConfig, MockAcpTransport, realAcpConfigured, selectAcpTransport } from "@/lib/acp/transport";
import { acpProviderStatus } from "@/lib/acp/runtime";
import type { DeskDeliverable } from "@/lib/acp/lifecycle";
import type { AcpSessionRef } from "@/lib/acp/types";

afterEach(() => resetDeskCapabilityDeps());

describe("acp configuration honesty", () => {
  it("treats real mode as configured only when the operator flips ACP_ENABLED AND all three credentials exist", () => {
    const saved = { ...process.env };
    try {
      for (const key of ["ACP_ENABLED", "ACP_PROVIDER_WALLET_ADDRESS", "ACP_WALLET_ID", "ACP_SIGNER_PRIVATE_KEY"]) delete process.env[key];
      expect(realAcpConfigured()).toBe(false);

      process.env.ACP_ENABLED = "true";
      process.env.ACP_PROVIDER_WALLET_ADDRESS = "0xabc";
      process.env.ACP_WALLET_ID = "wallet-id";
      // signer key missing → still not real
      expect(realAcpConfigured()).toBe(false);

      process.env.ACP_SIGNER_PRIVATE_KEY = "signer-key";
      expect(realAcpConfigured()).toBe(true);
      expect(acpConfig().enabled).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("selects the mock transport when enabled without credentials, and reports disabled status fields honestly", async () => {
    const saved = { ...process.env };
    try {
      for (const key of ["ACP_ENABLED", "ACP_PROVIDER_WALLET_ADDRESS", "ACP_WALLET_ID", "ACP_SIGNER_PRIVATE_KEY"]) delete process.env[key];
      const selected = await selectAcpTransport();
      expect(selected.transport).toBeNull();
      expect(selected.reason).toMatch(/ACP_ENABLED is not set/);

      const status = await acpProviderStatus();
      expect(status.mode).toBe("disabled");
      expect(status.runtimeStarted).toBe(false);
      expect(status.startupError).toBeNull();
      expect(status.connected).toBeNull();

      process.env.ACP_ENABLED = "true";
      process.env.ACP_PROVIDER_WALLET_ADDRESS = "0xabc";
      const mockSelected = await selectAcpTransport();
      expect(mockSelected.transport?.mode).toBe("mock");
    } finally {
      process.env = saved;
    }
  });
});

/* ------------------------------------------------------------------ */
/* Offerings — derived from the real desk workflows                    */
/* ------------------------------------------------------------------ */

describe("acp offerings", () => {
  it("publishes the four desk workflows as offerings, each with a schema, a price and the honest execution policy", () => {
    expect(ACP_OFFERINGS.map((o) => o.investigationType)).toEqual([
      "counterparty_due_diligence",
      "listing_underwriter",
      "asset_intelligence",
      "trade_supplier_intelligence",
    ]);
    for (const offering of ACP_OFFERINGS) {
      expect(offeringById(offering.id)).toBe(offering);
      expect(offering.inputs.length).toBeGreaterThan(3);
      expect(offering.inputs.some((i) => i.required)).toBe(true);
      expect(offering.priceUsdCents).toBeGreaterThan(0);
      expect(offering.outputs.length).toBeGreaterThan(40);
      // The policy must name the human gate, not imply autonomous paid execution.
      expect(offering.executionPolicy).toMatch(/approval gate/);
    }
  });

  it("validates a requirement against the offering schema: required inputs, unknown fields dropped", () => {
    const lu = offeringById("nightshift/listing-underwriter");
    expect(lu).toBeDefined();
    const ok = validateRequirement(lu!, {
      assetClass: "digital_asset",
      assetName: "USDC",
      tokenSymbol: "USDC",
      chain: "ethereum",
      issuerEntity: "Circle Internet Group, Inc.",
      issuerJurisdiction: "US",
      issuerWebsite: "circle.com",
      controllerName: "Named Controller",
      marketSubject: "Uniswap USDC/ETH",
      declaredSupply: "1000000000",
      notAField: "dropped",
    });
    expect(ok.ok).toBe(true);
    expect(ok.subject.assetClass).toBe("digital_asset");
    expect(ok.subject).not.toHaveProperty("notAField");

    const missing = validateRequirement(lu!, { assetName: "USDC" });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain("assetClass");
    expect(missing.error).toMatch(/assetClass/);
  });
});

/* ------------------------------------------------------------------ */
/* Vertical slice — mock transport, REAL pipeline                      */
/* ------------------------------------------------------------------ */

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

const LU_SUBJECT: Record<string, string> = {
  assetClass: "digital_asset",
  assetName: "USDC",
  tokenSymbol: "USDC",
  chain: "ethereum",
  issuerEntity: "Circle Internet Group, Inc.",
  issuerJurisdiction: "US",
  issuerWebsite: "circle.com",
  controllerName: "Named Controller",
  marketSubject: "Uniswap USDC/ETH",
  declaredSupply: "1000000000",
};

const COMMITTED_FIELDS: Record<string, unknown> = {
  legal_name: "Circle Internet Group, Inc.",
  registration_id: "US-1234",
  active: true,
  jurisdiction: "US-DE",
  registered_address: "1209 N Orange St",
  incorporated: "2019-04-02",
  token: "USDC",
  chain: "ethereum",
  holders_count: 9641462,
  total_supply: "1000000000",
  price_usd: 1.0001,
  liquidity_usd: 1200000,
  filing_count: 42,
  company: "Circle Internet Group, Inc.",
  headquarters: "New York, US",
};

function fakeDeps(overrides: Partial<CapabilityRunnerDeps> = {}): CapabilityRunnerDeps {
  return {
    probe: async () => CHALLENGE,
    execute: async () => {
      throw new Error("execute must not run without approval");
    },
    verify: async () => ({ kind: "unverified", detail: "x" }) as VerifyOutcome,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

const PAID_EXECUTE = (async (_input: { spec: { intent?: string } }) => ({
  kind: "answered" as const,
  urlPath: "/engine/v1/ask/x",
  requestSent: _input.spec,
  offer: OFFER,
  result: { ok: true },
  signalHash: "0xsignal",
  receipt: { receipt_hash: "0xreceipt", amount_uusdc: "10000" },
})) as unknown as CapabilityRunnerDeps["execute"];

const PAID_VERIFY = (async () =>
  ({
    kind: "verified",
    signalHash: "0xsignal",
    record: { payload: { response: COMMITTED_FIELDS } },
    note: "Independent re-derivation matches.",
  }) as VerifyOutcome) as unknown as CapabilityRunnerDeps["verify"];

async function waitForTaskState(taskId: string, want: string, timeoutMs = 10_000): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(taskId);
    if (task && (task.state === want || ["completed", "failed", "blocked", "rejected"].includes(task.state))) {
      expect(task.state, `task ${taskId}`).toBe(want);
      return task;
    }
    if (Date.now() > deadline) throw new Error(`task ${taskId} never reached ${want} (last: ${task?.state ?? "missing"})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startMock(): Promise<MockAcpTransport> {
  const transport = new MockAcpTransport();
  await transport.start({
    onEntry: async (ref, entry) => {
      await handleAcpEntry(transport, ref, entry);
    },
  });
  return transport;
}

describe("acp vertical slice (mock transport, real pipeline)", () => {
  it("prices an accepted job once, opens ONE investigation on funding, parks the paid run at the approval gate, and stays idempotent", async () => {
    setDeskCapabilityDeps(fakeDeps());
    const transport = await startMock();
    const ref: AcpSessionRef = { chainId: 8453, jobId: "701" };

    await transport.buyerJob(ref, JSON.stringify({ offering: "nightshift/listing-underwriter", inputs: LU_SUBJECT }));

    const accepted = await getAcpJob("8453:701");
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.priceUsdCents).toBe(offeringById("nightshift/listing-underwriter")?.priceUsdCents);
    expect(accepted?.requirement?.assetName).toBe("USDC");
    // The v2 acceptance act happened exactly once.
    expect(transport.callsOf("setBudget")).toHaveLength(1);
    expect(transport.callsOf("setBudget")[0]?.amountUsdCents).toBe(offeringById("nightshift/listing-underwriter")?.priceUsdCents);

    await transport.buyerFunded(ref);
    const funded = await getAcpJob("8453:701");
    expect(funded?.investigationId).toBeTruthy();
    const inv = await getDeskInvestigation(funded!.investigationId!);
    expect(inv?.type).toBe("listing_underwriter");
    expect(inv?.runs).toHaveLength(2);
    expect(inv?.spendLimitUsdCents).toBe(offeringById("nightshift/listing-underwriter")?.priceUsdCents);

    // The paid run is PARKED at the human gate with zero spend — the ACP
    // layer has no approval power whatsoever.
    const paidTask = await getTask(inv!.runs.find((r) => r.mode === "intel")!.taskId);
    expect(paidTask?.state).toBe("awaiting_approval");
    expect(paidTask?.spend.spentUsdCents).toBe(0);
    expect(paidTask?.spend.entries).toHaveLength(0);

    // The free pre-flight runs automatically and costs nothing.
    const freeTask = await waitForTaskState(inv!.runs.find((r) => r.mode === "free")!.taskId, "completed");
    expect(freeTask.spend.spentUsdCents).toBe(0);
    expect(freeTask.result?.capabilityReport?.counts.routable_unverified).toBeGreaterThan(0);
    expect(freeTask.result?.capabilityReport?.counts.verified).toBe(0);

    // A redelivered job + requirement is idempotent: same investigation, no
    // second price, no second investigation.
    await transport.buyerJob(ref, JSON.stringify({ offering: "nightshift/listing-underwriter", inputs: LU_SUBJECT }));
    await transport.buyerFunded(ref);
    const again = await getAcpJob("8453:701");
    expect(again?.investigationId).toBe(funded?.investigationId);
    expect(transport.callsOf("setBudget")).toHaveLength(1);
    expect((await getDeskInvestigation(funded!.investigationId!))?.runs).toHaveLength(2);
  });

  it("refuses an invalid or unknown requirement with a message and NEVER prices it", async () => {
    setDeskCapabilityDeps(fakeDeps());
    const transport = await startMock();

    await transport.buyerJob({ chainId: 8453, jobId: "802" }, JSON.stringify({ offering: "nightshift/listing-underwriter", inputs: { assetName: "USDC" } }));
    const invalid = await getAcpJob("8453:802");
    expect(invalid?.status).toBe("rejected_intake");
    expect(invalid?.priceUsdCents).toBeNull();
    expect(invalid?.investigationId).toBeNull();
    expect(transport.callsOf("setBudget")).toHaveLength(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(1);
    expect(transport.callsOf("sendMessage")[0]?.content).toMatch(/missing required input/);

    await transport.buyerJob({ chainId: 8453, jobId: "803" }, JSON.stringify({ offering: "nightshift/does-not-exist", inputs: {} }));
    const unknown = await getAcpJob("8453:803");
    expect(unknown?.status).toBe("rejected_intake");
    expect(transport.callsOf("sendMessage")[1]?.content).toMatch(/Published offerings/);
    // No investigation exists for either refusal.
    expect(await getDeskInvestigation((await getAcpJob("8453:802"))?.investigationId ?? "")).toBeNull();
  });

  it("delivers the evidence-backed deliverable only after a human approves, and completes only on the evaluator's event", async () => {
    setDeskCapabilityDeps(fakeDeps({ execute: PAID_EXECUTE, verify: PAID_VERIFY } as Partial<CapabilityRunnerDeps>));
    const transport = await startMock();
    const ref: AcpSessionRef = { chainId: 8453, jobId: "904" };

    await transport.buyerJob(ref, JSON.stringify({ offering: "nightshift/listing-underwriter", inputs: LU_SUBJECT }));
    await transport.buyerFunded(ref);
    const funded = await getAcpJob("8453:904");
    const inv = (await getDeskInvestigation(funded!.investigationId!))!;
    const paidTaskId = inv.runs.find((r) => r.mode === "intel")!.taskId;
    await waitForTaskState(inv.runs.find((r) => r.mode === "free")!.taskId, "completed");

    // Tick before approval: nothing is submitted; the job waits on the gate.
    await tickAcpJobs(transport);
    expect(transport.callsOf("submit")).toHaveLength(0);
    expect((await getAcpJob("8453:904"))?.status).toBe("awaiting_approval");
    expect((await getAcpJob("8453:904"))?.executionCostUsdCents).toBe(0);

    // THE HUMAN GATE — the same approveTask the console uses, nothing else
    // can move this task to executing.
    const approved = await approveTask(paidTaskId);
    expect(approved.state).toBe("completed");
    expect(approved.spend.spentUsdCents).toBeGreaterThan(0);

    // Tick 1: the run completed → the real report builder assembles the report.
    await tickAcpJobs(transport);
    expect(transport.callsOf("submit")).toHaveLength(0);
    const reported = await getDeskInvestigation(inv.id);
    expect(reported?.status).toBe("reported");
    expect(reported?.report).toBeTruthy();

    // Tick 2: the deliverable goes out — structured, receipted, honest.
    await tickAcpJobs(transport);
    expect(transport.callsOf("submit")).toHaveLength(1);
    const delivered = await getAcpJob("8453:904");
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.deliveredAt).toBeTruthy();

    const deliverable = JSON.parse(transport.callsOf("submit")[0]!.content!) as DeskDeliverable;
    expect(deliverable.kind).toBe("nightshift.desk.report.v1");
    expect(deliverable.reference).toBe(inv.reference);
    expect(deliverable.typeLabel).toBe("Listing Underwriter");
    expect(deliverable.reportSummary.counts.verified).toBeGreaterThan(0);
    expect(deliverable.spend.spentUsdCents).toBeGreaterThan(0);
    expect(deliverable.receipts.length).toBeGreaterThan(0);
    expect(deliverable.receipts.every((r) => r.signalHash && r.receiptHash)).toBe(true);
    // The full report travels with the deliverable.
    expect(deliverable.report?.headline).toBeTruthy();

    // Not completed yet — completion is the EVALUATOR's on-chain event.
    expect(delivered?.settlementSettled).toBe(false);

    await transport.evaluatorCompleted(ref);
    const settled = await getAcpJob("8453:904");
    expect(settled?.status).toBe("completed");
    expect(settled?.settlementSettled).toBe(true);
    expect(settled?.settlementUsdCents).toBe(funded?.priceUsdCents);
    // Delivery happened strictly before completion.
    expect(new Date(settled!.deliveredAt!).getTime()).toBeLessThanOrEqual(new Date(settled!.completedAt!).getTime());
  });

  it("never prices, never submits, never settles anything for a job the buyer never funds", async () => {
    setDeskCapabilityDeps(fakeDeps());
    const transport = await startMock();
    const ref: AcpSessionRef = { chainId: 8453, jobId: "905" };
    await transport.buyerJob(ref, JSON.stringify({ offering: "nightshift/listing-underwriter", inputs: LU_SUBJECT }));
    // No fund event. Tick does nothing but wait.
    const tick = await tickAcpJobs(transport);
    expect(tick.submitted).toHaveLength(0);
    expect((await getAcpJob("8453:905"))?.status).toBe("accepted");
    expect((await getAcpJob("8453:905"))?.investigationId).toBeNull();
    // The buyer walks away; the job expires without any investigation.
    await transport.expired(ref);
    expect((await getAcpJob("8453:905"))?.status).toBe("expired");
  });
});
