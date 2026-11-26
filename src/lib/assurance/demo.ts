/**
 * The demonstration scenario.
 *
 * Every record here is labelled `demonstration`: it is a fixture that
 * describes a realistic institutional file, not a live registry, sanctions or
 * chain result. No transaction hash, signal hash or receipt is invented, and
 * the file can never be CLEARED or settled.
 */

import { createHash } from "node:crypto";

import { assessInvestigation } from "./assess";
import { base58Encode } from "./solana";
import { audit, newInvestigationId, newReference } from "./store";
import { USDC_MINT_MAINNET, type AssuranceEvidence, type Investigation } from "./types";

/** Deterministic 32-byte address for the fixture. It is not a funded account. */
function demoAddress(seed: string): string {
  return base58Encode(createHash("sha256").update(`nightshift-assurance-demo:${seed}`).digest());
}

const DEMO_TS = "2026-11-24T09:15:00.000Z";

function demoEvidence(
  id: string,
  capability: string,
  title: string,
  detail: string,
  facts: Record<string, string | number | boolean | null>,
  label: string,
): AssuranceEvidence {
  return {
    id,
    class: "demonstration",
    capability,
    title,
    detail,
    facts,
    source: { kind: "demo", ref: `demo://${id}`, label: `Demonstration fixture · ${label}`, observedAt: DEMO_TS },
  };
}

export function createDemoInvestigation(createdBy = "operator"): Investigation {
  const now = new Date().toISOString();
  const inv: Investigation = {
    id: newInvestigationId(),
    reference: newReference(),
    createdAt: now,
    updatedAt: now,
    status: "collecting",
    dataMode: "demonstration",
    owner: null,
    transaction: {
      payerWallet: demoAddress("payer"),
      recipientWallet: demoAddress("recipient"),
      amountUsdc: 2_400_000,
      tokenMint: USDC_MINT_MAINNET,
      jurisdiction: "GB",
      approvedBeneficiary: "Northstar Capital Holdings Ltd",
      contractRef: "MSA-2026-0417 / drawdown 3",
      memo: "Northstar drawdown 3 settlement",
      documents: [
        {
          name: "Northstar master settlement agreement (drawdown 3).pdf",
          note: "Demonstration fixture: the document is described, not supplied, so no integrity check has run.",
        },
      ],
      ownershipRequired: true,
    },
    counterparty: {
      legalName: "Northstar Capital Holdings Ltd",
      registrationNumber: "UK-09876543",
      walletLabel: "Northstar operating wallet (per payment instruction)",
      contact: "treasury@northstar-capital.example",
    },
    evidence: [
      demoEvidence(
        "demo-registry",
        "counterparty_registry",
        "Corporate registry identity",
        "Register record for the entity resolved from the payment instruction's trading name.",
        {
          legal_name: "Northstar Capital Holdings (BVI) Limited",
          registration_id: "BVI-7742190",
          active: true,
          jurisdiction: "VG",
          registered_address: "Road Town, Tortola, VG1110, British Virgin Islands",
          incorporated: "2019-04-02",
        },
        "corporate registry",
      ),
      demoEvidence(
        "demo-enrichment",
        "firmographic_enrichment",
        "Firmographic enrichment",
        "Commercial identity fields for the entity resolved from the same trading name.",
        {
          company: "Northstar Capital Holdings (BVI) Limited",
          domain: "northstar-capital.example",
          employee_count: 48,
          industry: "Investment holding",
          headquarters: "Tortola, British Virgin Islands",
        },
        "firmographic enrichment",
      ),
      demoEvidence(
        "demo-sanctions",
        "sanctions_screening",
        "Sanctions screening",
        "Name screen of the counterparty as written in the payment instruction.",
        { name: "Northstar Capital Holdings Ltd", matched: false, match_score: 0.04, lists: "OFAC SDN; EU consolidated" },
        "sanctions screen",
      ),
      demoEvidence(
        "demo-filings",
        "regulatory_filings",
        "Regulatory filings",
        "Filings recorded for the registered entity over the last twelve months.",
        {
          entity: "Northstar Capital Holdings (BVI) Limited",
          filing_count: 3,
          filings: "Annual return 2025; Change of directors 2025; Charge registration 2024",
        },
        "regulatory filings",
      ),
      demoEvidence(
        "demo-document",
        "document_authenticity",
        "Document integrity",
        "Integrity result for the settlement agreement described in the file.",
        { document: "Northstar master settlement agreement (drawdown 3).pdf", authentic: true, verdict: "Likely authentic" },
        "document authenticity",
      ),
    ],
    findings: [],
    decision: null,
    intelligenceRuns: [],
    settlement: null,
    spendLimitUsdCents: 10,
    operator: { createdBy, tenant: "nightshift-institutional" },
    audit: [],
    limitations: [],
  };

  const assessment = assessInvestigation(inv);
  inv.findings = assessment.findings;
  inv.decision = assessment.decision;
  inv.limitations = [
    "Demonstration file: counterparty records are labelled fixtures, not live registry, sanctions or filing results.",
    "No live Solana read has been run for the demonstration wallets; the wallet addresses are deterministic fixtures and hold no funds.",
    ...assessment.limitations,
  ];
  inv.status = "assessed";

  audit(inv, createdBy, "demonstration_created", "Seeded the Northstar Capital demonstration scenario.");
  audit(
    inv,
    "system",
    "assessed",
    `Deterministic assessment recorded ${assessment.decision.outcome} with ${assessment.findings.length} finding(s). No settlement is authorized.`,
  );
  return inv;
}
