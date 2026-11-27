/**
 * The published NIGHTSHIFT service offerings on ACP.
 *
 * Every offering maps ONE ACP service to ONE existing Deal Desk workflow —
 * the input schema IS the workflow's own guided-form fields (same names,
 * same required flags, same options), so an ACP buyer fills exactly the form
 * a human fills and the investigation that runs is the one the Deal Desk
 * already executes. Nothing is invented here: an offering exists only when
 * its workflow and its capability routes exist.
 */

import { DESK_WORKFLOWS } from "@/lib/desk/workflows";
import type { AcpServiceInput, AcpServiceOffering } from "./types";

/**
 * The four desk workflows exposed as commercial services. Repriced to the
 * $0.01 introductory price to match the Virtuals dashboard update
 * (2026-11): this table is the ONE pricing source — the provider quotes it
 * (setBudget), the buyer catalog serves it, and every display derives from
 * it. If the Virtuals-side price changes again, change it here in the same
 * motion or the two will drift apart.
 */
const PRICES_USD_CENTS: Record<string, number> = {
  counterparty_due_diligence: 1,
  listing_underwriter: 1,
  asset_intelligence: 1,
  trade_supplier_intelligence: 1,
};

/** The workflows' own worked examples — the buyer's "Fill sample values" action. */
const SAMPLES: Record<string, Record<string, string>> = {
  counterparty_due_diligence: DESK_WORKFLOWS.counterparty_due_diligence.samples,
  listing_underwriter: DESK_WORKFLOWS.listing_underwriter.samples,
  asset_intelligence: DESK_WORKFLOWS.asset_intelligence.samples,
  trade_supplier_intelligence: DESK_WORKFLOWS.trade_supplier_intelligence.samples,
};

const OUTPUTS: Record<string, string> = {
  counterparty_due_diligence:
    "Structured due-diligence report: independently verified registry, screening and financial records with signal hashes and receipts, named verification failures, provider disagreements, missing evidence, unsupported requirements, an executive assessment with a verdict and traced next actions.",
  listing_underwriter:
    "Listing underwriting report: token, issuer, market and holder evidence with provenance per record, verification failures named (never rendered as facts), measurement-vs-material discrepancy classification, named unsupported requirements, and a final underwriting assessment.",
  asset_intelligence:
    "Asset intelligence report scoped to the asset class: verified supply, market and network records with receipts, discrepancies and gaps named, and a traced assessment.",
  trade_supplier_intelligence:
    "Trade and supplier intelligence report: registry, VAT and document-chain verification (PO, invoice, vessel telemetry where inputs allow), conflicts named on both sides, and a traced assessment.",
};

const POLICY: Record<string, string> = {
  counterparty_due_diligence:
    "Free pre-flight runs automatically on funding (no spend). The paid run is created immediately after and stays parked at the human approval gate; a NIGHTSHIFT operator releases it through the existing approval controls. One attempt per planned capability, pinned to its provider, refused on offer drift.",
  listing_underwriter:
    "Free pre-flight runs automatically on funding (no spend). The paid run is created immediately after and stays parked at the human approval gate; a NIGHTSHIFT operator releases it through the existing approval controls. One attempt per planned capability, pinned to its provider, refused on offer drift.",
  asset_intelligence:
    "Free pre-flight runs automatically on funding (no spend). The paid run is created immediately after and stays parked at the human approval gate; a NIGHTSHIFT operator releases it through the existing approval controls. One attempt per planned capability, pinned to its provider, refused on offer drift.",
  trade_supplier_intelligence:
    "Free pre-flight runs automatically on funding (no spend). The paid run is created immediately after and stays parked at the human approval gate; a NIGHTSHIFT operator releases it through the existing approval controls. One attempt per planned capability, pinned to its provider, refused on offer drift.",
};

function inputsOf(type: keyof typeof DESK_WORKFLOWS): AcpServiceInput[] {
  return DESK_WORKFLOWS[type].fields.map((f) => ({
    name: f.name,
    label: f.label,
    kind: f.kind,
    required: f.required,
    ...(f.options ? { options: f.options } : {}),
    ...(f.help ? { help: f.help } : {}),
  }));
}

function slug(name: string): string {
  return `nightshift/${name.replace(/_/g, "-")}`;
}

/** The published offerings, in desk order. */
export const ACP_OFFERINGS: AcpServiceOffering[] = (
  ["counterparty_due_diligence", "listing_underwriter", "asset_intelligence", "trade_supplier_intelligence"] as const
).map((type) => ({
  id: slug(type),
  investigationType: type,
  name: DESK_WORKFLOWS[type].name,
  description: `${DESK_WORKFLOWS[type].summary} Scope: ${DESK_WORKFLOWS[type].scope}`,
  priceUsdCents: PRICES_USD_CENTS[type] ?? 100,
  inputs: inputsOf(type),
  samples: SAMPLES[type] ?? {},
  outputs: OUTPUTS[type] ?? "",
  executionPolicy: POLICY[type] ?? "",
}));

export function offeringById(id: string): AcpServiceOffering | undefined {
  const normalized = id.trim().toLowerCase();
  return ACP_OFFERINGS.find((o) => o.id === normalized || o.investigationType === normalized);
}

export interface RequirementValidation {
  ok: boolean;
  /** The subject fields, exactly as a desk form submission. */
  subject: Record<string, string>;
  missing: string[];
  unknown: string[];
  error: string | null;
}

/**
 * Validate a buyer requirement against the offering's schema. Required fields
 * must be present and non-empty; unknown fields are listed and dropped (the
 * desk engine never invents inputs). Nothing is coerced: values stay strings,
 * exactly what the guided form stores.
 */
export function validateRequirement(offering: AcpServiceOffering, requirement: Record<string, unknown>): RequirementValidation {
  const missing: string[] = [];
  const subject: Record<string, string> = {};
  const unknown: string[] = [];
  const known = new Set(offering.inputs.map((i) => i.name));
  for (const field of offering.inputs) {
    const value = requirement[field.name];
    if (value === undefined || value === null || String(value).trim() === "") {
      if (field.required) missing.push(field.name);
      continue;
    }
    if (field.kind === "select" && field.options && !field.options.some((o) => o.value === String(value))) {
      missing.push(field.name);
      continue;
    }
    subject[field.name] = String(value).trim();
  }
  for (const key of Object.keys(requirement)) {
    if (!known.has(key)) unknown.push(key);
  }
  return {
    ok: missing.length === 0,
    subject,
    missing,
    unknown,
    error: missing.length > 0 ? `missing required input(s): ${missing.join(", ")}` : null,
  };
}
