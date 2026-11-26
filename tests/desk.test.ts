/**
 * Deal Desk specialised investigation workflows.
 *
 * Pinned here:
 *  - every workflow capability reference resolves to a REAL verified matrix
 *    dimension and never to a gap;
 *  - every declared gap is a real matrix gap;
 *  - dimension ids are unique per workflow (no double pay for one ask);
 *  - create/parse validation per type, including declared unsupported
 *    requirements and declared-input evidence;
 *  - planning: capability selection from the subject, honest input gaps;
 *  - engine executors: free run completes without spend; paid run under
 *    approval records spend and completes; a failed ledger refuses;
 *  - evidence absorption with explicit provenance (verified / unverified /
 *    missing) and the structured report (findings, discrepancies, sections,
 *    limitations, outstanding questions).
 */

import { describe, expect, it, afterEach, vi } from "vitest";

import { parseCreateDeskBody, declaredInputEvidence, deskSubjectLine } from "@/lib/desk/create";
import { resetDeskCapabilityDeps, setDeskCapabilityDeps, parseDeskConfig, executeDeskBaseline, executeDeskIntel, executeDeskReport } from "@/lib/desk/execute";
import { buildDeskReport, planDeskCapabilities, syncDeskInvestigation } from "@/lib/desk/orchestrate";
import { saveTask } from "@/lib/engine/store";
import type { TaskRecord } from "@/lib/engine/types";
import type { CapabilityRunnerDeps, CommittedDimension } from "@/lib/minds/capability-runner";
import type { ApprovedOffer, ProbeOutcome, VerifyOutcome } from "@/lib/terminal/ask";
import type { DeskInvestigation, DeskInvestigationType } from "@/lib/desk/types";
import { DESK_TYPE_LABEL } from "@/lib/desk/types";
import {
  capabilityKey,
  DESK_TYPE_ORDER,
  DESK_WORKFLOWS,
  describeDeskWorkflow,
  resolveDeskCapability,
  resolveDeskGap,
} from "@/lib/desk/workflows";

afterEach(() => resetDeskCapabilityDeps());

/* ------------------------------------------------------------------ */
/* Workflow registry integrity                                         */
/* ------------------------------------------------------------------ */

describe("desk workflow registry", () => {
  it("defines exactly the three specialised workflows", () => {
    expect(DESK_TYPE_ORDER).toEqual([
      "counterparty_due_diligence",
      "asset_intelligence",
      "trade_supplier_intelligence",
    ]);
    for (const type of DESK_TYPE_ORDER) {
      const w = DESK_WORKFLOWS[type];
      expect(w.name).toBe(DESK_TYPE_LABEL[type]);
      expect(w.fields.length).toBeGreaterThan(3);
      expect(w.sections.length).toBeGreaterThan(1);
      expect(w.honestyNotes.length).toBeGreaterThan(0);
    }
  });

  it("references only real, non-gap matrix dimensions — no fabricated capability", () => {
    for (const type of DESK_TYPE_ORDER) {
      for (const ref of DESK_WORKFLOWS[type].capabilities) {
        const dim = resolveDeskCapability(ref);
        expect(dim.status, `${capabilityKey(ref)} must not be a gap`).not.toBe("gap");
        expect(dim.intent, `${capabilityKey(ref)} must carry an intent`).toBeTruthy();
        expect(dim.provider, `${capabilityKey(ref)} must carry a provider`).toBeTruthy();
      }
    }
  });

  it("declares only real matrix gaps as unsupported requirements, each with a reason and a resolution", () => {
    for (const type of DESK_TYPE_ORDER) {
      for (const ref of DESK_WORKFLOWS[type].gapRefs) {
        const gap = resolveDeskGap(ref);
        expect(gap.status).toBe("gap");
        expect(gap.missingReason?.length ?? 0).toBeGreaterThan(10);
      }
      const summary = DESK_WORKFLOWS[type];
      void summary;
      const described = describeDeskWorkflow(type);
      for (const g of described.unsupported) {
        expect(g.reason.length).toBeGreaterThan(10);
        expect(g.resolution.length).toBeGreaterThan(10);
      }
    }
  });

  it("never plans the same dimension twice inside one workflow", () => {
    for (const type of DESK_TYPE_ORDER) {
      const keys = DESK_WORKFLOWS[type].capabilities.map(capabilityKey);
      expect(new Set(keys).size).toBe(keys.length);
      const dimIds = DESK_WORKFLOWS[type].capabilities.map((r) => r.dimension);
      expect(new Set(dimIds).size).toBe(dimIds.length);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Create / parse                                                      */
/* ------------------------------------------------------------------ */

function cddSubject() {
  return { legalName: "Acme Holdings Limited", jurisdiction: "US", website: "acme.example", claim: "Acme completed its 2025 audit." };
}

describe("desk create/parse", () => {
  it("refuses unknown types and missing required fields", () => {
    expect(parseCreateDeskBody({ type: "nope", subject: {} }).ok).toBe(false);
    expect(parseCreateDeskBody({ type: "counterparty_due_diligence" }).ok).toBe(false);
    const missing = parseCreateDeskBody({ type: "counterparty_due_diligence", subject: { legalName: "Acme" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/Jurisdiction/);
    const badSelect = parseCreateDeskBody({ type: "asset_intelligence", subject: { assetClass: "yacht", assetName: "X" } });
    expect(badSelect.ok).toBe(false);
  });

  it("opens a counterparty file with declared unsupported requirements and declared-input evidence", () => {
    const parsed = parseCreateDeskBody({ type: "counterparty_due_diligence", subject: cddSubject() }, "tester", "0xABC");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const inv = parsed.investigation;
    expect(inv.kind).toBe("desk");
    expect(inv.owner).toBe("0xabc");
    expect(inv.spendLimitUsdCents).toBe(10);
    expect(inv.reference.startsWith("NS-CP")).toBe(true);
    // The four named gaps, resolved from the matrix with reasons.
    expect(inv.unsupported.map((g) => g.capabilityKey)).toEqual([
      "counterparty-intelligence:group_structure",
      "ownershipgraph:beneficial_ownership",
      "caseledger:docket_retrieval",
      "caseledger:jurisdiction_coverage",
    ]);
    for (const g of inv.unsupported) {
      expect(g.reason.length).toBeGreaterThan(10);
      expect(g.resolution.length).toBeGreaterThan(10);
    }
    // Declared inputs are evidence of class "declared", never verified.
    const declared = declaredInputEvidence(inv);
    expect(declared.map((d) => d.id)).toContain("declared:legalName");
    expect(declared.every((d) => d.provenance === "unverified" && d.class === "declared")).toBe(true);
    expect(deskSubjectLine(inv)).toContain("Acme Holdings Limited");
  });

  it("opens asset and trade files with type-specific references", () => {
    const asset = parseCreateDeskBody({ type: "asset_intelligence", subject: { assetClass: "mining", assetName: "Site 4" } });
    expect(asset.ok).toBe(true);
    const trade = parseCreateDeskBody({ type: "trade_supplier_intelligence", subject: { supplierName: "Siemens AG", jurisdiction: "DE" } });
    expect(trade.ok).toBe(true);
    if (trade.ok) {
      expect(trade.investigation.reference.startsWith("NS-TR")).toBe(true);
      expect(trade.investigation.unsupported.some((g) => g.capabilityKey === "tradeverify:documents")).toBe(true);
    }
    if (asset.ok) {
      expect(asset.investigation.unsupported.some((g) => g.capabilityKey === "minewatch:licences")).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

function deskInv(type: DeskInvestigationType, subject: Record<string, string>): DeskInvestigation {
  const parsed = parseCreateDeskBody({ type, subject });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.investigation;
}

describe("desk planning", () => {
  it("plans the counterparty capabilities with canonical params, and names input gaps honestly", () => {
    const inv = deskInv("counterparty_due_diligence", cddSubject());
    const plan = planDeskCapabilities(inv);
    const keys = plan.capabilities.map((c) => c.key);
    expect(keys).toContain("counterparty-intelligence:registry");
    expect(keys).toContain("sanctionsdesk:name_screening");
    expect(keys).toContain("ownershipgraph:filings");
    expect(keys).toContain("caseledger:fact_check");
    const registry = plan.capabilities.find((c) => c.key === "counterparty-intelligence:registry");
    expect(registry?.params).toEqual({ company: "Acme Holdings Limited", jurisdiction: "US" });
    expect(plan.inputGaps).toEqual([]);
    expect(plan.unsupported).toHaveLength(4);
  });

  it("without the optional claim the claim-check capability is a named input gap, never asked", () => {
    const inv = deskInv("counterparty_due_diligence", { legalName: "Acme", jurisdiction: "US" });
    const plan = planDeskCapabilities(inv);
    expect(plan.capabilities.map((c) => c.key)).not.toContain("caseledger:fact_check");
    const gap = plan.inputGaps.find((g) => g.key === "caseledger:fact_check");
    expect(gap).toBeDefined();
    expect(gap?.required.join(" ")).toMatch(/claim/i);
  });

  it("asset class decides the capability set — no route outside the class is planned", () => {
    const digital = planDeskCapabilities(deskInv("asset_intelligence", { assetClass: "digital_asset", assetName: "w1", walletAddress: "0xabc", chain: "base" }));
    const digitalKeys = digital.capabilities.map((c) => c.key);
    expect(digitalKeys).toContain("chainforensics:wallet_balance");
    expect(digitalKeys.every((k) => k.startsWith("chainforensics:"))).toBe(true);
    expect(digitalKeys).not.toContain("chainforensics:tx_lookup");

    const mining = planDeskCapabilities(deskInv("asset_intelligence", { assetClass: "mining", assetName: "Site 4", operatorEntity: "BHP Group", jurisdiction: "AU", gridNode: "HB_WEST", intervalStart: "2026-11-23T00:00:00-06:00" }));
    const miningKeys = mining.capabilities.map((c) => c.key);
    expect(miningKeys).toContain("bitcoin-mining-intelligence:btc_price");
    expect(miningKeys).toContain("minewatch:owner_registry");
    expect(miningKeys.every((k) => k.startsWith("bitcoin-mining") || k.startsWith("minewatch") || k.startsWith("energywatch"))).toBe(true);
    // hashprice needs a block height; without it, it is a named input gap.
    expect(miningKeys).not.toContain("bitcoin-mining-intelligence:hashprice_network");
    expect(mining.inputGaps.map((g) => g.key)).toContain("bitcoin-mining-intelligence:hashprice_network");

    const energy = planDeskCapabilities(deskInv("asset_intelligence", { assetClass: "energy", assetName: "Substation", siteLocation: "Houston, TX", pastDate: "2026-11-20" }));
    const energyKeys = energy.capabilities.map((c) => c.key);
    expect(energyKeys.every((k) => k.startsWith("energywatch"))).toBe(true);
    expect(energyKeys).toContain("energywatch:weather_history");
  });

  it("trade planning asks the document routes only when their identifiers were supplied", () => {
    const base = planDeskCapabilities(deskInv("trade_supplier_intelligence", { supplierName: "Siemens AG", jurisdiction: "DE" }));
    const baseKeys = base.capabilities.map((c) => c.key);
    expect(baseKeys).toContain("tradeverify:counterparty_registry");
    expect(baseKeys).not.toContain("tradeverify:po_verify");
    expect(base.inputGaps.map((g) => g.key)).toContain("tradeverify:po_verify");

    const full = planDeskCapabilities(
      deskInv("trade_supplier_intelligence", {
        supplierName: "Siemens AG",
        jurisdiction: "DE",
        poNumber: "PO-2026-1042",
        invoiceRef: "INV-2026-1042",
        ledgerRef: "INV-2026-1042 12000 USD",
        originPort: "Rotterdam",
        destinationPort: "Singapore",
        weightKg: "12000",
        vesselName: "MSC ISABELLA",
      }),
    );
    const fullKeys = full.capabilities.map((c) => c.key);
    expect(fullKeys).toContain("tradeverify:po_verify");
    expect(fullKeys).toContain("tradeverify:invoice_reconcile");
    expect(fullKeys).toContain("portsentinel:ship_rate");
    expect(fullKeys).toContain("portsentinel:vessel_telemetry");
    const shipRate = full.capabilities.find((c) => c.key === "portsentinel:ship_rate");
    expect(shipRate?.params).toEqual({ origin: "Rotterdam", destination: "Singapore", weight_kg: 12000 });
  });
});

/* ------------------------------------------------------------------ */
/* Engine executors (free + paid, offline with fake deps)              */
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

function taskFor(): TaskRecord {
  return {
    id: "task-desk",
    createdAt: 1,
    updatedAt: 1,
    state: "executing",
    goal: "desk test",
    plan: null,
    events: [],
    spend: { limitUsdCents: 10, spentUsdCents: 0, entries: [] },
    permissions: { allowedActions: ["telegraph.ask"], requiresApproval: false, maxRetries: 0 },
    criteria: {
      primaryVerifiedAgainstNodeSignal: true,
      answerSane: true,
      answerMaxAgeSeconds: 3600,
      ownPaymentSettledOnChain: false,
      reconcileLedgerEntries: true,
    },
    result: null,
    error: null,
    origin: { source: "web" },
    jobType: "capability_run",
  };
}

function fakeDeps(overrides: Partial<CapabilityRunnerDeps> = {}): CapabilityRunnerDeps {
  return {
    probe: async () => CHALLENGE,
    execute: async () => {
      throw new Error("execute must not run in a free-mode test");
    },
    verify: async () => ({ kind: "unverified", detail: "x" }) as VerifyOutcome,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe("desk engine executors", () => {
  it("the free run completes without spend and reports routes only", async () => {
    const inv = deskInv("counterparty_due_diligence", cddSubject());
    const plan = planDeskCapabilities(inv);
    const config = {
      investigationId: inv.id,
      reference: inv.reference,
      type: inv.type,
      mode: "free" as const,
      capabilities: plan.capabilities.map((c) => {
        const [mind, dimension] = c.key.split(":");
        return { key: c.key, mind: mind ?? "", dimension: dimension ?? "" };
      }),
      inputs: Object.fromEntries(plan.capabilities.map((c) => [c.key, c.params])),
    };
    const target = JSON.stringify(config);
    setDeskCapabilityDeps(fakeDeps());

    const task = taskFor();
    const outputs = {};
    await executeDeskBaseline(task, target, outputs as never);
    await executeDeskReport(task, target, outputs as never);

    expect(task.state).toBe("completed");
    expect(task.spend.spentUsdCents).toBe(0);
    expect(task.spend.entries).toHaveLength(0);
    const report = task.result?.capabilityReport;
    expect(report?.counts.routable_unverified).toBe(plan.capabilities.length);
    expect(report?.counts.verified).toBe(0);
    expect(task.result?.summary).toContain("Free mode");
  });

  it("the paid run executes each planned ask once, records spend and completes verified", async () => {
    const inv = deskInv("counterparty_due_diligence", cddSubject());
    const plan = planDeskCapabilities(inv);
    const config = {
      investigationId: inv.id,
      reference: inv.reference,
      type: inv.type,
      mode: "intel" as const,
      capabilities: plan.capabilities.map((c) => {
        const [mind, dimension] = c.key.split(":");
        return { key: c.key, mind: mind ?? "", dimension: dimension ?? "" };
      }),
      inputs: Object.fromEntries(plan.capabilities.map((c) => [c.key, c.params])),
    };
    const target = JSON.stringify(config);

    const registryFields: Record<string, unknown> = {
      legal_name: "Acme Holdings LLC",
      registration_id: "US-1234",
      active: true,
      jurisdiction: "US-NV",
      registered_address: "1209 N Orange St",
      incorporated: "2019-04-02",
    };
    const execute = vi.fn(async (input: { spec: { intent?: string } }) => ({
      kind: "answered",
      urlPath: "/engine/v1/ask/x",
      requestSent: input.spec,
      offer: OFFER,
      result: { ok: true },
      signalHash: "0xsignal",
      receipt: { receipt_hash: "0xreceipt", amount_uusdc: "10000" },
    }) as never);
    const verify = vi.fn(async (_hash: string) => ({
      kind: "verified",
      signalHash: "0xsignal",
      record: { payload: { response: registryFields } },
      note: "re-derived",
    }) as never);
    setDeskCapabilityDeps(fakeDeps({ execute, verify } as Partial<CapabilityRunnerDeps>));

    const task = taskFor();
    const outputs = {};
    await executeDeskBaseline(task, target, outputs as never);
    await executeDeskIntel(task, target, outputs as never);
    await executeDeskReport(task, target, outputs as never);

    expect(execute).toHaveBeenCalledTimes(plan.capabilities.length);
    expect(task.spend.spentUsdCents).toBe(plan.capabilities.length);
    expect(task.spend.entries).toHaveLength(plan.capabilities.length);
    expect(task.state).toBe("completed");
    expect(task.result?.capabilityReport?.counts.verified).toBe(plan.capabilities.length);
    expect(parseDeskConfig(target).mode).toBe("intel");
  });

  it("the ledger refuses to reconcile when entries do not match committed answers", async () => {
    const inv = deskInv("counterparty_due_diligence", cddSubject());
    const plan = planDeskCapabilities(inv);
    const config = {
      investigationId: inv.id,
      reference: inv.reference,
      type: inv.type,
      mode: "intel" as const,
      capabilities: plan.capabilities.map((c) => {
        const [mind, dimension] = c.key.split(":");
        return { key: c.key, mind: mind ?? "", dimension: dimension ?? "" };
      }),
      inputs: Object.fromEntries(plan.capabilities.map((c) => [c.key, c.params])),
    };
    const target = JSON.stringify(config);
    const answered: CommittedDimension = {
      dimension: "registry",
      label: "Corporate registry record",
      intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
      provider: "zk-corp-atlas",
      signalHash: "0xs",
      receiptHash: "0xr",
      costUsdCents: 1,
      verification: "verified",
      verificationNote: "ok",
      values: { legal_name: "Acme Holdings LLC" },
      missingFields: ["lei"],
      committed: null,
    };
    setDeskCapabilityDeps(
      fakeDeps({
        execute: async () => ({ kind: "answered", urlPath: "x", requestSent: {}, offer: OFFER, result: {}, signalHash: "0xs", receipt: { receipt_hash: "0xr" } }) as never,
        verify: async () => ({ kind: "verified", signalHash: "0xs", record: { payload: { response: {} } }, note: "ok" }) as never,
      }),
    );
    const task = taskFor();
    const outputs = {};
    await executeDeskBaseline(task, target, outputs as never);
    await executeDeskIntel(task, target, outputs as never);
    // Tamper with the ledger before the report step — reconciliation must fail.
    task.spend.entries.pop();
    await expect(executeDeskReport(task, target, outputs as never)).rejects.toThrow(/reconcile/);
  });
});

/* ------------------------------------------------------------------ */
/* Absorption + report                                                 */
/* ------------------------------------------------------------------ */

describe("desk evidence absorption and report", () => {
  async function investigationWithCompletedTask(mode: "free" | "intel") {
    const inv = deskInv("counterparty_due_diligence", cddSubject());
    const plan = planDeskCapabilities(inv);
    const config = {
      investigationId: inv.id,
      reference: inv.reference,
      type: inv.type,
      mode,
      capabilities: plan.capabilities.map((c) => {
        const [mind, dimension] = c.key.split(":");
        return { key: c.key, mind: mind ?? "", dimension: dimension ?? "" };
      }),
      inputs: Object.fromEntries(plan.capabilities.map((c) => [c.key, c.params])),
    };
    const target = JSON.stringify(config);
    setDeskCapabilityDeps(
      fakeDeps({
        execute: async () => ({ kind: "answered", urlPath: "x", requestSent: {}, offer: OFFER, result: {}, signalHash: "0xsig", receipt: { receipt_hash: "0xrcpt" } }) as never,
        verify: async () =>
          ({ kind: "verified", signalHash: "0xsig", record: { payload: { response: { legal_name: "Acme Holdings LLC", registration_id: "US-1234", active: true, jurisdiction: "US-NV", registered_address: "1209 N Orange St", incorporated: "2019-04-02" } } }, note: "re-derived" }) as never,
      }),
    );
    const task = taskFor();
    const outputs = {};
    await executeDeskBaseline(task, target, outputs as never);
    if (mode === "intel") await executeDeskIntel(task, target, outputs as never);
    await executeDeskReport(task, target, outputs as never);
    await saveTask(task);
    inv.runs.push({ taskId: task.id, mode, createdAt: new Date().toISOString(), taskState: task.state, ceilingUsdCents: task.spend.limitUsdCents, absorbed: false });
    return { inv, task };
  }

  it("absorbs a paid run into provenance classes and builds the full report", async () => {
    const { inv } = await investigationWithCompletedTask("intel");
    const result = await syncDeskInvestigation(inv);

    expect(result.added).toBeGreaterThan(0);
    const verified = inv.evidence.filter((e) => e.provenance === "verified");
    const probeOnly = inv.evidence.filter((e) => e.class === "probe_verified");
    const missing = inv.evidence.filter((e) => e.provenance === "missing");
    expect(verified.length).toBe(planCount(inv)); // every planned capability answered
    for (const e of verified) {
      expect(e.class).toBe("node_verified");
      expect(e.signalHash).toBe("0xsig");
      expect(e.receiptHash).toBe("0xrcpt");
    }
    expect(probeOnly.length).toBe(0); // all routable dims were paid in intel mode
    expect(missing.length).toBe(4); // the four named gaps
    // Declared inputs seeded
    expect(inv.evidence.some((e) => e.class === "declared")).toBe(true);

    // The registry answer carries its committed facts
    const registry = verified.find((e) => e.capability === "counterparty-intelligence:registry");
    expect(registry?.facts.legal_name).toBe("Acme Holdings LLC");
    expect(registry?.missingFields).toContain("lei");

    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: verified.length });
    expect(report.findings.some((f) => f.severity === "info" && f.title.startsWith("Verified:"))).toBe(true);
    // US → US-NV is recorded as a jurisdiction discrepancy, never resolved away.
    expect(report.discrepancies.some((d) => d.kind === "jurisdiction_refinement")).toBe(true);
    // The requested legal name differs from the registered name → name variance.
    expect(report.discrepancies.some((d) => d.kind === "name_variance")).toBe(true);
    expect(report.discrepancies.some((d) => d.kind === "missing_fields")).toBe(true);
    expect(report.limitations.some((l) => l.includes("unsupported"))).toBe(true);
    expect(report.outstandingQuestions.length).toBeGreaterThan(3);
    expect(report.confidence).toBe("signal_verified");
    expect(report.sections.length).toBe(6);
    expect(report.sections.find((s) => s.id === "registered_identity")?.provenance).toBe("verified");
    expect(report.counts.missing).toBe(4);
  });

  it("a free run yields route-verified-only confidence and an approval question", async () => {
    const { inv } = await investigationWithCompletedTask("free");
    await syncDeskInvestigation(inv);
    const report = buildDeskReport(inv, { mode: "free", spendUsdCents: 0, routableOffers: planCount(inv) });
    expect(report.confidence).toBe("route_verified_only");
    expect(report.headline).toMatch(/Route-verified only/);
    expect(report.outstandingQuestions.some((q) => q.includes("Approve a paid run"))).toBe(true);
    expect(report.findings.every((f) => f.severity === "info")).toBe(true);
  });

  it("sync is idempotent — a second pass absorbs nothing new", async () => {
    const { inv } = await investigationWithCompletedTask("intel");
    await syncDeskInvestigation(inv);
    const before = inv.evidence.length;
    const second = await syncDeskInvestigation(inv);
    expect(second.added).toBe(0);
    expect(inv.evidence.length).toBe(before);
  });

  it("a sanctioned match is a critical finding; a dead registry is material", async () => {
    const inv = deskInv("counterparty_due_diligence", { legalName: "Evil Corp", jurisdiction: "US" });
    inv.evidence.push(
      {
        id: "e1",
        provenance: "verified",
        class: "node_verified",
        capability: "sanctionsdesk:name_screening",
        label: "Name screening",
        title: "Name screening",
        detail: "match",
        facts: { name: "Evil Corp", matched: true, lists: "OFAC SDN", match_score: 0.98 },
        source: { kind: "telegraph", ref: "0xs", label: "zk-sanctions", observedAt: new Date().toISOString() },
        signalHash: "0xs",
        receiptHash: "0xr",
      },
      {
        id: "e2",
        provenance: "verified",
        class: "node_verified",
        capability: "counterparty-intelligence:registry",
        label: "Corporate registry record",
        title: "Corporate registry record",
        detail: "inactive",
        facts: { legal_name: "Evil Corp", active: false, jurisdiction: "US" },
        source: { kind: "telegraph", ref: "0xs2", label: "zk-corp-atlas", observedAt: new Date().toISOString() },
        signalHash: "0xs2",
        receiptHash: "0xr2",
      },
    );
    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: 2 });
    const critical = report.findings.find((f) => f.severity === "critical");
    expect(critical?.title).toMatch(/Sanctions name match/);
    expect(report.findings.some((f) => f.severity === "material" && f.title.includes("not active"))).toBe(true);
    expect(report.confidence).toBe("signal_verified");
  });
});

function planCount(inv: DeskInvestigation): number {
  return planDeskCapabilities(inv).capabilities.length;
}
