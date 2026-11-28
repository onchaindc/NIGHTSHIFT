/**
 * Tencent Hunyuan integration — shared record types.
 *
 * Transport-free, import-free (no zod, no fetch): every module in the app can
 * reference these shapes without pulling the provider adapter in. The records
 * persist on the EXISTING investigation stores (assurance + desk) and in the
 * continuum ledger, never in a parallel evidence store.
 */

/** Token usage as reported by the OpenAI-compatible usage block. */
export interface HunyuanUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/** Provenance of every Hunyuan-written record: always reasoning, never evidence. */
export const HUNYUAN_PROVIDER = "tencent-hunyuan" as const;

/**
 * Mission #01 — Enterprise Decision Assurance review.
 *
 * Persisted ON the investigation record it analysed (assurance or desk). Every
 * citation in `evidenceIds` is validated against the record's own evidence
 * ledger and the entity's continuum events BEFORE the review is stored: a
 * citation the record cannot resolve is stripped (the claim moves to
 * rejectedClaims), so a stored review never references evidence that does not
 * exist. Hunyuan output is labelled analysis throughout — it never becomes an
 * evidence class.
 */
export interface HunyuanAssuranceRecord {
  provider: typeof HUNYUAN_PROVIDER;
  scope: "assurance" | "desk";
  /** When the review ran. */
  runAt: string;
  model: string;
  /** Ids the model cited that no recorded evidence or event could resolve. */
  rejectedClaims: Array<{ location: string; reason: string }>;
  usage: HunyuanUsage | null;
  durationMs: number;
  review: DecisionAssuranceReview;
}

export type AssuranceSeverity = "critical" | "material" | "minor" | "info";
export type FindingBasis = "established_fact" | "inference";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface DecisionAssuranceReview {
  subject: string;
  headline: string;
  materialFindings: Array<{
    title: string;
    severity: AssuranceSeverity;
    basis: FindingBasis;
    explanation: string;
    significance: string;
    evidenceIds: string[];
  }>;
  establishedFacts: Array<{ statement: string; evidenceIds: string[] }>;
  inferences: Array<{ statement: string; reasoning: string; evidenceIds: string[] }>;
  unknowns: Array<{ question: string; whyMaterial: string }>;
  conflicts: Array<{ title: string; detail: string; evidenceIds: string[] }>;
  missingEvidence: Array<{ requirement: string; whyMaterial: string; suggestedCapability: string }>;
  risks: Array<{ title: string; detail: string; severity: AssuranceSeverity }>;
  confidence: { level: ConfidenceLevel; basis: string };
  conclusions: Array<{ statement: string; actionable: boolean; evidenceIds: string[] }>;
  recommendedVerification: Array<{ step: string; capability: string; tracesTo: string }>;
  limitations: string[];
}

/**
 * Mission #02 — Continuous Enterprise Intelligence event.
 *
 * Detection is DETERMINISTIC (code, not the model): new evidence, material
 * field changes, contradictions, staleness and decision changes are computed
 * from the persisted records, deduplicated by content fingerprint, and only
 * THEN offered to Hunyuan for materiality narrative. The model never decides
 * what happened — it assesses what the code already detected. A provider
 * failure leaves the event in the ledger with `providerAssessment: null` and
 * the failure recorded in the run log; it is never silent and never fatal.
 */
export interface ContinuumEvent {
  id: string;
  ts: string;
  entityKey: string;
  entityLabel: string;
  kind:
    | "new_evidence"
    | "field_change"
    | "contradiction"
    | "stale_evidence"
    | "decision_change"
    | "desk_report_change";
  title: string;
  detail: string;
  /** Deterministic materiality; the provider assessment may override it. */
  materiality: "material" | "minor";
  /** Hunyuan assessment when the provider ran; null means it did not. */
  providerAssessment: {
    summary: string;
    materiality: "material" | "minor";
    recommendedAction: string;
    model: string;
    usage: HunyuanUsage | null;
  } | null;
  investigationIds: Array<{ scope: "assurance" | "desk"; id: string; reference: string }>;
  evidenceIds: string[];
  /** sha256 of (entity, kind, canonical payload) — the dedup key. */
  fingerprint: string;
  limitations: string[];
}

/** One analysis pass over every tracked entity. */
export interface ContinuumRunRecord {
  at: string;
  trigger: "scheduler" | "manual";
  scannedEntities: number;
  baselinesEstablished: number;
  newEvents: number;
  enriched: number;
  providerConfigured: boolean;
  providerError: string | null;
  skippedByOtherWorker: boolean;
  error: string | null;
}
