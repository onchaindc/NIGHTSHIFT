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
import { buildDeskReport, planDeskCapabilities, reclassifyVerificationFailures, syncDeskInvestigation } from "@/lib/desk/orchestrate";
import { saveTask } from "@/lib/engine/store";
import type { TaskRecord } from "@/lib/engine/types";
import type { CapabilityRunnerDeps, CommittedDimension } from "@/lib/minds/capability-runner";
import type { ApprovedOffer, ProbeOutcome, VerifyOutcome } from "@/lib/terminal/ask";
import type { DeskEvidence, DeskInvestigation, DeskInvestigationType } from "@/lib/desk/types";
import { DESK_TYPE_LABEL, DESK_VERDICT_LABEL } from "@/lib/desk/types";
import { buildDeskWalkthrough } from "@/lib/desk/walkthrough";
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
  it("defines the specialised workflows, including Listing Underwriter", () => {
    expect(DESK_TYPE_ORDER).toEqual([
      "counterparty_due_diligence",
      "asset_intelligence",
      "trade_supplier_intelligence",
      "listing_underwriter",
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

  it("never asks the same capability or dimension twice inside one plan", () => {
    // The paid executor maps dimension id → capability key per plan
    // (execute.ts keyByDimension), so what must hold is per-plan uniqueness.
    // A multi-class workflow can legitimately reference the same dimension
    // name on different minds for different asset classes (e.g.
    // caseledger:adverse_media for digital assets vs minewatch:adverse_media
    // for mining) — those are different asks to different providers and can
    // never co-plan because each subject carries exactly one asset class.
    for (const type of DESK_TYPE_ORDER) {
      const keys = DESK_WORKFLOWS[type].capabilities.map(capabilityKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
    // Every reachable plan: representative subject per workflow class. For
    // asset_intelligence that is one subject per asset class; for the single-
    // class workflows the canonical subject covers every branch.
    const planSubjects: Array<[DeskInvestigationType, Record<string, string>[]]> = [
      [
        "counterparty_due_diligence",
        [
          { legalName: "Acme Holdings Limited", jurisdiction: "US", website: "acme.example", claim: "Acme completed its 2025 audit.", controllerName: "Named Controller", vatNumber: "DE123456789" },
          { legalName: "Acme Holdings Limited", jurisdiction: "US" },
        ],
      ],
      [
        "asset_intelligence",
        [
          { assetClass: "digital_asset", assetName: "Token", tokenSymbol: "USDC", chain: "ethereum", issuerEntity: "Circle Internet Group, Inc.", issuerJurisdiction: "US", issuerWebsite: "circle.com", controllerName: "Named Controller", marketSubject: "Uniswap USDC/ETH", walletAddress: "0xabc", txHash: "0xdef", blockNumber: "1000" },
          { assetClass: "mining", assetName: "Site 4", operatorEntity: "BHP Group", jurisdiction: "AU", gridNode: "HB_WEST", intervalStart: "2026-11-23T00:00:00-06:00", blockNumber: "1000" },
          { assetClass: "energy", assetName: "Substation", siteLocation: "Houston, TX", pastDate: "2026-11-20" },
        ],
      ],
      [
        "trade_supplier_intelligence",
        [
          { supplierName: "Siemens AG", jurisdiction: "DE", poNumber: "PO-1", invoiceRef: "INV-1", vesselName: "MV Example" },
          { supplierName: "Siemens AG", jurisdiction: "DE" },
        ],
      ],
      [
        "listing_underwriter",
        [
          { assetClass: "digital_asset", assetName: "USDC", tokenSymbol: "USDC", chain: "ethereum", issuerEntity: "Circle Internet Group, Inc.", issuerJurisdiction: "US", issuerWebsite: "circle.com", controllerName: "Named Controller", declaredSupply: "1000000000", marketSubject: "Uniswap USDC/ETH" },
        ],
      ],
    ];
    for (const [type, subjects] of planSubjects) {
      for (const subject of subjects) {
        const plan = planDeskCapabilities(deskInv(type, subject));
        const keys = plan.capabilities.map((c) => c.key);
        expect(new Set(keys).size, `${type} plan double-asks a capability: ${keys.join(", ")}`).toBe(keys.length);
        const dimIds = plan.capabilities.map((c) => c.key.split(":")[1]);
        expect(new Set(dimIds).size, `${type} plan double-asks a dimension id: ${keys.join(", ")}`).toBe(dimIds.length);
      }
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
    // The five named gaps, resolved from the matrix with reasons.
    expect(inv.unsupported.map((g) => g.capabilityKey)).toEqual([
      "counterparty-intelligence:group_structure",
      "ownershipgraph:beneficial_ownership",
      "sanctionsdesk:related_parties",
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

  it("opens asset, trade and listing files with type-specific references", () => {
    const asset = parseCreateDeskBody({ type: "asset_intelligence", subject: { assetClass: "mining", assetName: "Site 4" } });
    expect(asset.ok).toBe(true);
    const trade = parseCreateDeskBody({ type: "trade_supplier_intelligence", subject: { supplierName: "Siemens AG", jurisdiction: "DE" } });
    expect(trade.ok).toBe(true);
    const listing = parseCreateDeskBody({ type: "listing_underwriter", subject: { assetClass: "digital_asset", assetName: "USDC", tokenSymbol: "USDC", chain: "ethereum", issuerEntity: "Circle Internet Group, Inc.", issuerJurisdiction: "US", marketSubject: "Uniswap USDC/ETH" } });
    expect(listing.ok).toBe(true);
    if (listing.ok) {
      expect(listing.investigation.reference.startsWith("NS-LU")).toBe(true);
      expect(listing.investigation.type).toBe("listing_underwriter");
      expect(listing.investigation.unsupported.some((g) => g.capabilityKey === "ownershipgraph:beneficial_ownership")).toBe(true);
    }
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
    // The two optional checks whose inputs cddSubject does not carry are
    // named input gaps, never approximate asks.
    expect(plan.inputGaps.map((g) => g.key)).toEqual(["ownershipgraph:vendor_identity", "ownershipgraph:sanctions_check"]);
    expect(plan.unsupported).toHaveLength(5);
  });

  it("without the optional claim the claim-check capability is a named input gap, never asked", () => {
    const inv = deskInv("counterparty_due_diligence", { legalName: "Acme", jurisdiction: "US" });
    const plan = planDeskCapabilities(inv);
    expect(plan.capabilities.map((c) => c.key)).not.toContain("caseledger:fact_check");
    const gap = plan.inputGaps.find((g) => g.key === "caseledger:fact_check");
    expect(gap).toBeDefined();
    expect(gap?.required.join(" ")).toMatch(/claim/i);
  });

  it("extends digital asset investigations with existing issuer specialists without creating duplicate Minds", () => {
    // The liquidity ask answers for a named pool, so its market input is
    // supplied here; without it the route is a named input gap, never an
    // approximate ask (asserted below).
    const plan = planDeskCapabilities(deskInv("asset_intelligence", {
      assetClass: "digital_asset",
      assetName: "Token listing review",
      tokenSymbol: "USDC",
      chain: "ethereum",
      issuerEntity: "Circle Internet Group, Inc.",
      issuerJurisdiction: "US",
      issuerWebsite: "circle.com",
      controllerName: "Named Controller",
      marketSubject: "Uniswap USDC/ETH",
    }));
    const keys = plan.capabilities.map((c) => c.key);
    expect(keys).toContain("index-reconstitution-desk:registry");
    expect(keys).toContain("index-reconstitution-desk:supply");
    expect(keys).toContain("index-reconstitution-desk:liquidity");
    expect(keys).toContain("ownershipgraph:b2b_enrichment");
    expect(keys).toContain("sanctionsdesk:name_screening");
    expect(keys).toContain("ownershipgraph:sanctions_check");
    expect(keys).toContain("caseledger:adverse_media");
    expect(plan.capabilities.find((c) => c.key === "ownershipgraph:b2b_enrichment")?.params).toEqual({ company: "Circle Internet Group, Inc." });
    expect(plan.capabilities.find((c) => c.key === "sanctionsdesk:name_screening")?.params).toEqual({ name: "Circle Internet Group, Inc." });
    expect(plan.capabilities.find((c) => c.key === "ownershipgraph:sanctions_check")?.params).toEqual({ name: "Named Controller" });
    expect(plan.capabilities.find((c) => c.key === "caseledger:adverse_media")?.params?.query).toContain("Circle Internet Group, Inc.");
    expect(plan.unsupported.map((g) => g.capabilityKey)).toContain("ownershipgraph:beneficial_ownership");
    expect(plan.unsupported.map((g) => g.capabilityKey)).toContain("sanctionsdesk:related_parties");
    expect(plan.unsupported.map((g) => g.capabilityKey)).toContain("caseledger:docket_retrieval");
  });

  it("without a named market the liquidity route is a named input gap, never an approximate ask", () => {
    const plan = planDeskCapabilities(deskInv("asset_intelligence", {
      assetClass: "digital_asset",
      assetName: "Token listing review",
      tokenSymbol: "USDC",
      chain: "ethereum",
    }));
    expect(plan.capabilities.map((c) => c.key)).not.toContain("index-reconstitution-desk:liquidity");
    const gap = plan.inputGaps.find((g) => g.key === "index-reconstitution-desk:liquidity");
    expect(gap).toBeDefined();
    expect(gap?.required.join(" ")).toMatch(/pool/i);
  });


  it("plans Listing Underwriter across existing issuer, token and market specialists", () => {
    const inv = deskInv("listing_underwriter", {
      assetClass: "digital_asset",
      assetName: "USDC",
      tokenSymbol: "USDC",
      chain: "ethereum",
      issuerEntity: "Circle Internet Group, Inc.",
      issuerJurisdiction: "US",
      issuerWebsite: "circle.com",
      controllerName: "Named Controller",
      declaredSupply: "1000000000",
      marketSubject: "Uniswap USDC/ETH",
    });
    const plan = planDeskCapabilities(inv);
    const keys = plan.capabilities.map((c) => c.key);
    for (const key of [
      "index-reconstitution-desk:registry",
      "index-reconstitution-desk:filings",
      "index-reconstitution-desk:supply",
      "index-reconstitution-desk:holders",
      "index-reconstitution-desk:liquidity",
      "index-reconstitution-desk:price",
      "chainforensics:holder_concentration",
      "chainforensics:wash_trading",
      "ownershipgraph:b2b_enrichment",
      "sanctionsdesk:name_screening",
      "ownershipgraph:sanctions_check",
      "caseledger:adverse_media",
    ]) expect(keys).toContain(key);
    expect(keys.every((key) => !key.startsWith("bitcoin-mining-intelligence:"))).toBe(true);
    expect(plan.capabilities.find((c) => c.key === "ownershipgraph:b2b_enrichment")?.params).toEqual({ company: "Circle Internet Group, Inc." });
    expect(plan.unsupported.map((g) => g.capabilityKey)).toContain("ownershipgraph:beneficial_ownership");
    expect(plan.unsupported.map((g) => g.capabilityKey)).toContain("sanctionsdesk:related_parties");
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
    expect(missing.length).toBe(7); // the five named gaps + two input gaps (no VAT, no controller)
    // Declared inputs seeded
    expect(inv.evidence.some((e) => e.class === "declared")).toBe(true);

    // The registry answer carries its committed facts
    const registry = verified.find((e) => e.capability === "counterparty-intelligence:registry");
    expect(registry?.facts.legal_name).toBe("Acme Holdings LLC");
    expect(registry?.missingFields).toContain("lei");

    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: verified.length });
    // Findings carry what the answer actually said, not the capability label.
    expect(report.findings.some((f) => f.severity === "info" && f.title.startsWith("Registry record:"))).toBe(true);
    // US → US-NV is recorded as a jurisdiction discrepancy, never resolved away.
    expect(report.discrepancies.some((d) => d.kind === "jurisdiction_refinement")).toBe(true);
    // The requested legal name differs from the registered name → name variance.
    expect(report.discrepancies.some((d) => d.kind === "name_variance")).toBe(true);
    expect(report.discrepancies.some((d) => d.kind === "missing_fields")).toBe(true);
    expect(report.limitations.some((l) => l.includes("unsupported"))).toBe(true);
    expect(report.outstandingQuestions.length).toBeGreaterThan(3);
    expect(report.confidence).toBe("signal_verified");
    expect(report.sections.length).toBe(7);
    expect(report.sections.find((s) => s.id === "registered_identity")?.provenance).toBe("verified");
    expect(report.counts.missing).toBe(7);
    // The executive assessment: verified, no adverse signal → proceed_on_record.
    expect(report.assessment.verdict).toBe("proceed_on_record");
    expect(report.assessment.summary).toContain("verified record(s)");
    expect(report.assessment.basis.length).toBeGreaterThan(0);
    expect(report.assessment.nextActions.length).toBeGreaterThan(0);
    // The unasked capabilities surface as concrete next steps.
    expect(report.assessment.nextActions.some((a) => a.title.includes("Supply the missing inputs") && a.basis.length > 0)).toBe(true);
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

  it("listing underwriter: a stated supply that contradicts the verified supply is a recorded conflict, never averaged away", async () => {
    const inv = deskInv("listing_underwriter", {
      assetClass: "digital_asset",
      assetName: "USDC",
      tokenSymbol: "USDC",
      chain: "ethereum",
      issuerEntity: "Circle Internet Group, Inc.",
      issuerJurisdiction: "US",
      declaredSupply: "1000000000",
    });
    // Declared inputs are seeded by the sync pass; the network-verified
    // supply that contradicts them is injected as a hash-committed answer.
    await syncDeskInvestigation(inv);
    expect(inv.evidence.some((e) => e.id === "declared:declaredSupply")).toBe(true);
    inv.evidence.push({
      id: "e-supply",
      provenance: "verified",
      class: "node_verified",
      capability: "index-reconstitution-desk:supply",
      label: "Total supply",
      title: "Total supply",
      detail: "verified answer",
      facts: { token: "USDC", chain: "ethereum", total_supply: 63000000000 },
      source: { kind: "telegraph", ref: "0xs3", label: "index-reconstitution-desk", observedAt: new Date().toISOString() },
      signalHash: "0xs3",
      receiptHash: "0xr3",
    });
    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: 1 });
    const conflict = report.discrepancies.find((d) => d.title.includes("Stated supply differs"));
    expect(conflict).toBeDefined();
    expect(conflict?.kind).toBe("field_conflict");
    expect(conflict?.evidenceIds).toEqual(["declared:declaredSupply", "e-supply"]);
    expect(conflict?.detail).toContain("63,000,000,000");
    // A supply conflict is material: the verdict cannot be a clean proceed.
    expect(report.assessment.verdict).toBe("proceed_with_conditions");
    expect(report.assessment.summary).toContain("cannot speak to");
    // The underwriting gaps the network cannot answer stay named.
    expect(report.limitations.some((l) => l.includes("unsupported"))).toBe(true);
    expect(report.sections.map((s) => s.id)).toEqual(["issuer_identity", "token_integrity", "market_quality", "issuer_exposure"]);
  });

  it("listing underwriter: incomplete evidence yields insufficient_verified_evidence, no findings and no manufactured score", async () => {
    // Only the guided-form inputs exist: nothing was asked, nothing verified.
    const inv = deskInv("listing_underwriter", {
      assetClass: "digital_asset",
      assetName: "New Token",
      tokenSymbol: "NEW",
      issuerJurisdiction: "US",
    });
    const report = buildDeskReport(inv, { mode: "free", spendUsdCents: 0 });
    expect(report.assessment.verdict).toBe("insufficient_verified_evidence");
    expect(report.assessment.summary).toMatch(/insufficient verified evidence/i);
    expect(report.findings).toHaveLength(0);
    expect(report.confidence).toBe("unverified");
    expect(report.headline).toMatch(/Route-verified only/);
    // The four underwriting sections are present but honestly missing.
    expect(report.sections.every((s) => s.provenance === "missing")).toBe(true);
    // The named gaps remain the outstanding questions — beneficial ownership
    // and court records are never inferred from what is missing.
    expect(report.outstandingQuestions.some((q) => q.toLowerCase().includes("beneficial ownership"))).toBe(true);
    expect(report.outstandingQuestions.some((q) => q.toLowerCase().includes("court"))).toBe(true);
    // The liquidity route was never asked (no market named) — it is a named
    // input gap, not an unverified answer.
    expect(inv.evidence.some((e) => e.capability === "index-reconstitution-desk:liquidity")).toBe(false);
  });

  it("listing underwriter: a clean verified record set still reports named exposure gaps, not a confident listing", async () => {
    const inv = deskInv("listing_underwriter", {
      assetClass: "digital_asset",
      assetName: "USDC",
      tokenSymbol: "USDC",
      chain: "ethereum",
      issuerEntity: "Circle Internet Group, Inc.",
      issuerJurisdiction: "US",
      controllerName: "Named Controller",
      marketSubject: "Uniswap USDC/ETH",
    });
    inv.evidence.push(
      {
        id: "e-reg",
        provenance: "verified",
        class: "node_verified",
        capability: "index-reconstitution-desk:registry",
        label: "Issuer registry record",
        title: "Issuer registry record",
        detail: "active",
        facts: { legal_name: "Circle Internet Group, Inc.", jurisdiction: "US-DE", active: true, registration_id: "DE-12345" },
        source: { kind: "telegraph", ref: "0xs4", label: "index-reconstitution-desk", observedAt: new Date().toISOString() },
        signalHash: "0xs4",
        receiptHash: "0xr4",
      },
      {
        id: "e-screen",
        provenance: "verified",
        class: "node_verified",
        capability: "sanctionsdesk:name_screening",
        label: "Issuer sanctions screening",
        title: "Issuer sanctions screening",
        detail: "no match",
        facts: { name: "Circle Internet Group, Inc.", matched: false },
        source: { kind: "telegraph", ref: "0xs5", label: "zk-sanctions", observedAt: new Date().toISOString() },
        signalHash: "0xs5",
        receiptHash: "0xr5",
      },
    );
    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: 2 });
    expect(report.assessment.verdict).toBe("proceed_on_record");
    // Even a clean proceed names what underwriting still lacks: ownership,
    // group structure and court records are unsupported — screening the
    // issuer does not establish control.
    expect(report.assessment.basis.some((b) => b.includes("Unsupported on the network"))).toBe(true);
    expect(report.limitations.join(" ")).toMatch(/not legal, sanctions, credit or investment advice/);
    expect(report.sections.find((s) => s.id === "issuer_exposure")?.provenance).toBe("verified");
  });
});

/* ------------------------------------------------------------------ */
/* Verification integrity: failures, node-asserted answers, disagreements */
/* ------------------------------------------------------------------ */

// The two verification notes verifySignal itself writes, verbatim — the
// historical-reclassification repair keys on exactly these signatures.
const MISMATCH_NOTE =
  "The signal is recorded, but re-deriving the hash over the recorded payload gave 0xdeadbeef, which does not match. The node's own verified flag: true.";
const NODE_ASSERTED_NOTE =
  "The node reports verification.verified = true, but the payload could not be re-serialized here for an independent re-derivation, so treat this as the network's word, not proof.";

describe("desk verification integrity", () => {
  function luSubject(): Record<string, string> {
    return {
      assetClass: "digital_asset",
      assetName: "USDC",
      tokenSymbol: "USDC",
      chain: "ethereum",
      issuerEntity: "Circle Internet Group, Inc.",
      issuerJurisdiction: "US",
      issuerWebsite: "circle.com",
      marketSubject: "Uniswap USDC/ETH",
      declaredSupply: "1000000000",
    };
  }

  function holderEvidence(capability: string, label: string, holders: number, id: string): DeskEvidence {
    return {
      id,
      provenance: "verified",
      class: "node_verified",
      capability,
      label,
      title: label,
      detail: "verified against the node signal",
      facts: { token: "USDC", chain: "ethereum", holders_count: holders },
      source: { kind: "telegraph", ref: `0x${id}`, label: "provider", observedAt: new Date().toISOString() },
      signalHash: `0xsignal-${id}`,
      receiptHash: `0xreceipt-${id}`,
      costUsdCents: 1,
    };
  }

  /** A completed paid run whose capability report carries the given dims. */
  function runWithDims(taskId: string, dims: unknown[]): TaskRecord {
    const counts = { verified: 0, recorded: 0, unverified: 0, routable_unverified: 0, gap: 0 };
    for (const d of dims as Array<{ status: string }>) counts[d.status as keyof typeof counts] += 1;
    const task = taskFor();
    task.id = taskId;
    task.state = "completed";
    task.spend = { limitUsdCents: 12, spentUsdCents: dims.length, entries: [] };
    task.result = {
      summary: "paid run",
      evidence: [],
      completedAt: 1,
      capabilityReport: {
        slug: "listing_underwriter",
        preparedAt: new Date().toISOString(),
        dimensions: dims,
        missing: [],
        spendUsdCents: dims.length,
        counts,
        note: "",
      },
    } as never;
    return task;
  }

  it("a paid answer whose payload fails the independent hash re-derivation is a verification failure, never a verified fact", async () => {
    const inv = deskInv("listing_underwriter", luSubject());
    const task = runWithDims("task-lu-mismatch", [
      {
        dimension: "index-reconstitution-desk:holders",
        label: "Holder count",
        status: "verified",
        detail: "verified against the node signal; Independent re-derivation matches: the recorded payload is exactly the one this signal hash commits to.",
        intent: "TOKEN_HOLDER_COUNT",
        provider: "index-reconstitution-desk",
        priceUsdCents: 1,
        signalHash: "0xhold",
        receiptHash: "0xholdr",
        verifiedAt: new Date().toISOString(),
        values: { token: "USDC", chain: "ethereum", holders_count: 9641462 },
        missingFields: [],
        viaRouterFallback: false,
      },
      {
        // The real NS-LU-A803A739 failure mode: the node asserts verified,
        // but the recorded payload does not re-derive the signal hash.
        dimension: "index-reconstitution-desk:filings",
        label: "Regulatory filings",
        status: "recorded",
        detail: `paid answer is recorded; ${MISMATCH_NOTE}`,
        intent: "REGULATORY_FILINGS",
        provider: "index-reconstitution-desk",
        priceUsdCents: 1,
        signalHash: "0xfile",
        receiptHash: "0xfiler",
        values: { company: "Circle Internet Group, Inc.", filing_count: 42 },
        missingFields: [],
        committed: { company: "Circle Internet Group, Inc.", filing_count: 42 },
        verificationReason: "hash_mismatch",
        viaRouterFallback: false,
      },
      {
        dimension: "index-reconstitution-desk:registry",
        label: "Issuer registry record",
        status: "recorded",
        detail: `paid answer is recorded; ${NODE_ASSERTED_NOTE}`,
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "index-reconstitution-desk",
        priceUsdCents: 1,
        signalHash: "0xreg",
        receiptHash: "0xregr",
        values: { legal_name: "Circle Internet Group, Inc.", active: true },
        missingFields: [],
        committed: { legal_name: "Circle Internet Group, Inc.", active: true },
        verificationReason: "node_asserted",
        viaRouterFallback: false,
      },
    ]);
    await saveTask(task);
    inv.runs.push({ taskId: task.id, mode: "intel", createdAt: new Date().toISOString(), taskState: "completed", ceilingUsdCents: 12, absorbed: false });
    await syncDeskInvestigation(inv);

    const failedRec = inv.evidence.find((e) => e.capability === "index-reconstitution-desk:filings");
    expect(failedRec?.provenance).toBe("verification_failed");
    expect(failedRec?.class).toBe("verification_failed");
    expect(failedRec?.verificationReason).toBe("hash_mismatch");
    // The record is preserved for investigation: signal, receipt, facts and
    // the full committed payload stay attached — nothing is discarded.
    expect(failedRec?.signalHash).toBe("0xfile");
    expect(failedRec?.receiptHash).toBe("0xfiler");
    expect(failedRec?.facts.filing_count).toBe(42);
    expect(failedRec?.committedPayload).toEqual({ company: "Circle Internet Group, Inc.", filing_count: 42 });

    // A node-asserted answer is unverified with its own class, distinct from
    // a probe-only route.
    const asserted = inv.evidence.find((e) => e.capability === "index-reconstitution-desk:registry");
    expect(asserted?.provenance).toBe("unverified");
    expect(asserted?.class).toBe("node_asserted");
    expect(asserted?.signalHash).toBe("0xreg");

    // A genuine re-derivation match is still a verified fact.
    const holders = inv.evidence.find((e) => e.capability === "index-reconstitution-desk:holders");
    expect(holders?.provenance).toBe("verified");
    expect(holders?.class).toBe("node_verified");

    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: 9 });
    expect(report.counts).toMatchObject({ verified: 1, verification_failed: 1, node_asserted: 1 });
    // A file with a failed re-derivation is never "signal verified".
    expect(report.confidence).toBe("partially_verified");
    expect(report.headline).toContain("verification failure");
    expect(report.limitations.join(" ")).toMatch(/FAILED the independent hash re-derivation/);
    expect(report.limitations.join(" ")).toMatch(/node's assertion only/);

    // The failure is a material finding in its own right, and it is the ONLY
    // finding citing the failed record — its values never surface as facts.
    const citing = report.findings.filter((f) => f.evidenceIds.includes(failedRec?.id ?? ""));
    expect(citing).toHaveLength(1);
    expect(citing[0].severity).toBe("material");
    expect(citing[0].title).toMatch(/failed independent verification/);

    // The executive assessment states the failure and holds the file on it.
    expect(report.assessment.verdict).toBe("proceed_with_conditions");
    expect(report.assessment.summary).toMatch(/FAILED independent hash re-derivation/);
    expect(report.assessment.summary).toMatch(/not fully verified/);
    expect(report.assessment.nextActions.some((a) => /Investigate the verification failure/.test(a.title))).toBe(true);
    expect(report.assessment.basis.some((b) => b.includes("failed independent re-derivation"))).toBe(true);
  });

  it("two providers answering the holder count keep both answers and record the six-unit difference — no average, no silent pick", () => {
    const inv = deskInv("listing_underwriter", luSubject());
    inv.evidence.push(
      holderEvidence("index-reconstitution-desk:holders", "Holder count", 9641462, "e-h1"),
      holderEvidence("chainforensics:holder_concentration", "Holder concentration", 9641456, "e-h2"),
    );
    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: 9 });
    const d = report.discrepancies.find((x) => x.kind === "provider_disagreement");
    expect(d).toBeDefined();
    expect(d?.material).toBe(false);
    // Both answers appear by value and by evidence id; neither is averaged
    // away and neither replaces the other.
    expect(d?.detail).toContain("9,641,462");
    expect(d?.detail).toContain("9,641,456");
    expect(d?.detail).toMatch(/neither is averaged away and neither is silently preferred/);
    expect(d?.evidenceIds).toEqual(["e-h1", "e-h2"]);
    expect(report.counts.verified).toBe(2);
    // A within-tolerance measurement difference does not degrade the verdict
    // on its own.
    expect(report.assessment.verdict).toBe("proceed_on_record");
  });

  it("a material provider disagreement is a contradiction the assessment must hold the file on", () => {
    const inv = deskInv("listing_underwriter", luSubject());
    inv.evidence.push(
      holderEvidence("index-reconstitution-desk:holders", "Holder count", 1000000, "e-m1"),
      holderEvidence("chainforensics:holder_concentration", "Holder concentration", 1600000, "e-m2"),
    );
    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: 9 });
    const d = report.discrepancies.find((x) => x.kind === "provider_disagreement");
    expect(d?.material).toBe(true);
    expect(d?.title).toMatch(/disagree materially on holders count/);
    expect(report.assessment.verdict).toBe("proceed_with_conditions");
    expect(report.assessment.nextActions.some((a) => /material provider disagreement/.test(a.title))).toBe(true);
  });

  it("a historical record whose own verification note says it never re-derived is reclassified, not rewritten", () => {
    const inv = deskInv("listing_underwriter", luSubject());
    const now = new Date().toISOString();
    inv.evidence.push(
      {
        id: "old-failed",
        provenance: "verified",
        class: "node_verified",
        capability: "index-reconstitution-desk:filings",
        label: "Regulatory filings",
        title: "Regulatory filings",
        detail: `paid answer is recorded; ${MISMATCH_NOTE}`,
        facts: { filing_count: 42 },
        source: { kind: "telegraph", ref: "0xfile", label: "index-reconstitution-desk", observedAt: now },
        signalHash: "0xfile",
        receiptHash: "0xfiler",
        costUsdCents: 1,
      },
      {
        id: "old-asserted",
        provenance: "verified",
        class: "node_verified",
        capability: "index-reconstitution-desk:registry",
        label: "Issuer registry record",
        title: "Issuer registry record",
        detail: `paid answer is recorded; ${NODE_ASSERTED_NOTE}`,
        facts: { legal_name: "Circle Internet Group, Inc." },
        source: { kind: "telegraph", ref: "0xreg", label: "index-reconstitution-desk", observedAt: now },
        signalHash: "0xreg",
        receiptHash: "0xregr",
        costUsdCents: 1,
      },
      holderEvidence("index-reconstitution-desk:holders", "Holder count", 9641462, "old-verified"),
    );
    expect(reclassifyVerificationFailures(inv)).toBe(2);

    const failedRec = inv.evidence.find((e) => e.id === "old-failed");
    expect(failedRec?.provenance).toBe("verification_failed");
    expect(failedRec?.class).toBe("verification_failed");
    // The record itself is preserved: signal, receipt, facts and detail stay.
    expect(failedRec?.signalHash).toBe("0xfile");
    expect(failedRec?.receiptHash).toBe("0xfiler");
    expect(failedRec?.facts.filing_count).toBe(42);
    expect(failedRec?.detail).toMatch(/which does not match/);
    expect(failedRec?.detail).toMatch(/Reclassified from verified on review/);
    expect(failedRec?.title).toBe("Regulatory filings · verification failed");

    const asserted = inv.evidence.find((e) => e.id === "old-asserted");
    expect(asserted?.provenance).toBe("unverified");
    expect(asserted?.class).toBe("node_asserted");

    // A genuinely verified record is untouched.
    expect(inv.evidence.find((e) => e.id === "old-verified")?.provenance).toBe("verified");
    // The correction is audited, and a second pass changes nothing.
    expect(inv.audit.filter((a) => a.action === "desk_evidence_reclassified")).toHaveLength(2);
    expect(reclassifyVerificationFailures(inv)).toBe(0);
  });

  it("the walkthrough replays the stored ledger: inputs, approval, asks, receipts, verification, disagreements and assessment", async () => {
    // Mirrors the recorded shape of the first real paid listing run
    // (NS-LU-A803A739): a $0.12 ceiling with $0.09 spent across several asks,
    // holder answers from two providers six apart, one regulatory-filings
    // answer that failed the independent re-derivation.
    const inv = deskInv("listing_underwriter", luSubject());
    const task = runWithDims("task-lu-walkthrough", [
      {
        dimension: "index-reconstitution-desk:holders",
        label: "Holder count",
        status: "verified",
        detail: "verified against the node signal; Independent re-derivation matches.",
        intent: "TOKEN_HOLDER_COUNT",
        provider: "index-reconstitution-desk",
        priceUsdCents: 1,
        signalHash: "0xhold",
        receiptHash: "0xholdr",
        values: { token: "USDC", chain: "ethereum", holders_count: 9641462 },
        missingFields: [],
        viaRouterFallback: false,
      },
      {
        dimension: "chainforensics:holder_concentration",
        label: "Holder concentration",
        status: "verified",
        detail: "verified against the node signal; Independent re-derivation matches.",
        intent: "HOLDER_CONCENTRATION",
        provider: "chainforensics",
        priceUsdCents: 1,
        signalHash: "0xconc",
        receiptHash: "0xconcr",
        values: { token: "USDC", chain: "ethereum", holders_count: 9641456, top10_pct: 31.2 },
        missingFields: [],
        viaRouterFallback: false,
      },
      {
        dimension: "index-reconstitution-desk:filings",
        label: "Regulatory filings",
        status: "recorded",
        detail: `paid answer is recorded; ${MISMATCH_NOTE}`,
        intent: "REGULATORY_FILINGS",
        provider: "index-reconstitution-desk",
        priceUsdCents: 1,
        signalHash: "0xfile",
        receiptHash: "0xfiler",
        values: { company: "Circle Internet Group, Inc.", filing_count: 42 },
        missingFields: [],
        committed: { company: "Circle Internet Group, Inc.", filing_count: 42 },
        verificationReason: "hash_mismatch",
        viaRouterFallback: false,
      },
      {
        dimension: "index-reconstitution-desk:registry",
        label: "Issuer registry record",
        status: "recorded",
        detail: `paid answer is recorded; ${NODE_ASSERTED_NOTE}`,
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "index-reconstitution-desk",
        priceUsdCents: 1,
        signalHash: "0xreg",
        receiptHash: "0xregr",
        values: { legal_name: "Circle Internet Group, Inc.", active: true },
        missingFields: [],
        committed: { legal_name: "Circle Internet Group, Inc.", active: true },
        verificationReason: "node_asserted",
        viaRouterFallback: false,
      },
      {
        dimension: "sanctionsdesk:name_screening",
        label: "Issuer sanctions screening",
        status: "verified",
        detail: "verified against the node signal; Independent re-derivation matches.",
        intent: "NAME_SCREENING",
        provider: "zk-sanctions",
        priceUsdCents: 1,
        signalHash: "0xscreen",
        receiptHash: "0xscreenr",
        values: { name: "Circle Internet Group, Inc.", matched: false },
        missingFields: [],
        viaRouterFallback: false,
      },
    ]);
    task.spend = {
      limitUsdCents: 12,
      spentUsdCents: 5,
      entries: [
        { ts: 1, description: "NS-LU: Holder count via Telegraph", amountUsdCents: 1, source: "telegraph", receiptHash: "0xholdr", signalHash: "0xhold" },
        { ts: 2, description: "NS-LU: Holder concentration via Telegraph", amountUsdCents: 1, source: "telegraph", receiptHash: "0xconcr", signalHash: "0xconc" },
        { ts: 3, description: "NS-LU: Regulatory filings via Telegraph", amountUsdCents: 1, source: "telegraph", receiptHash: "0xfiler", signalHash: "0xfile" },
        { ts: 4, description: "NS-LU: Issuer registry via Telegraph", amountUsdCents: 1, source: "telegraph", receiptHash: "0xregr", signalHash: "0xreg" },
        { ts: 5, description: "NS-LU: Issuer sanctions via Telegraph", amountUsdCents: 1, source: "telegraph", receiptHash: "0xscreenr", signalHash: "0xscreen" },
      ],
    };
    task.events.push({
      id: "ev-approve",
      ts: 1,
      type: "step_succeeded",
      message: "Operator approved the priced plan: 5 dimension(s) for $0.05 inside the $0.12 ceiling",
    });
    await saveTask(task);
    inv.runs.push({ taskId: task.id, mode: "intel", createdAt: new Date().toISOString(), taskState: "completed", ceilingUsdCents: 12, absorbed: false });
    await syncDeskInvestigation(inv);
    const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: 5 });
    inv.report = report;

    const wt = buildDeskWalkthrough(inv, [task]);
    expect(wt.reference).toBe(inv.reference);
    expect(wt.typeLabel).toBe("Listing Underwriter");
    // 1 — inputs exactly as entered, with the named unsupported requirements.
    expect(wt.steps.inputs.fields.find((f) => f.name === "tokenSymbol")?.value).toBe("USDC");
    expect(wt.steps.inputs.fields.find((f) => f.name === "declaredSupply")?.value).toBe("1000000000");
    expect(wt.steps.inputs.unsupported.length).toBe(inv.unsupported.length);
    // 2 — the budget and the human approval.
    expect(wt.steps.budgetApproval[0]).toMatchObject({ mode: "intel", ceilingUsdCents: 12, spentUsdCents: 5, taskState: "completed", approved: true });
    expect(wt.steps.budgetApproval[0].approvalDetail).toMatch(/approved the priced plan/);
    // 3 — the actual paid asks, each with provider, price and signal hash.
    expect(wt.steps.paidRequests).toHaveLength(5);
    expect(wt.steps.paidRequests.every((r) => r.signalHash && r.receiptHash)).toBe(true);
    // 4 — provider responses keep the failed record's facts for investigation.
    const failedAnswer = wt.steps.providerResponses.find((r) => r.capability === "index-reconstitution-desk:filings");
    expect(failedAnswer?.verification).toContain("FAILED");
    expect(failedAnswer?.verificationReason).toBe("hash_mismatch");
    expect(failedAnswer?.facts.filing_count).toBe(42);
    // 5 — verification outcomes: three re-derived, one failed, one asserted.
    expect(wt.steps.verification.filter((v) => v.outcome === "independently_verified")).toHaveLength(3);
    expect(wt.steps.verification.some((v) => v.outcome === "verification_failed" && v.capability === "index-reconstitution-desk:filings")).toBe(true);
    expect(wt.steps.verification.some((v) => v.outcome === "node_asserted")).toBe(true);
    // 6 — the six-holder provider difference is recorded as a measurement
    // difference with both evidence ids; nothing was averaged.
    const holderDiff = wt.steps.discrepanciesAndGaps.discrepancies.find((d) => d.title.includes("holders count"));
    expect(holderDiff?.material).toBe(false);
    expect(holderDiff?.evidenceIds).toHaveLength(2);
    expect(wt.steps.discrepanciesAndGaps.unsupported.length).toBe(inv.unsupported.length);
    // 7 — the assessment, verbatim from the rebuilt report.
    expect(wt.steps.assessment?.counts.verification_failed).toBe(1);
    expect(wt.steps.assessment?.verdictLabel).toBe(DESK_VERDICT_LABEL[report.assessment.verdict]);
    expect(wt.steps.assessment?.summary).toBe(report.assessment.summary);
  });
});

function planCount(inv: DeskInvestigation): number {
  return planDeskCapabilities(inv).capabilities.length;
}
