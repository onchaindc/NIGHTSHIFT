/**
 * Mission #02 — Continuous Enterprise Intelligence (Tencent Hunyuan).
 *
 * Recurring monitoring over the entities NIGHTSHIFT already investigates. The
 * reliability model follows the Protocol Watch scheduler honestly:
 *
 *  - Detection is DETERMINISTIC code over the persisted records: new evidence,
 *    material field changes, cross-source contradictions, stale evidence and
 *    decision/report changes. Hunyuan never decides what happened — it is
 *    asked, per entity, to ASSESS what the code already detected (summary,
 *    materiality, recommended action). Its assessment is stored beside the
 *    event, never in place of it.
 *  - Deduplication happens BEFORE the provider is involved: every event
 *    carries a content fingerprint, and a repeated tick re-diffs against the
 *    persisted fingerprints, so unchanged records never re-report.
 *  - First sight of an entity is a BASELINE, not news: no events until the
 *    record changes again.
 *  - Recurring execution uses the EXISTING scheduler: the daily Vercel cron
 *    tick (/api/watches/scheduler-tick) runs one pass, guarded by the same
 *    ttl-lease duplicate-worker pattern. When the process stops, monitoring
 *    stops — runs and state are persisted and /api/hunyuan/status reports the
 *    truth instead of claiming continuous coverage.
 *  - Provider failures never lose events: deterministic events persist with
 *    providerAssessment null and the failure is recorded in the run log.
 */

import { createHash, randomUUID } from "node:crypto";

import { persistence } from "@/lib/storage";
import { listInvestigations, getInvestigation, audit, saveInvestigation } from "@/lib/assurance/store";
import { listDeskInvestigations, getDeskInvestigation, auditDesk, saveDeskInvestigation } from "@/lib/desk/store";
import type { Investigation } from "@/lib/assurance/types";
import type { DeskInvestigation } from "@/lib/desk/types";
import { continuumAssessmentSchema } from "./schema";
import { hunyuanStructured, hunyuanConfig, HunyuanError } from "./client";
import { entityKeyForAssurance, entityKeyForDesk, entityLabel } from "./entities";
import type { ContinuumEvent, ContinuumRunRecord } from "./types";

const LEDGER_DOC = "hunyuan-continuum-events";
const STATE_DOC = "hunyuan-continuum-state";
const RUNS_DOC = "hunyuan-continuum-runs";
const MAX_LEDGER_EVENTS = 500;
const MAX_RUNS = 20;
const MAX_FINGERPRINTS_PER_ENTITY = 1000;
const MAX_PROCESSED_EVIDENCE = 200;
const MAX_AUDIT_WRITES_PER_TICK = 10;

export function autoContinuumEnabled(): boolean {
  return process.env.NIGHTSHIFT_CONTINUUM_AUTOCHECK !== "0";
}

function staleMs(): number {
  const raw = Number(process.env.NIGHTSHIFT_CONTINUUM_STALE_MS);
  return Number.isFinite(raw) && raw >= 24 * 60 * 60 * 1000 ? raw : 30 * 24 * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ */
/* Entity views — the deterministic input to detection                 */
/* ------------------------------------------------------------------ */

export type Scalar = string | number | boolean | null;

export interface EntityEvidenceView {
  id: string;
  capability: string;
  title: string;
  facts: Record<string, Scalar>;
  provenance: string;
  /** Only strong-provenance records participate in contradictions. */
  strong: boolean;
  observedAt: string | null;
}

export interface EntityView {
  key: string;
  label: string;
  scope: "assurance" | "desk";
  investigationId: string;
  reference: string;
  /** Recorded decision outcome (assurance) or null (desk). */
  decision: string | null;
  /** Desk verdict|confidence signature; null for assurance files. */
  reportSignature: string | null;
  evidence: EntityEvidenceView[];
}

function strongEvidence(scope: EntityView["scope"], record: Record<string, unknown>): boolean {
  if (scope === "assurance") {
    return record.class === "source_verified" || record.class === "node_verified";
  }
  return record.provenance === "verified" || record.class === "source_verified" || record.class === "node_verified";
}

function evidenceViews(inv: Investigation | DeskInvestigation, scope: EntityView["scope"]): EntityEvidenceView[] {
  return ((inv.evidence ?? []) as unknown as Array<Record<string, unknown>>)
    .filter((e) => e && typeof e.id === "string")
    .map((e) => ({
      id: String(e.id),
      capability: String(e.capability ?? "unknown"),
      title: String(e.title ?? e.label ?? ""),
      facts: (e.facts ?? {}) as Record<string, Scalar>,
      provenance: String(e.provenance ?? e.class ?? "unknown"),
      strong: strongEvidence(scope, e),
      observedAt: (e.source as { observedAt?: string } | undefined)?.observedAt ?? null,
    }));
}

/** Every tracked entity across both record stores, in stable order. */
export function collectEntityViews(assurances: Investigation[], desks: DeskInvestigation[]): EntityView[] {
  const views: EntityView[] = [];
  for (const inv of assurances) {
    const key = entityKeyForAssurance(inv);
    if (!key) continue;
    views.push({
      key,
      label: entityLabel(inv, "assurance"),
      scope: "assurance",
      investigationId: inv.id,
      reference: inv.reference ?? "",
      decision: inv.decision?.outcome ?? null,
      reportSignature: null,
      evidence: evidenceViews(inv, "assurance"),
    });
  }
  for (const inv of desks) {
    const key = entityKeyForDesk(inv);
    if (!key) continue;
    const report = inv.report;
    // Runtime data can hold a desk report whose assessment has not been
    // produced yet (e.g. a file parked at awaiting_approval): the type
    // promises assessment, but the store must not be trusted with an
    // unguarded read. No assessment + confidence yet -> no signature yet.
    const reportSignature =
      report && report.assessment && report.assessment.verdict !== undefined && report.confidence !== undefined
        ? `${report.assessment.verdict}|${report.confidence}`
        : null;
    views.push({
      key,
      label: entityLabel(inv, "desk"),
      scope: "desk",
      investigationId: inv.id,
      reference: inv.reference ?? "",
      decision: null,
      reportSignature,
      evidence: evidenceViews(inv, "desk"),
    });
  }
  return views;
}

/* ------------------------------------------------------------------ */
/* Deterministic detection                                             */
/* ------------------------------------------------------------------ */

export interface ChangeCandidate {
  kind: ContinuumEvent["kind"];
  title: string;
  detail: string;
  evidenceIds: string[];
  payload: Record<string, unknown>;
  materiality: "material" | "minor";
}

interface ProcessedEvidenceSummary {
  id: string;
  capability: string;
  facts: Record<string, Scalar>;
  strong: boolean;
  observedAt: string | null;
}

export interface EntityTrackState {
  evidenceSetHash: string;
  processedEvidence: ProcessedEvidenceSummary[];
  fingerprints: Record<string, string>;
  lastDecision: string | null;
  lastReportSignature: string | null;
}

export interface ContinuumState {
  entities: Record<string, EntityTrackState>;
  lastTickAt: string | null;
  lastError: string | null;
}

function emptyTrackState(): EntityTrackState {
  return { evidenceSetHash: "", processedEvidence: [], fingerprints: {}, lastDecision: null, lastReportSignature: null };
}

function isLaterEvidence(a: EntityEvidenceView, b: ProcessedEvidenceSummary): boolean {
  // Records are appended chronologically; a missing observedAt counts as newer.
  if (!a.observedAt || !b.observedAt) return true;
  const at = Date.parse(a.observedAt);
  const bt = Date.parse(b.observedAt);
  return Number.isFinite(at) && Number.isFinite(bt) ? at >= bt : true;
}

function factChanged(a: Scalar, b: Scalar): boolean {
  return a !== b;
}

/**
 * Pure detection for one entity against its persisted prior state.
 * First sight (no prior) is a baseline: zero candidates.
 */
export function detectChanges(view: EntityView, prior: EntityTrackState | undefined, nowMs: number, staleWindowMs: number): { baseline: boolean; candidates: ChangeCandidate[] } {
  if (!prior) return { baseline: true, candidates: [] };
  const candidates: ChangeCandidate[] = [];
  const processedIds = new Set(prior.processedEvidence.map((p) => p.id));
  const newEvidence = view.evidence.filter((e) => !processedIds.has(e.id));

  for (const e of newEvidence) {
    const material = !e.strong && e.provenance === "verification_failed";
    candidates.push({
      kind: "new_evidence",
      title: material ? `Verification failed on new ${e.capability} evidence` : `New ${e.capability} evidence recorded`,
      detail: material
        ? `A ${e.capability} record (${e.id}) FAILED independent verification and was retained for investigation. Provenance: ${e.provenance}.`
        : `${e.capability} evidence ${e.id} recorded${e.observedAt ? ` at ${e.observedAt}` : ""}: ${e.title || "(untitled)"}`,
      evidenceIds: [e.id],
      payload: { evidenceId: e.id, capability: e.capability, provenance: e.provenance, facts: e.facts },
      materiality: material ? "material" : "minor",
    });

    // Material field changes vs previously processed evidence of the same capability.
    for (const priorEvidence of prior.processedEvidence) {
      if (priorEvidence.capability !== e.capability || !isLaterEvidence(e, priorEvidence)) continue;
      for (const [field, value] of Object.entries(e.facts)) {
        const oldValue = priorEvidence.facts[field];
        if (oldValue === undefined) continue;
        if (!factChanged(value, oldValue)) continue;
        const bothStrong = e.strong && priorEvidence.strong;
        candidates.push({
          kind: "field_change",
          title: `${e.capability}.${field} changed`,
          detail: `${field} moved from ${JSON.stringify(oldValue)} to ${JSON.stringify(value)} (${priorEvidence.id} → ${e.id}).`,
          evidenceIds: [priorEvidence.id, e.id],
          payload: { capability: e.capability, field, from: oldValue, to: value, fromEvidenceId: priorEvidence.id, toEvidenceId: e.id },
          materiality: bothStrong ? "material" : "minor",
        });
        // Cross-source contradiction: two strong records of the same capability disagree.
        if (bothStrong) {
          candidates.push({
            kind: "contradiction",
            title: `Contradiction on ${e.capability}.${field}`,
            detail: `Two strong-provenance records disagree on ${field}: ${JSON.stringify(oldValue)} (${priorEvidence.id}) vs ${JSON.stringify(value)} (${e.id}). Unresolved — never silently reconciled.`,
            evidenceIds: [priorEvidence.id, e.id],
            payload: { capability: e.capability, field, left: oldValue, right: value, leftEvidenceId: priorEvidence.id, rightEvidenceId: e.id },
            materiality: "material",
          });
        }
      }
    }
  }

  // Stale evidence: strong records nobody renewed inside the window.
  const staleCutoff = nowMs - staleWindowMs;
  for (const e of view.evidence) {
    if (!e.strong || !e.observedAt) continue;
    const observed = Date.parse(e.observedAt);
    if (!Number.isFinite(observed) || observed >= staleCutoff) continue;
    candidates.push({
      kind: "stale_evidence",
      title: `Stale ${e.capability} evidence`,
      detail: `${e.capability} record ${e.id} was observed ${e.observedAt} and has not been renewed; it can no longer speak for the present.`,
      evidenceIds: [e.id],
      payload: { evidenceId: e.id, capability: e.capability, observedAt: e.observedAt, staleWindowMs },
      materiality: "minor",
    });
  }

  // Decision / report changes.
  if (view.scope === "assurance" && view.decision !== prior.lastDecision) {
    candidates.push({
      kind: "decision_change",
      title: `Decision changed to ${view.decision ?? "(cleared)"}`,
      detail: `The assurance decision moved from ${prior.lastDecision ?? "(none)"} to ${view.decision ?? "(none)"}.`,
      evidenceIds: [],
      payload: { from: prior.lastDecision, to: view.decision },
      materiality: "material",
    });
  }
  if (view.scope === "desk" && view.reportSignature !== prior.lastReportSignature) {
    candidates.push({
      kind: "desk_report_change",
      title: "Desk report verdict or confidence changed",
      detail: `The desk assessment moved from ${prior.lastReportSignature ?? "(none)"} to ${view.reportSignature ?? "(none)"}.`,
      evidenceIds: [],
      payload: { from: prior.lastReportSignature, to: view.reportSignature },
      materiality: "material",
    });
  }

  return { baseline: false, candidates };
}

/** Canonical JSON (sorted keys) so the fingerprint is stable across runs. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function fingerprintFor(entityKey: string, candidate: ChangeCandidate): string {
  return createHash("sha256").update(JSON.stringify([entityKey, candidate.kind, canonical(candidate.payload)])).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

async function readLedger(): Promise<ContinuumEvent[]> {
  const stored = await persistence().readNamed<ContinuumEvent[]>(LEDGER_DOC);
  return Array.isArray(stored) ? stored.filter((e) => e && typeof e.id === "string") : [];
}

/** Newest-first events across every tracked entity. */
export async function readContinuumEvents(limit = 100): Promise<ContinuumEvent[]> {
  return (await readLedger()).slice(0, limit);
}

/** Newest-first events for one tracked entity (used by mission #01). */
export async function readEntityEvents(entityKey: string, limit = 12): Promise<ContinuumEvent[]> {
  return (await readLedger()).filter((e) => e.entityKey === entityKey).slice(0, limit);
}

export async function readContinuumRuns(limit = 10): Promise<ContinuumRunRecord[]> {
  const stored = await persistence().readNamed<ContinuumRunRecord[]>(RUNS_DOC);
  return Array.isArray(stored) ? stored.slice(0, limit) : [];
}

async function readState(): Promise<ContinuumState> {
  const stored = await persistence().readNamed<ContinuumState>(STATE_DOC);
  return stored && typeof stored === "object" && stored.entities && typeof stored.entities === "object"
    ? { entities: stored.entities, lastTickAt: stored.lastTickAt ?? null, lastError: stored.lastError ?? null }
    : { entities: {}, lastTickAt: null, lastError: null };
}

/* ------------------------------------------------------------------ */
/* The tick                                                            */
/* ------------------------------------------------------------------ */

const ASSESS_SYSTEM = `You are the assessment layer of NIGHTSHIFT's continuous enterprise-intelligence monitor. The monitor's detector (deterministic code) has already established THAT something changed; you assess WHAT IT MEANS for the tracked entity.

For each listed event return: summary (what changed and why it matters for this entity, grounded in the event's own detail — do not invent facts), materiality ("material" or "minor"), recommendedAction (a concrete next verification step).

Never invent events, evidence ids or developments beyond the list. Reply with ONLY a JSON object: {"assessments": [{"eventId": "...", "summary": "...", "materiality": "material"|"minor", "recommendedAction": "..."}]}.`;

function assessmentUserPrompt(entity: EntityView, events: ContinuumEvent[]): string {
  return `ENTITY: ${entity.label} (${entity.scope} file ${entity.reference})
DETECTED EVENTS:
${JSON.stringify(
  events.map((e) => ({
    eventId: e.id,
    kind: e.kind,
    title: e.title,
    detail: e.detail,
    deterministicMateriality: e.materiality,
    evidenceIds: e.evidenceIds,
  })),
)}`;
}

export interface ContinuumTickOptions {
  now?: number;
  trigger?: "scheduler" | "manual";
}

export interface ContinuumTickResult extends ContinuumRunRecord {
  skipped: boolean;
}

/**
 * One analysis pass over every tracked entity. Lease-guarded; safe to call
 * from the cron heartbeat and from the manual route concurrently.
 */
export async function runContinuumTick(options: ContinuumTickOptions = {}): Promise<ContinuumTickResult> {
  const nowMs = options.now ?? Date.now();
  const trigger = options.trigger ?? "manual";
  const base: ContinuumRunRecord = {
    at: new Date(nowMs).toISOString(),
    trigger,
    scannedEntities: 0,
    baselinesEstablished: 0,
    newEvents: 0,
    enriched: 0,
    providerConfigured: Boolean(hunyuanConfig()),
    providerError: null,
    skippedByOtherWorker: false,
    error: null,
  };

  const release = await persistence().acquireLease("hunyuan-continuum-tick", 10 * 60_000);
  if (!release) {
    return { ...base, skippedByOtherWorker: true, skipped: true };
  }

  try {
    const [assurances, desks, ledger] = await Promise.all([listInvestigations(), listDeskInvestigations(), readLedger()]);
    const views = collectEntityViews(assurances, desks);
    base.scannedEntities = views.length;

    const existingFingerprints = new Set<string>(ledger.map((e) => e.fingerprint));
    const accepted: ContinuumEvent[] = [];
    const seenThisTick = new Set<string>();
    const state = await readState();

    for (const view of views) {
      const prior = state.entities[view.key];
      const { baseline, candidates } = detectChanges(view, prior, nowMs, staleMs());
      if (baseline) {
        state.entities[view.key] = { ...emptyTrackState(), ...(prior ?? {}), evidenceSetHash: hashEvidenceSet(view) };
        state.entities[view.key].processedEvidence = summarizeEvidence(view);
        state.entities[view.key].lastDecision = view.decision;
        state.entities[view.key].lastReportSignature = view.reportSignature;
        base.baselinesEstablished++;
        continue;
      }
      const track = state.entities[view.key] ?? emptyTrackState();
      for (const candidate of candidates) {
        const fingerprint = fingerprintFor(view.key, candidate);
        if (existingFingerprints.has(fingerprint) || seenThisTick.has(fingerprint) || track.fingerprints[fingerprint]) continue;
        seenThisTick.add(fingerprint);
        track.fingerprints[fingerprint] = new Date(nowMs).toISOString();
        accepted.push({
          id: `evt-${randomUUID().slice(0, 8)}`,
          ts: new Date(nowMs).toISOString(),
          entityKey: view.key,
          entityLabel: view.label,
          kind: candidate.kind,
          title: candidate.title,
          detail: candidate.detail,
          materiality: candidate.materiality,
          providerAssessment: null,
          investigationIds: [{ scope: view.scope, id: view.investigationId, reference: view.reference }],
          evidenceIds: candidate.evidenceIds,
          fingerprint,
          limitations: [],
        });
      }
      track.evidenceSetHash = hashEvidenceSet(view);
      track.processedEvidence = summarizeEvidence(view);
      track.lastDecision = view.decision;
      track.lastReportSignature = view.reportSignature;
      state.entities[view.key] = track;
    }

    // Provider assessment per entity with events (never decision-making, only assessment).
    if (accepted.length > 0 && base.providerConfigured) {
      const byEntity = new Map<string, ContinuumEvent[]>();
      for (const event of accepted) {
        byEntity.set(event.entityKey, [...(byEntity.get(event.entityKey) ?? []), event]);
      }
      for (const [entityKey, events] of byEntity) {
        const view = views.find((v) => v.key === entityKey)!;
        try {
          const { data, chat } = await hunyuanStructured(
            { system: ASSESS_SYSTEM, user: assessmentUserPrompt(view, events.slice(0, 12)), temperature: 0.2, maxTokens: 2048 },
            continuumAssessmentSchema,
          );
          for (const event of events) {
            const assessment = data.assessments.find((a) => a.eventId === event.id);
            if (!assessment) {
              event.limitations.push("the provider assessment omitted this event; the deterministic detection stands alone");
              continue;
            }
            event.providerAssessment = {
              summary: assessment.summary,
              materiality: assessment.materiality,
              recommendedAction: assessment.recommendedAction,
              model: chat.model,
              usage: chat.usage,
            };
            event.materiality = assessment.materiality;
            base.enriched++;
          }
        } catch (err) {
          const detail = err instanceof HunyuanError ? `${err.name}: ${err.message}` : err instanceof Error ? err.message : String(err);
          base.providerError = detail;
          for (const event of events) event.limitations.push(`provider assessment unavailable (${detail}); the deterministic detection stands alone`);
        }
      }
    } else if (accepted.length > 0 && !base.providerConfigured) {
      for (const event of accepted) {
        event.limitations.push("Tencent Hunyuan is not configured (HUNYUAN_API_KEY); the deterministic detection stands without a provider assessment");
      }
    }

    // Persist the ledger (newest first, bounded) and the state.
    const ledgerNext = [...accepted, ...ledger].slice(0, MAX_LEDGER_EVENTS);
    await persistence().writeNamed(LEDGER_DOC, ledgerNext);
    for (const track of Object.values(state.entities)) {
      const entries = Object.entries(track.fingerprints);
      if (entries.length > MAX_FINGERPRINTS_PER_ENTITY) {
        track.fingerprints = Object.fromEntries(entries.sort(([, a], [, b]) => b.localeCompare(a)).slice(0, MAX_FINGERPRINTS_PER_ENTITY));
      }
    }
    state.lastTickAt = new Date(nowMs).toISOString();
    state.lastError = base.providerError;
    await persistence().writeNamed(STATE_DOC, state);

    // Link material developments back into the affected investigations.
    let auditWrites = 0;
    for (const event of accepted) {
      if (event.materiality !== "material" || auditWrites >= MAX_AUDIT_WRITES_PER_TICK) continue;
      for (const link of event.investigationIds) {
        if (auditWrites >= MAX_AUDIT_WRITES_PER_TICK) break;
        try {
          if (link.scope === "assurance") {
            const inv = await getInvestigation(link.id);
            if (inv) {
              audit(inv, "hunyuan", "continuum_event", `Material development: ${event.title} (${event.id}).`);
              await saveInvestigation(inv);
              auditWrites++;
            }
          } else {
            const inv = await getDeskInvestigation(link.id);
            if (inv) {
              auditDesk(inv, "hunyuan", "continuum_event", `Material development: ${event.title} (${event.id}).`);
              await saveDeskInvestigation(inv);
              auditWrites++;
            }
          }
        } catch {
          // A failed linkage write must never lose the event itself.
        }
      }
    }

    base.newEvents = accepted.length;
    const run: ContinuumRunRecord = { ...base };
    await persistence().writeNamed(RUNS_DOC, [run, ...(await readContinuumRuns(MAX_RUNS - 1))]);
    return { ...run, skipped: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    base.error = detail;
    try {
      const run: ContinuumRunRecord = { ...base };
      await persistence().writeNamed(RUNS_DOC, [run, ...(await readContinuumRuns(MAX_RUNS - 1))]);
      const state = await readState();
      state.lastError = detail;
      await persistence().writeNamed(STATE_DOC, state);
    } catch {
      // persistence itself is down; the throw below still surfaces the failure
    }
    throw err;
  } finally {
    await release();
  }
}

function hashEvidenceSet(view: EntityView): string {
  return createHash("sha256").update(JSON.stringify(view.evidence.map((e) => e.id).sort())).digest("hex");
}

function summarizeEvidence(view: EntityView): ProcessedEvidenceSummary[] {
  return view.evidence
    .slice(0, MAX_PROCESSED_EVIDENCE)
    .map((e) => ({ id: e.id, capability: e.capability, facts: e.facts, strong: e.strong, observedAt: e.observedAt }));
}
