/**
 * The settlement-assurance capability matrix.
 *
 * Every supported dimension below was verified against the live node: the
 * canonical `{intent, params}` body, the pinned provider and the live x402
 * price were accepted during an unpaid probe. Document authenticity and
 * contract obligations use the router because no single provider is pinned
 * for them; they are marked partial for that reason.
 *
 * Beneficial ownership is a first-class GAP. The network has no verified
 * ownership-traversal intent (the OwnershipGraph Mind documents the same
 * limit), so this product does not claim it.
 */

import type { CapabilityDimension } from "@/lib/minds/capabilities";

export const ASSURANCE_MIND_SLUG = "settlement-assurance";

export const ASSURANCE_INTENTS = {
  registry: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
  enrichment: "B2B_IDENTITY_ENRICHMENT_GENERAL",
  sanctions: "SANCTIONS_SCREENING_MATCH_GENERAL",
  filings: "REGULATORY_FILING_MONITOR_GENERAL",
  document: "DOCUMENT_AUTHENTICITY_GENERAL",
  contract: "CONTRACT_OBLIGATION_AUDIT_GENERAL",
} as const;

export const ASSURANCE_CAPABILITIES: CapabilityDimension[] = [
  {
    id: "counterparty_registry",
    label: "Corporate registry identity",
    requirement: "Who is the counterparty in the official register, and is it active?",
    status: "verified",
    intent: ASSURANCE_INTENTS.registry,
    provider: "zk-corp-atlas",
    params: {
      company: { type: "string", required: true, description: "Registered legal name, LEI or registry identifier" },
      jurisdiction: { type: "string", required: true, description: "ISO 3166 alpha-2 jurisdiction" },
    },
    responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
    priceUsdCents: 1,
    verification: "integration_verified",
    output: "Registered legal identity and status for one entity.",
    evidence: "Live product path: the pinned provider has returned hash-committed answers on this deployment.",
    limitation: "Resolves one entity. It does not traverse parents, subsidiaries or beneficial owners.",
  },
  {
    id: "sanctions_screening",
    label: "Sanctions screening",
    requirement: "Does the counterparty name hit a sanctions list?",
    status: "verified",
    intent: ASSURANCE_INTENTS.sanctions,
    provider: "zk-sanctions",
    params: { name: { type: "string", required: true, description: "Person or entity name" } },
    responseFields: ["name", "matched", "matches", "lists", "match_score"],
    priceUsdCents: 1,
    verification: "probe_verified",
    output: "Match verdict, matched entries, list names and fuzzy score.",
    evidence: "Canonical schema and provider accepted by the node during an unpaid probe.",
    limitation: "A name screen is probabilistic and is not a legal determination.",
  },
  {
    id: "regulatory_filings",
    label: "Regulatory filings",
    requirement: "What has the counterparty disclosed in the period?",
    status: "verified",
    intent: ASSURANCE_INTENTS.filings,
    provider: "verireceipt",
    params: {
      entity: { type: "string", required: true, description: "Company or concern" },
      period: { type: "string", required: true, description: "Period, e.g. last 12 months" },
    },
    responseFields: ["entity", "filing_count", "filings", "urls"],
    priceUsdCents: 1,
    verification: "probe_verified",
    output: "Filing count and source URLs for the period.",
    evidence: "Canonical schema and provider accepted by the node during an unpaid probe.",
    limitation: "Filing coverage depends on the provider's sources; absence of a filing is not evidence of no filing.",
  },
  {
    id: "firmographic_enrichment",
    label: "Firmographic enrichment",
    requirement: "Do the commercial identity fields agree with the approved beneficiary?",
    status: "partial",
    intent: ASSURANCE_INTENTS.enrichment,
    provider: "txlens",
    params: { company: { type: "string", required: true, description: "Company name or web domain" } },
    responseFields: ["company", "domain", "employee_count", "industry", "headquarters"],
    priceUsdCents: 1,
    verification: "probe_verified",
    output: "Commercial identity fields for the company.",
    evidence: "Canonical schema and provider accepted by the node during an unpaid probe.",
    limitation: "The pinned provider is a multi-intent aggregator; accuracy is not claimed until a paid answer is reconciled.",
  },
  {
    id: "document_authenticity",
    label: "Document integrity",
    requirement: "Is the supporting contractual document genuine and unaltered?",
    status: "partial",
    intent: ASSURANCE_INTENTS.document,
    provider: "router",
    params: { document: { type: "string", required: true, description: "Document text or a link to it" } },
    responseFields: ["document", "authentic", "verdict", "evidence"],
    priceUsdCents: 1,
    verification: "probe_verified",
    output: "Authenticity verdict and the evidence behind it.",
    evidence: "Intent schema verified on the live node; the provider is chosen by the router.",
    limitation: "No provider is pinned, so the reviewer behind a verdict is not fixed. A verdict is not a legal opinion.",
  },
  {
    id: "contract_obligations",
    label: "Contract obligations",
    requirement: "What does the contract require, and does the payment match it?",
    status: "partial",
    intent: ASSURANCE_INTENTS.contract,
    provider: "router",
    params: { contract: { type: "string", required: true, description: "Contract text or a link to it" } },
    responseFields: ["verdict", "obligations", "clauses", "summary"],
    priceUsdCents: 1,
    verification: "probe_verified",
    output: "Obligations, cited clauses and a compliance verdict.",
    evidence: "Intent schema verified on the live node; the provider is chosen by the router.",
    limitation: "The payment is compared with cited clauses only; this is not a legal opinion.",
  },
  {
    id: "beneficial_ownership",
    label: "Beneficial ownership",
    requirement: "Who ultimately owns and controls the counterparty?",
    status: "gap",
    missingReason:
      "No verified beneficial-ownership or group-traversal intent exists on the network. Single-entity registry resolution is not an ownership chain.",
    resolution: "Source an ownership register or a shareholding feed outside Telegraph and attach it as operator evidence, or keep the transaction at HOLD.",
  },
];

/** The dimensions a live investigation can ask, keyed by id. */
export function assuranceDimensions(): CapabilityDimension[] {
  return ASSURANCE_CAPABILITIES;
}

export function assuranceDimension(id: string): CapabilityDimension | undefined {
  return ASSURANCE_CAPABILITIES.find((d) => d.id === id);
}
