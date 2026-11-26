/**
 * Deal Desk — realistic investigation scenarios across all three workflows,
 * driven through the real executors (fake rails) with per-intent payloads:
 *
 *  - counterparty, complete file, contradictory evidence: sanctions match on
 *    a named controller, VAT registration naming another entity, enrichment
 *    headquartered outside the file's jurisdiction, adverse coverage, an
 *    unsupported claim;
 *  - asset, incomplete file: token askables answered, issuer never named,
 *    the issuer's stated supply contradicting the verified total supply;
 *  - trade, incomplete file: identity verified clean, the purchase order
 *    unverifiable, every document ask an honest named input gap.
 *
 * Pinned here: the executive assessment verdict rules, finding specificity,
 * cross-source discrepancy detection, and next actions traced to evidence.
 */

import { describe, expect, it, afterEach } from "vitest";

import { resetDeskCapabilityDeps, setDeskCapabilityDeps } from "@/lib/desk/execute";
import { planDeskCapabilities, syncDeskInvestigation } from "@/lib/desk/orchestrate";
import { parseCreateDeskBody } from "@/lib/desk/create";
import { saveTask } from "@/lib/engine/store";
import type { TaskRecord } from "@/lib/engine/types";
import type { CapabilityRunnerDeps } from "@/lib/minds/capability-runner";
import type { ApprovedOffer, ProbeOutcome, VerifyOutcome } from "@/lib/terminal/ask";
import type { DeskInvestigation, DeskInvestigationType, DeskReport } from "@/lib/desk/types";

afterEach(() => resetDeskCapabilityDeps());

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

interface PayloadSpec {
  intent: string;
  /** Discriminate asks that share an intent (e.g. two sanctions screens). */
  match?: (params: Record<string, unknown>) => boolean;
  response: Record<string, unknown>;
}

function deskInv(type: DeskInvestigationType, subject: Record<string, string>): DeskInvestigation {
  const parsed = parseCreateDeskBody({ type, subject });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.investigation;
}

function taskFor(limitUsdCents = 100): TaskRecord {
  return {
    id: `task-scenario-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: 1,
    updatedAt: 1,
    state: "executing",
    goal: "desk scenario",
    plan: null,
    events: [],
    spend: { limitUsdCents, spentUsdCents: 0, entries: [] },
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

/**
 * Runs one paid scenario through the real executors with fake rails and
 * returns the absorbed investigation plus its built report.
 */
async function runPaidScenario(
  type: DeskInvestigationType,
  subject: Record<string, string>,
  payloads: PayloadSpec[],
): Promise<{ inv: DeskInvestigation; report: DeskReport }> {
  const inv = deskInv(type, subject);
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

  const responseByHash = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const execute = async (input: { spec: { intent?: string; params?: Record<string, unknown> } }) => {
    const entry = payloads.find((p) => p.intent === input.spec.intent && (!p.match || p.match(input.spec.params ?? {})));
    if (!entry) throw new Error(`scenario payload missing for intent ${input.spec.intent} with params ${JSON.stringify(input.spec.params ?? {})}`);
    const hash = `0xsig${(seq++).toString(16).padStart(3, "0")}`;
    responseByHash.set(hash, entry.response);
    return {
      kind: "answered",
      urlPath: "/engine/v1/ask/x",
      requestSent: input.spec,
      offer: OFFER,
      result: {},
      signalHash: hash,
      receipt: { receipt_hash: `0xrcpt${seq}` },
    } as never;
  };
  const verify = (async (hash: string) =>
    ({
      kind: "verified",
      signalHash: hash,
      record: { payload: { response: responseByHash.get(hash) ?? {} } },
      note: "re-derived against the signal",
    }) as never) as unknown as CapabilityRunnerDeps["verify"];
  setDeskCapabilityDeps({
    probe: async () => CHALLENGE,
    execute,
    verify,
    now: () => 1_700_000_000_000,
  } as Partial<CapabilityRunnerDeps>);

  const { executeDeskBaseline, executeDeskIntel, executeDeskReport } = await import("@/lib/desk/execute");
  const task = taskFor();
  const outputs = {};
  await executeDeskBaseline(task, target, outputs as never);
  await executeDeskIntel(task, target, outputs as never);
  await executeDeskReport(task, target, outputs as never);
  await saveTask(task);

  inv.runs.push({
    taskId: task.id,
    mode: "intel",
    createdAt: new Date().toISOString(),
    taskState: task.state,
    ceilingUsdCents: task.spend.limitUsdCents,
    absorbed: false,
  });
  const sync = await syncDeskInvestigation(inv);
  expect(sync.added).toBeGreaterThan(0);
  const { buildDeskReport } = await import("@/lib/desk/orchestrate");
  const report = buildDeskReport(inv, { mode: "intel", spendUsdCents: task.spend.spentUsdCents });
  return { inv, report };
}

/* Tiny local vi stubs keep this file independent of vitest's mock hoisting. */
function vi_current<T>(fn: T): T {
  return fn;
}

/* ------------------------------------------------------------------ */
/* Counterparty: complete file, contradictory evidence                 */
/* ------------------------------------------------------------------ */

describe("counterparty due diligence — complete file, contradictory evidence", () => {
  const SUBJECT = {
    legalName: "Northwind Trading GmbH",
    jurisdiction: "DE",
    website: "northwind.example",
    vatNumber: "DE999999999",
    controllerName: "Viktor Vekselberg",
    claim: "Northwind completed its 2025 audit without qualifications.",
  };
  const PAYLOADS: PayloadSpec[] = [
    {
      intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
      response: {
        legal_name: "Northwind Trading GmbH",
        registration_id: "HRB 214815",
        active: true,
        jurisdiction: "DE",
        registered_address: "Industriestrasse 1, Hamburg",
        // lei and legal_form deliberately absent: incomplete evidence.
      },
    },
    {
      intent: "B2B_IDENTITY_ENRICHMENT_GENERAL",
      response: { company: "Northwind Trading GmbH", domain: "northwind.example", employee_count: 42, industry: "Wholesale", headquarters: "Wilmington, DE, US" },
    },
    {
      intent: "VENDOR_VERIFY_GENERAL",
      response: { vendor: "Northwind Trading GmbH", vat_number: "DE999999999", valid: false, registered_name: "Northwind Handels UG", registered_address: "Industriestrasse 1, Hamburg" },
    },
    {
      intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
      match: (p) => String(p.name) === "Viktor Vekselberg",
      response: { name: "Viktor Vekselberg", matched: true, matches: "1", lists: "OFAC SDN", match_score: 0.92 },
    },
    {
      intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
      match: (p) => String(p.name) === "Northwind Trading GmbH",
      response: { name: "Northwind Trading GmbH", matched: false, matches: "0", lists: "", match_score: 0 },
    },
    {
      intent: "REGULATORY_FILING_MONITOR_GENERAL",
      response: { filing_count: 3, filings: "FY2025 accounts; change of directors; annual report", urls: "https://example.com/1; https://example.com/2" },
    },
    {
      intent: "NEWS_SEARCH_GENERAL",
      response: { answer: "Two adverse items found.", result_count: 2, sources: "press-a.example; press-b.example", brief: "A delivery dispute and a regulatory inquiry." },
    },
    {
      intent: "FACT_CHECK_GENERAL",
      response: { claim: SUBJECT.claim, verdict: "unsupported", reasoning: "No public source supports the claim.", sources: "" },
    },
  ];

  it("holds the file on the controller sanctions match and names every conflict", async () => {
    const { inv, report } = await runPaidScenario("counterparty_due_diligence", SUBJECT, PAYLOADS);

    // Verdict: a verified sanctions match on the named controller is a hard stop.
    expect(report.assessment.verdict).toBe("hold_pending_review");
    expect(report.assessment.summary).toContain("Decisive adverse signal");
    const critical = report.findings.find((f) => f.severity === "critical");
    expect(critical?.title).toMatch(/Sanctions name match \(OFAC SDN\)/);
    expect(critical?.evidenceIds.length).toBeGreaterThan(0);
    expect(report.assessment.nextActions[0]?.title).toContain("compliance review");
    expect(report.assessment.nextActions[0]?.basis).toEqual(critical?.evidenceIds);

    // VAT registration does not validate and names another entity.
    expect(report.findings.some((f) => f.severity === "material" && /VAT identity does not validate/.test(f.title))).toBe(true);
    expect(report.discrepancies.some((d) => d.kind === "field_conflict" && /VAT registration names a different entity/.test(d.title))).toBe(true);

    // The enrichment's headquarters contradicts the file's jurisdiction.
    expect(report.discrepancies.some((d) => d.kind === "field_conflict" && /outside the file's jurisdiction/.test(d.title))).toBe(true);

    // Company screen clean, adverse coverage counted, claim unsupported.
    expect(report.findings.some((f) => /Sanctions screen: no match for Northwind Trading GmbH/.test(f.title))).toBe(true);
    expect(report.findings.some((f) => f.severity === "minor" && /Adverse-coverage search returned 2/.test(f.title))).toBe(true);
    expect(report.findings.some((f) => f.severity === "minor" && /Claim check verdict: unsupported/.test(f.title))).toBe(true);

    // Registry fact carries what the answer said, with missing fields named.
    const registryFinding = report.findings.find((f) => f.title.startsWith("Registry record:"));
    expect(registryFinding?.title).toContain("Northwind Trading GmbH (DE) — active");
    expect(report.discrepancies.some((d) => d.kind === "missing_fields")).toBe(true);

    // The declared controller relationship is never upgraded to verified.
    expect(inv.evidence.some((e) => e.id === "declared:controllerName" && e.provenance === "unverified")).toBe(true);
    expect(report.limitations.some((l) => l.includes("declared input"))).toBe(true);
  });

  it("is deterministic — the same ledger builds the same report body", async () => {
    const { inv } = await runPaidScenario("counterparty_due_diligence", SUBJECT, PAYLOADS);
    const { buildDeskReport } = await import("@/lib/desk/orchestrate");
    const a = buildDeskReport(inv, { mode: "intel", spendUsdCents: 8 });
    const b = buildDeskReport(inv, { mode: "intel", spendUsdCents: 8 });
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
    expect(JSON.stringify(a.discrepancies)).toBe(JSON.stringify(b.discrepancies));
    expect(JSON.stringify(a.assessment)).toBe(JSON.stringify(b.assessment));
    expect(JSON.stringify(a.sections)).toBe(JSON.stringify(b.sections));
  });

  it("a free rebuild of a file holding verified records never claims nothing is established", async () => {
    const { inv } = await runPaidScenario("counterparty_due_diligence", SUBJECT, PAYLOADS);
    const { buildDeskReport } = await import("@/lib/desk/orchestrate");
    const rebuilt = buildDeskReport(inv, { mode: "free", spendUsdCents: 8 });
    expect(rebuilt.assessment.summary).toContain("verified record(s)");
    expect(rebuilt.assessment.summary).not.toContain("route-only pre-flight");
    expect(rebuilt.assessment.verdict).toBe("hold_pending_review");
  });
});

/* ------------------------------------------------------------------ */
/* Asset: incomplete file, stated supply contradicts the verified one   */
/* ------------------------------------------------------------------ */

describe("asset intelligence — incomplete file, supply contradiction", () => {
  const SUBJECT = {
    assetClass: "digital_asset",
    assetName: "SCAMCOIN treasury",
    chain: "ethereum",
    tokenSymbol: "SCAMCOIN",
    declaredSupply: "1000000000",
    walletAddress: "0xabc000000000000000000000000000000000001",
  };
  const PAYLOADS: PayloadSpec[] = [
    {
      intent: "WALLET_BALANCE_CHECK_GENERAL",
      response: { address: SUBJECT.walletAddress, chain: "ethereum", balance: "0.0000", token_symbol: "ETH", as_of: "2026-11-26T00:00:00Z" },
    },
    {
      intent: "TOKEN_HOLDER_COUNT_GENERAL",
      response: { holders_count: 17, token_symbol: "SCAMCOIN", chain: "ethereum" },
    },
    { intent: "CRYPTO_PRICE_USD", response: { price_usd: 0.42 } },
    { intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", response: { total_supply: 750000000 } },
  ];

  it("flags the stated-vs-verified supply gap, holds conditions, and names the unasked issuer checks", async () => {
    const { inv, report } = await runPaidScenario("asset_intelligence", SUBJECT, PAYLOADS);

    // The issuer's stated supply contradicts the network-verified figure.
    const conflict = report.discrepancies.find((d) => d.kind === "field_conflict" && /Stated supply differs/.test(d.title));
    expect(conflict).toBeDefined();
    expect(conflict?.evidenceIds).toContain("declared:declaredSupply");
    expect(conflict?.detail).toContain("750,000,000");
    expect(conflict?.detail).toContain("1,000,000,000");

    // Unresolved contradiction → proceed with conditions, not a clean bill.
    expect(report.assessment.verdict).toBe("proceed_with_conditions");
    expect(report.assessment.nextActions.some((a) => /conflict/i.test(a.title))).toBe(true);

    // Incomplete file: the issuer checks were never asked and are named.
    expect(inv.evidence.some((e) => e.id === "input-gap:index-reconstitution-desk:registry")).toBe(true);
    expect(inv.evidence.some((e) => e.id === "input-gap:index-reconstitution-desk:filings")).toBe(true);
    expect(report.assessment.summary).toContain("not asked for lack of inputs");
    expect(report.assessment.nextActions.some((a) => a.title.includes("Issuer registry record"))).toBe(true);

    // Specific verified facts, not capability labels.
    expect(report.findings.some((f) => f.title.startsWith("Verified total supply: 750000000"))).toBe(true);
    expect(report.findings.some((f) => f.title.includes("Holder base: 17"))).toBe(true);
    expect(report.findings.some((f) => f.title.includes("Verified USD price: $0.42"))).toBe(true);
    expect(report.findings.some((f) => f.title.includes("balance 0.0000 ETH"))).toBe(true);

    // A thin holder base is recorded; the assessment never inflates it.
    expect(report.assessment.basis.join(" ")).toContain("never verified");
  });
});

/* ------------------------------------------------------------------ */
/* Trade: incomplete file, purchase order unverifiable                 */
/* ------------------------------------------------------------------ */

describe("trade & supplier intelligence — incomplete file, PO unverifiable", () => {
  const SUBJECT = {
    supplierName: "Siemens AG",
    jurisdiction: "DE",
    vatNumber: "DE129273398",
    poNumber: "PO-2026-0042",
    ledgerRef: "PO-2026-0042 45000 USD",
  };
  const PAYLOADS: PayloadSpec[] = [
    {
      intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
      response: { legal_name: "Siemens AG", registration_id: "HRB 12345", active: true, jurisdiction: "DE", registered_address: "Werner-von-Siemens-Str. 1, Munich", incorporated: "1897" },
    },
    {
      intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
      response: { name: "Siemens AG", matched: false, matches: "0", lists: "", match_score: 0 },
    },
    {
      intent: "B2B_IDENTITY_ENRICHMENT_GENERAL",
      response: { company: "Siemens AG", domain: "siemens.com", employee_count: 320000, industry: "Industrial manufacturing", headquarters: "Munich, DE" },
    },
    {
      intent: "VENDOR_VERIFY_GENERAL",
      response: { vendor: "Siemens AG", vat_number: "DE129273398", valid: true, registered_name: "Siemens AG", registered_address: "Werner-von-Siemens-Str. 1, Munich" },
    },
    {
      intent: "PURCHASE_ORDER_VERIFY_GENERAL",
      response: { po_number: "PO-2026-0042", verified: false, status: "not_found", vendor: "Siemens AG", amount: "45000 USD" },
    },
  ];

  it("conditions the file on the unverified PO and names every unasked document check", async () => {
    const { inv, report } = await runPaidScenario("trade_supplier_intelligence", SUBJECT, PAYLOADS);

    // Identity verified clean; the PO did not verify.
    expect(report.assessment.verdict).toBe("proceed_with_conditions");
    expect(report.findings.some((f) => f.severity === "material" && /Purchase order could not be verified/.test(f.title))).toBe(true);
    expect(report.assessment.nextActions.some((a) => /Confirm the purchase-order reference/.test(a.title))).toBe(true);
    expect(report.findings.some((f) => /VAT valid for Siemens AG/.test(f.title))).toBe(true);
    expect(report.findings.some((f) => /Sanctions screen: no match for Siemens AG/.test(f.title))).toBe(true);

    // Clean checks appear as basis lines; gaps stay named, not asked.
    expect(report.assessment.basis.join(" ")).toContain("Sanctions screens returned no match");
    expect(inv.evidence.some((e) => e.id === "input-gap:tradeverify:invoice_reconcile")).toBe(true);
    expect(inv.evidence.some((e) => e.id === "input-gap:tradeverify:delivery_window")).toBe(true);
    expect(inv.evidence.some((e) => e.id.startsWith("input-gap:portsentinel"))).toBe(true);
    const inputGap = inv.evidence.find((e) => e.id === "input-gap:tradeverify:invoice_reconcile");
    expect(inputGap?.detail).toMatch(/invoice/i);

    // The report's next steps point at the missing inputs, not invented asks.
    expect(report.assessment.nextActions.some((a) => a.title.includes("Invoice vs ledger"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Free run: nothing verified → no verdict is possible                 */
/* ------------------------------------------------------------------ */

describe("free pre-flight — no verdict without verified evidence", () => {
  it("refuses to assess a file that holds no verified fact", async () => {
    const inv = deskInv("counterparty_due_diligence", { legalName: "Acme Holdings", jurisdiction: "US" });
    inv.evidence.push({
      id: "probe:1",
      provenance: "unverified",
      class: "probe_verified",
      capability: "counterparty-intelligence:registry",
      label: "Corporate registry record",
      title: "Corporate registry record · route verified, no answer purchased",
      detail: "routable at $0.01 on eip155:84532 (unpaid probe; nothing signed)",
      facts: { intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL", provider: "zk-corp-atlas", priceUsdCents: 1 },
      source: { kind: "telegraph", ref: "unpaid probe", label: "zk-corp-atlas unpaid probe", observedAt: new Date().toISOString() },
    });
    const { buildDeskReport } = await import("@/lib/desk/orchestrate");
    const report = buildDeskReport(inv, { mode: "free", spendUsdCents: 0, routableOffers: 1 });
    expect(report.assessment.verdict).toBe("insufficient_verified_evidence");
    expect(report.assessment.summary).toContain("route-only pre-flight");
    expect(report.assessment.nextActions.some((a) => /Approve a paid run/.test(a.title))).toBe(true);
    expect(report.findings).toHaveLength(0);
  });
});
