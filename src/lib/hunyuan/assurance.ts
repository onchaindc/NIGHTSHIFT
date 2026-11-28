/**
 * Mission #01 — Enterprise Decision Assurance (Tencent Hunyuan).
 *
 * A real decision-assurance workflow over the EXISTING investigation records:
 * it reads an assurance settlement file or a desk investigation, gathers the
 * entity's recorded evidence (and the entity's continuum intelligence events),
 * asks Hunyuan for a structured assurance review, enforces evidence
 * traceability locally, and persists the review ON the investigation record it
 * analysed — with an audit entry — so it renders beside the evidence it used.
 *
 * Non-negotiables:
 *  - Hunyuan output is ANALYSIS, never an evidence class. It never joins the
 *    evidence ledger and never drives a settlement authorization.
 *  - Traceability is enforced by CODE, not by the model: every cited id must
 *    resolve to a recorded evidence record or continuum event. Citations that
 *    do not resolve are stripped and the claim is moved to rejectedClaims —
 *    an unsupported conclusion is never stored as a finding.
 *  - Missing credentials, provider failures and schema violations are typed
 *    errors; nothing is fabricated in their place.
 */

import { decisionAssuranceReviewSchema, citationViolations } from "./schema";
import { hunyuanStructured, missingHunyuanCredentials, HunyuanCredentialsError } from "./client";
import type { ContinuumEvent, DecisionAssuranceReview, HunyuanAssuranceRecord } from "./types";
import { getInvestigation, audit, saveInvestigation } from "@/lib/assurance/store";
import { getDeskInvestigation, auditDesk, saveDeskInvestigation } from "@/lib/desk/store";
import { readEntityEvents } from "./continuum";
import { entityKeyForAssurance, entityKeyForDesk, entityLabel, type TrackedScope } from "./entities";
import type { Investigation } from "@/lib/assurance/types";
import type { DeskInvestigation } from "@/lib/desk/types";

export class DecisionAssuranceError extends Error {
  /** HTTP status the API route should map this to. */
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DecisionAssuranceError";
    this.status = status;
  }
}

/** Hard output bounds: the digest and the prompt never grow with the record. */
const MAX_EVIDENCE_ITEMS = 40;
const MAX_EVENTS = 12;
const MAX_FACT_VALUE = 120;
const MAX_DETAIL = 300;

export interface ContextItem {
  id: string;
  kind: "evidence" | "event";
  provenance: string | null;
  capability: string | null;
  title: string;
  detail: string;
  facts: Record<string, string | number | boolean | null>;
  observedAt: string | null;
}

export interface DecisionContext {
  scope: TrackedScope;
  id: string;
  reference: string;
  entity: string;
  entityKey: string | null;
  status: string;
  decision: string | null;
  recordedFindings: Array<{ id: string; severity: string; title: string; evidenceIds: string[] }>;
  conflicts: Array<{ id: string; kind: string; title: string; detail: string; evidenceIds: string[] }>;
  limitations: string[];
  evidence: ContextItem[];
  events: ContextItem[];
}

function clip(text: string | undefined | null, max: number): string {
  return (text ?? "").slice(0, max);
}

function clipFacts(facts: Record<string, string | number | boolean | null> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(facts ?? {})) {
    out[key.slice(0, 60)] = typeof value === "string" ? value.slice(0, MAX_FACT_VALUE) : value;
  }
  return out;
}

/** Evidence items, newest first, bounded. */
function evidenceItemsOf(inv: Investigation | DeskInvestigation, scope: TrackedScope): ContextItem[] {
  const records = (inv.evidence ?? []) as unknown as Array<Record<string, unknown>>;
  const items: ContextItem[] = records.map((e) => {
    const source = (e.source ?? {}) as { observedAt?: string };
    return {
      id: String(e.id ?? ""),
      kind: "evidence",
      provenance: String(e.provenance ?? e.class ?? "unknown"),
      capability: e.capability ? String(e.capability) : null,
      title: clip(String(e.title ?? e.label ?? ""), 160),
      detail: clip(String(e.detail ?? ""), MAX_DETAIL),
      facts: clipFacts(e.facts as Record<string, string | number | boolean | null> | undefined),
      observedAt: source.observedAt ? String(source.observedAt) : null,
    };
  });
  items.sort((a, b) => String(b.observedAt ?? "").localeCompare(String(a.observedAt ?? "")));
  return items.slice(0, MAX_EVIDENCE_ITEMS).filter((item) => item.id);
}

function eventsToItems(events: ContinuumEvent[]): ContextItem[] {
  return events.slice(0, MAX_EVENTS).map((event) => ({
    id: event.id,
    kind: "event",
    provenance: event.materiality === "material" ? "material_development" : "minor_development",
    capability: null,
    title: clip(event.title, 160),
    detail: clip(event.providerAssessment?.summary ?? event.detail, MAX_DETAIL),
    facts: {},
    observedAt: event.ts,
  }));
}

/**
 * The full decision context for one record: narrative fields, the bounded
 * evidence digest and the entity's continuum events (traceable by id).
 */
export async function buildDecisionContext(scope: TrackedScope, id: string): Promise<DecisionContext> {
  if (scope === "assurance") {
    const inv = await getInvestigation(id);
    if (!inv) throw new DecisionAssuranceError(`assurance investigation ${id} not found`, 404);
    const entityKey = entityKeyForAssurance(inv);
    const events = entityKey ? await readEntityEvents(entityKey, MAX_EVENTS) : [];
    return {
      scope,
      id,
      reference: inv.reference ?? "",
      entity: entityLabel(inv, "assurance"),
      entityKey,
      status: inv.status ?? "draft",
      decision: inv.decision ? `${inv.decision.outcome}: ${inv.decision.rationale}` : null,
      recordedFindings: (inv.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, title: f.title, evidenceIds: f.evidenceIds ?? [] })),
      conflicts: [],
      limitations: (inv.limitations ?? []).slice(0, 10),
      evidence: evidenceItemsOf(inv, scope),
      events: eventsToItems(events),
    };
  }
  const inv = await getDeskInvestigation(id);
  if (!inv) throw new DecisionAssuranceError(`desk investigation ${id} not found`, 404);
  const entityKey = entityKeyForDesk(inv);
  const events = entityKey ? await readEntityEvents(entityKey, MAX_EVENTS) : [];
  return {
    scope,
    id,
    reference: inv.reference ?? "",
    entity: entityLabel(inv, "desk"),
    entityKey,
    status: inv.status ?? "draft",
    decision: inv.report ? `${inv.report.assessment.verdict}: ${inv.report.assessment.summary}` : null,
    recordedFindings: (inv.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, title: f.title, evidenceIds: f.evidenceIds ?? [] })),
    conflicts: (inv.report?.discrepancies ?? []).slice(0, 10).map((d) => ({ id: d.id, kind: d.kind, title: d.title, detail: clip(d.detail, MAX_DETAIL), evidenceIds: d.evidenceIds ?? [] })),
    limitations: (inv.report?.limitations ?? inv.report?.outstandingQuestions ?? []).slice(0, 10),
    evidence: evidenceItemsOf(inv, scope),
    events: eventsToItems(events),
  };
}

const SYSTEM_PROMPT = `You are the decision-assurance analyst inside NIGHTSHIFT, an intelligence platform whose central promise is provenance: every claim declares whether it is verified, unverified, failed verification or missing.

Your review is ANALYSIS. You are not an evidence source. You must:

1. Cite ONLY ids that appear in the provided evidence and events lists. Never invent, mutate or abbreviate an id. A claim you cannot tie to a listed id does not belong in materialFindings, establishedFacts, inferences, conflicts or conclusions — put it in unknowns or missingEvidence instead.
2. Label the basis of every material finding: "established_fact" only when the cited evidence itself recorded the fact; "inference" when you derived it from several records.
3. Separate what is established from what is inferred and from what is simply unknown. Unknowns are first-class: name the question and why it is material.
4. Report conflicting records as conflicts — never resolve a contradiction silently.
5. Name missing evidence with the capability that could supply it.
6. Explain confidence and its basis in the evidence classes actually present.
7. Produce actionable conclusions and concrete recommended verification steps, each tracing to what prompted it.
8. Never render a legal, sanctions, credit or investment determination. Recommendations are next steps, not verdicts.
9. If the evidence is thin, say so in limitations and lower the confidence. An honest "cannot be established" is a correct answer.

Reply with ONLY a JSON object with exactly these keys: subject, headline, materialFindings, establishedFacts, inferences, unknowns, conflicts, missingEvidence, risks, confidence, conclusions, recommendedVerification, limitations.`;

function userPrompt(ctx: DecisionContext): string {
  return `Assure this decision file.

RECORD: scope=${ctx.scope} reference=${ctx.reference} status=${ctx.status}
ENTITY: ${ctx.entity}
DECISION RECORDED: ${ctx.decision ?? "(none yet)"}
RECORDED FINDINGS (rule-based, for context): ${JSON.stringify(ctx.recordedFindings)}
RECORDED CONFLICTS: ${JSON.stringify(ctx.conflicts)}
RECORD LIMITATIONS: ${JSON.stringify(ctx.limitations)}

EVIDENCE (cite these ids; ${ctx.evidence.length} record(s)):
${JSON.stringify(ctx.evidence)}

CONTINUUM EVENTS (cite these ids when a development is material; ${ctx.events.length} event(s)):
${JSON.stringify(ctx.events)}

Produce the assurance review as a single JSON object. Every evidenceIds array must contain only ids from the lists above (possibly empty for items that genuinely need none, such as unknowns, missingEvidence and risks).`;
}

export interface RunDecisionAssuranceResult {
  record: HunyuanAssuranceRecord;
  /** Evidence/event ids the model cited and the enforcer accepted. */
  citationsAccepted: number;
  citationsRejected: number;
  correctiveRetry: boolean;
}

/**
 * Run the full decision-assurance workflow for one record and persist the
 * review on it. Throws typed errors for: missing record (404), no evidence
 * (400), missing credentials (HunyuanCredentialsError), provider failures.
 */
export async function runDecisionAssurance(scope: TrackedScope, id: string): Promise<RunDecisionAssuranceResult> {
  const ctx = await buildDecisionContext(scope, id);
  if (ctx.evidence.length === 0) {
    throw new DecisionAssuranceError(
      "this record has no recorded evidence to assure — run its investigation first; Hunyuan review is never produced from nothing",
      400,
    );
  }
  if (missingHunyuanCredentials().length > 0) {
    throw new HunyuanCredentialsError(missingHunyuanCredentials());
  }

  const { data, chat, correctiveRetry } = await hunyuanStructured<DecisionAssuranceReview>(
    { system: SYSTEM_PROMPT, user: userPrompt(ctx), temperature: 0.2, maxTokens: 4096 },
    decisionAssuranceReviewSchema,
  );

  // Local traceability enforcement (never trusted to the model).
  const allowedIds = new Set<string>([...ctx.evidence.map((e) => e.id), ...ctx.events.map((e) => e.id)]);
  const violations = citationViolations(data, allowedIds);
  const rejectedClaims: Array<{ location: string; reason: string }> = [];
  let citationsRejected = 0;
  const review = data as DecisionAssuranceReview;
  for (const violation of violations) {
    citationsRejected += violation.ids.length;
    const section = violation.location.split("[")[0];
    const index = Number(violation.location.match(/\[(\d+)\]/)?.[1] ?? -1);
    const entries = (review as unknown as Record<string, Array<{ evidenceIds?: string[] }>>)[section];
    const entry = entries?.[index];
    if (entry) {
      const kept = (entry.evidenceIds ?? []).filter((v) => allowedIds.has(v));
      entry.evidenceIds = kept;
      if (kept.length === 0) {
        rejectedClaims.push({ location: violation.location, reason: `cited only unresolvable id(s): ${violation.ids.join(", ")}` });
        entries.splice(index, 1);
      } else {
        rejectedClaims.push({ location: violation.location, reason: `removed unresolvable citation(s): ${violation.ids.join(", ")}` });
      }
    }
  }
  if (violations.length > 0) {
    review.limitations = [
      ...(review.limitations ?? []),
      `${citationsRejected} model citation(s) could not be resolved against this record's evidence or continuum events and were removed before storage; the affected claims are listed in rejectedClaims.`,
    ];
  }

  const record: HunyuanAssuranceRecord = {
    provider: "tencent-hunyuan",
    scope,
    runAt: new Date().toISOString(),
    model: chat.model,
    rejectedClaims,
    usage: chat.usage,
    durationMs: chat.durationMs,
    review,
  };

  // Persist ON the analysed record + audit trail (the existing stores).
  if (scope === "assurance") {
    const inv = await getInvestigation(id);
    if (!inv) throw new DecisionAssuranceError(`assurance investigation ${id} disappeared during review`, 500);
    inv.hunyuanAssurance = record;
    audit(inv, "hunyuan", "decision_assurance", `Hunyuan review recorded (${chat.model}, ${record.review.materialFindings.length} finding(s), confidence ${record.review.confidence.level}, ${citationsRejected} citation(s) rejected).`);
    await saveInvestigation(inv);
  } else {
    const inv = await getDeskInvestigation(id);
    if (!inv) throw new DecisionAssuranceError(`desk investigation ${id} disappeared during review`, 500);
    inv.hunyuanAssurance = record;
    auditDesk(inv, "hunyuan", "decision_assurance", `Hunyuan review recorded (${chat.model}, ${record.review.materialFindings.length} finding(s), confidence ${record.review.confidence.level}, ${citationsRejected} citation(s) rejected).`);
    await saveDeskInvestigation(inv);
  }

  return {
    record,
    citationsAccepted: allowedIds.size > 0 ? countCitations(review) : 0,
    citationsRejected,
    correctiveRetry,
  };
}

function countCitations(review: DecisionAssuranceReview): number {
  const sections = [review.materialFindings, review.establishedFacts, review.inferences, review.conflicts, review.conclusions];
  return sections.reduce((sum, arr) => sum + (arr ?? []).reduce((n, e) => n + ((e as { evidenceIds?: string[] }).evidenceIds?.length ?? 0), 0), 0);
}

/** The persisted review, when the record already carries one. */
export async function getDecisionAssurance(scope: TrackedScope, id: string): Promise<HunyuanAssuranceRecord | null> {
  if (scope === "assurance") {
    const inv = await getInvestigation(id);
    return inv?.hunyuanAssurance ?? null;
  }
  const inv = await getDeskInvestigation(id);
  return inv?.hunyuanAssurance ?? null;
}
