/**
 * Deal Desk — specialised investigation workflows: shared record model.
 *
 * Three investigation types live behind the Deal Desk entry point:
 *
 *   counterparty_due_diligence   — the reference implementation
 *   asset_intelligence           — digital-asset, mining and energy assets
 *   trade_supplier_intelligence  — supplier, trade documents and logistics
 *
 * The record model is transport-free like the settlement-assurance model it
 * sits beside: the API routes, the workspace and a future channel (a
 * Telegraph tool call, a Minds delivery) share one type. The settlement
 * deal-file flow keeps its own record untouched.
 *
 * Provenance invariant (the product's central promise):
 *   verified            — a paid Telegraph answer whose committed payload
 *                         INDEPENDENTLY re-derived against the node signal
 *                         (keccak match), or a direct on-chain read
 *   unverified          — route/price verified by an UNPAID probe, a paid
 *                         answer that is only the node's word (asserted or
 *                         unconfirmed — class node_asserted), or an
 *                         operator-declared input
 *   verification_failed — a paid answer whose recorded payload FAILED the
 *                         independent hash re-derivation; the record is
 *                         retained with its signal, receipt and payload for
 *                         investigation, and is never rendered as a fact
 *   missing             — an unsupported requirement (a named network gap) or
 *                         a required input that was never supplied; never guessed
 *   analysis            — the desk's own synthesis, always labelled and always
 *                         traced to the evidence records it used
 */

import type { AuditEntry } from "@/lib/assurance/types";
import type { HunyuanAssuranceRecord } from "@/lib/hunyuan/types";

export type DeskInvestigationType =
  | "counterparty_due_diligence"
  | "asset_intelligence"
  | "trade_supplier_intelligence"
  | "listing_underwriter";

/** The provenance classes every claim must declare. */
export type ProvenanceClass = "verified" | "verification_failed" | "unverified" | "missing" | "analysis";

/** The raw mechanism class behind a provenance verdict. */
export type DeskEvidenceClass =
  | "node_verified"
  | "source_verified"
  | "probe_verified"
  | "paid_unverified"
  | "node_asserted"
  | "verification_failed"
  | "declared"
  | "missing"
  | "analysis";

export interface DeskEvidence {
  id: string;
  provenance: ProvenanceClass;
  class: DeskEvidenceClass;
  /** Workflow capability key, e.g. "counterparty-intelligence:registry". */
  capability: string;
  label: string;
  title: string;
  detail: string;
  /** Short, attributable scalars only; long text stays in `detail`. */
  facts: Record<string, string | number | boolean | null>;
  source: {
    kind: "telegraph" | "operator" | "none";
    /** Signal hash, intent, or the declared-input label. */
    ref: string;
    label: string;
    observedAt: string;
  };
  taskId?: string;
  signalHash?: string;
  receiptHash?: string;
  minerId?: string;
  costUsdCents?: number;
  /** Fields the dimension promised but the committed answer did not carry. */
  missingFields?: string[];
  /** True when the router's fallback ranking served the answer. */
  viaRouterFallback?: boolean;
  /** The full committed response, retained verbatim alongside the signal and
   *  receipt for verification_failed and node_asserted records — the payload
   *  is what an investigation of a failed re-derivation reads. */
  committedPayload?: Record<string, unknown> | null;
  /** Why the record is not independently verified ("hash_mismatch",
   *  "node_asserted", "no_confirmation"); set for the recorded classes. */
  verificationReason?: "hash_mismatch" | "node_asserted" | "no_confirmation";
}

export type DeskSeverity = "critical" | "material" | "minor" | "info";

export interface DeskFinding {
  id: string;
  severity: DeskSeverity;
  title: string;
  /** What the recorded evidence shows. */
  detail: string;
  /** Why it matters for this investigation. */
  significance: string;
  /** Always resolved; an analysis finding cites the evidence it used. */
  evidenceIds: string[];
  provenance: ProvenanceClass;
}

export type DeskDiscrepancyKind =
  | "jurisdiction_refinement"
  | "name_variance"
  | "missing_fields"
  | "provider_drift"
  | "provider_disagreement"
  | "field_conflict";

export interface DeskDiscrepancy {
  id: string;
  kind: DeskDiscrepancyKind;
  title: string;
  detail: string;
  evidenceIds: string[];
  /** Set for provider_disagreement: true when the answers diverge beyond a
   *  measurement difference (relative difference above the 0.5% tolerance the
   *  rest of the desk uses) — a material contradiction that the assessment
   *  must reflect. A harmless measurement difference stays false. */
  material?: boolean;
}

export interface DeskReportSection {
  id: string;
  title: string;
  summary: string;
  capabilityKeys: string[];
  evidenceIds: string[];
  /** The strongest provenance actually present in the section. */
  provenance: ProvenanceClass;
}

export type DeskConfidence = "signal_verified" | "partially_verified" | "route_verified_only" | "unverified";

/**
 * The desk's overall verdict. Derived from recorded evidence only, always
 * labelled analysis, and phrased as a next step — never a legal, sanctions,
 * credit or investment determination.
 */
export type DeskVerdict =
  | "hold_pending_review"
  | "proceed_with_conditions"
  | "proceed_on_record"
  | "insufficient_verified_evidence";

export interface DeskNextAction {
  /** The action, imperative and specific. */
  title: string;
  /** Why, and what settling it would mean for this file. */
  detail: string;
  /** What the action traces to: evidence ids, capability keys or named gaps. */
  basis: string[];
}

export interface DeskAssessment {
  verdict: DeskVerdict;
  /** 2–4 sentences: what was established, what is adverse, what the file cannot speak to. */
  summary: string;
  /** The decisive inputs, one line each, traced to their evidence. */
  basis: string[];
  /** Concrete outstanding checks and recommended next actions, most decisive first. */
  nextActions: DeskNextAction[];
}

export interface DeskReport {
  preparedAt: string;
  type: DeskInvestigationType;
  mode: "free" | "intel";
  headline: string;
  /** The desk's executive assessment — the labelled analysis verdict. */
  assessment: DeskAssessment;
  findings: DeskFinding[];
  discrepancies: DeskDiscrepancy[];
  sections: DeskReportSection[];
  /** Confidence limitations, stated plainly. */
  limitations: string[];
  outstandingQuestions: string[];
  counts: {
    verified: number;
    verification_failed: number;
    unverified: number;
    /** Subset of unverified: paid answers retained on the node's word only. */
    node_asserted: number;
    missing: number;
    analysis: number;
  };
  confidence: DeskConfidence;
}

export interface DeskRun {
  taskId: string;
  mode: "free" | "intel";
  createdAt: string;
  taskState: string;
  ceilingUsdCents: number;
  absorbed: boolean;
}

/** A requirement the network cannot answer, named at file-open. */
export interface DeskUnsupportedRequirement {
  capabilityKey: string;
  label: string;
  requirement: string;
  reason: string;
  resolution: string;
}

export type DeskStatus = "draft" | "collecting" | "reported";

export interface DeskInvestigation {
  id: string;
  reference: string;
  /** Discriminates desk records from settlement deal-files. */
  kind: "desk";
  type: DeskInvestigationType;
  createdAt: string;
  updatedAt: string;
  status: DeskStatus;
  dataMode: "live";
  /** Wallet address (lowercase) that opened the file. */
  owner: string | null;
  /** The guided form answers, verbatim. Operator-declared, never verified. */
  subject: Record<string, string>;
  /** The workflow's declared unsupported requirements at open time. */
  unsupported: DeskUnsupportedRequirement[];
  evidence: DeskEvidence[];
  findings: DeskFinding[];
  report: DeskReport | null;
  runs: DeskRun[];
  spendLimitUsdCents: number;
  operator: { createdBy: string; tenant: string };
  audit: AuditEntry[];
  /**
   * Mission #01 — the persisted Hunyuan decision-assurance review (analysis,
   * never an evidence class), when one has run for this file.
   */
  hunyuanAssurance?: HunyuanAssuranceRecord | null;
}

export interface DeskInvestigationSummary {
  id: string;
  reference: string;
  type: DeskInvestigationType;
  createdAt: string;
  status: DeskStatus;
  subject: string;
  evidenceCount: number;
  verifiedCount: number;
  missingCount: number;
  findingCount: number;
  runs: number;
  confidence: DeskConfidence | null;
}

export const DESK_TYPE_LABEL: Record<DeskInvestigationType, string> = {
  counterparty_due_diligence: "Counterparty Due Diligence",
  asset_intelligence: "Asset Intelligence",
  trade_supplier_intelligence: "Trade & Supplier Intelligence",
  listing_underwriter: "Listing Underwriter",
};

export const DESK_VERDICT_LABEL: Record<DeskVerdict, string> = {
  hold_pending_review: "Hold — resolve before money moves",
  proceed_with_conditions: "Proceed with conditions",
  proceed_on_record: "No adverse signal in the recorded checks",
  insufficient_verified_evidence: "Insufficient verified evidence to assess",
};

export function deskEvidenceCounts(inv: Pick<DeskInvestigation, "evidence">): DeskReport["counts"] {
  const counts = { verified: 0, verification_failed: 0, unverified: 0, node_asserted: 0, missing: 0, analysis: 0 };
  // Records written before the evidence ledger existed have no array at all:
  // this exact dereference killed the Overview render ("a.evidence is not
  // iterable"), so an absent ledger counts as an empty one — never a throw.
  const evidence = Array.isArray(inv.evidence) ? inv.evidence : [];
  for (const e of evidence) {
    if (!e || typeof e.provenance !== "string" || !(e.provenance in counts)) continue;
    counts[e.provenance] += 1;
    if (e.provenance === "unverified" && e.class === "node_asserted") counts.node_asserted += 1;
  }
  return counts;
}
