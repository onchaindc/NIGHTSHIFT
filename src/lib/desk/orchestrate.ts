/**
 * Deal Desk investigation orchestration.
 *
 * The shared layer all three specialised workflows run through:
 *
 *   plan     — interpret the guided-form subject into a capability plan:
 *              which verified matrix dimensions to ask, with which params,
 *              and which requirements cannot be asked (declared gaps, or
 *              required inputs the caller never supplied)
 *   execute  — an ordinary engine task (`jobType: "capability_run"`), so the
 *              run inherits the approval gate, the spend ledger, the per-ask
 *              drift check and the node-signal verification
 *   absorb   — translate completed runs into the evidence ledger with
 *              explicit provenance (verified / unverified / missing)
 *   report   — findings, discrepancies, sections, confidence limitations and
 *              outstanding questions, built from recorded evidence only
 *
 * Nothing here invents a capability, a source, a verification result or a
 * completed investigation. Analysis is labelled as analysis and cites the
 * evidence it used.
 */

import { createTask, defaultDeps, EngineError } from "@/lib/engine/engine";
import { getTask, saveTask } from "@/lib/engine/store";
import type { PlanStep, TaskRecord, VerificationCriteria } from "@/lib/engine/types";
import { capabilityKey, DESK_WORKFLOWS, resolveDeskCapability } from "./workflows";
import { auditDesk, saveDeskInvestigation } from "./store";
import { declaredInputEvidence, deskSubjectLine } from "./create";
import type { DeskRunConfig } from "./execute";
import type {
  DeskConfidence,
  DeskDiscrepancy,
  DeskEvidence,
  DeskFinding,
  DeskInvestigation,
  DeskReport,
  DeskReportSection,
  DeskSeverity,
  DeskUnsupportedRequirement,
  ProvenanceClass,
} from "./types";
import { DESK_TYPE_LABEL } from "./types";

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

export interface PlannedCapability {
  key: string;
  params: Record<string, unknown>;
}

export interface PlannedInputGap {
  key: string;
  label: string;
  required: string[];
}

export interface DeskPlan {
  capabilities: PlannedCapability[];
  inputGaps: PlannedInputGap[];
  unsupported: DeskUnsupportedRequirement[];
  declared: DeskEvidence[];
}

/**
 * Interpret the subject into the capability plan. A capability whose required
 * inputs were not supplied is a NAMED input gap, never a silent skip and
 * never an approximate ask.
 */
export function planDeskCapabilities(inv: DeskInvestigation): DeskPlan {
  const workflow = DESK_WORKFLOWS[inv.type];
  const capabilities: PlannedCapability[] = [];
  const inputGaps: PlannedInputGap[] = [];

  for (const ref of workflow.capabilities) {
    if (ref.when && !ref.when(inv.subject)) continue;
    const dim = resolveDeskCapability(ref);
    const key = capabilityKey(ref);
    if (dim.status === "gap" || !dim.intent) {
      // The matrix gap list is the declared-unsupported ledger; a capability
      // reference must never point at a gap (workflows.ts asserts this).
      continue;
    }
    const params = ref.params(inv.subject);
    if (!params) {
      inputGaps.push({
        key,
        label: dim.label,
        required: Object.entries(dim.params ?? {})
          .filter(([, spec]) => spec.required)
          .map(([name, spec]) => `${name} (${spec.description})`),
      });
      continue;
    }
    capabilities.push({ key, params });
  }

  return {
    capabilities,
    inputGaps,
    unsupported: inv.unsupported,
    declared: declaredInputEvidence(inv),
  };
}

/* ------------------------------------------------------------------ */
/* Run creation (engine task)                                          */
/* ------------------------------------------------------------------ */

/**
 * Creates the run for this file. A paid run always stops at
 * `awaiting_approval`; approval uses the existing
 * POST /api/tasks/:id/action {action:"approve"} gate. A free run executes
 * immediately and probes only.
 */
export async function createDeskRun(
  inv: DeskInvestigation,
  mode: "free" | "intel",
  opts: { spendLimitUsdCents?: number; actor?: string; owner?: string | null } = {},
): Promise<{ task: TaskRecord; accepted: boolean }> {
  const plan = planDeskCapabilities(inv);
  if (plan.capabilities.length === 0) {
    throw new EngineError(
      "this file has no capability with complete inputs, so no run was planned — supply the missing form answers first",
    );
  }

  const config: DeskRunConfig = {
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
  const paid = mode === "intel";

  const criteria: VerificationCriteria = {
    primaryVerifiedAgainstNodeSignal: paid,
    answerSane: paid,
    answerMaxAgeSeconds: 3600,
    ownPaymentSettledOnChain: false,
    reconcileLedgerEntries: paid,
    goalIntent: "information",
    primarySource: paid ? "telegraph" : "free",
  };

  const steps: PlanStep[] = [
    {
      id: "desk-baseline",
      kind: "desk_baseline",
      description: `Unpaid pre-flight for ${inv.reference}: probe ${config.capabilities.length} planned dimension(s) with their canonical schema and record the live price; nothing is signed`,
      target,
    },
  ];
  if (paid) {
    steps.push({
      id: "desk-intel",
      kind: "desk_intel",
      description: `PAID intelligence for ${inv.reference}: one attempt per planned dimension, each drift-checked against its approved offer and guarded by the plan's ceiling`,
      target,
      maxCostUsdCents: opts.spendLimitUsdCents ?? inv.spendLimitUsdCents,
    });
  }
  steps.push({
    id: "desk-report",
    kind: "desk_report",
    description: "Per-dimension status ledger from the recorded signals and receipts; refused or unverified answers never become findings",
    target,
  });

  const task = await createTask({
    goal: `${DESK_TYPE_LABEL[inv.type]} ${paid ? "intelligence" : "pre-flight"} · ${inv.reference} · ${deskSubjectLine(inv)}`,
    spendLimitUsdCents: opts.spendLimitUsdCents ?? inv.spendLimitUsdCents,
    requiresApproval: paid,
    origin: { source: "web" },
    jobType: "capability_run",
    plan: steps,
    criteria,
    // Ownership follows the file, so the requesting wallet can approve its own
    // run — the same model as Minds and settlement files.
    ...(opts.owner ? { owner: opts.owner.toLowerCase() } : {}),
    assumptions: [
      ...DESK_WORKFLOWS[inv.type].honestyNotes,
      "paid asks are one attempt each, pinned to their provider and refused if the live offer drifts from the approved one",
      paid
        ? "nothing is signed until a human approves this exact plan"
        : "free mode plans no purchase and spends nothing",
    ],
  });

  task.labels = [...(task.labels ?? []), `desk:${inv.id}`, `desk-type:${inv.type}`, `desk-mode:${mode}`];
  await saveTask(task);

  if (task.state === "executing") {
    void runTaskQuietly(task.id);
  }

  inv.runs.push({
    taskId: task.id,
    mode,
    createdAt: new Date().toISOString(),
    taskState: task.state,
    ceilingUsdCents: task.spend.limitUsdCents,
    absorbed: false,
  });
  auditDesk(inv, opts.actor ?? "operator", "desk_run_created", `${mode} run ${task.id} at ${task.state} · ${plan.capabilities.length} planned capability(ies), ${plan.inputGaps.length} input gap(s).`);
  if (inv.status === "draft") inv.status = "collecting";
  await saveDeskInvestigation(inv);

  return { task, accepted: task.state === "executing" };
}

async function runTaskQuietly(taskId: string): Promise<void> {
  const { runTask } = await import("@/lib/engine/engine");
  runTask(taskId, defaultDeps()).catch((err) =>
    console.error("desk free run failed:", err instanceof Error ? err.message : err),
  );
}

/* ------------------------------------------------------------------ */
/* Evidence absorption                                                 */
/* ------------------------------------------------------------------ */

function factsFromValues(values: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).slice(0, 8).join("; ");
    else out[k] = JSON.stringify(v).slice(0, 400);
  }
  return out;
}

function gapEvidence(inv: DeskInvestigation): DeskEvidence[] {
  const observedAt = inv.createdAt;
  return inv.unsupported.map((gap) => ({
    id: `gap:${gap.capabilityKey}`,
    provenance: "missing" as const,
    class: "missing" as const,
    capability: gap.capabilityKey,
    label: gap.label,
    title: `${gap.label} · unsupported on the network`,
    detail: `${gap.reason} Resolution: ${gap.resolution}`,
    facts: {},
    source: { kind: "none" as const, ref: gap.capabilityKey, label: "named network gap", observedAt },
  }));
}

function inputGapEvidence(inv: DeskInvestigation, gaps: Array<{ key: string; label: string; required: string[] }>, taskId?: string): DeskEvidence[] {
  const observedAt = new Date().toISOString();
  return gaps.map((gap) => ({
    id: `input-gap:${gap.key}`,
    provenance: "missing" as const,
    class: "missing" as const,
    capability: gap.key,
    label: gap.label,
    title: `${gap.label} · not asked (inputs missing)`,
    detail: `This capability was planned for the workflow but the required inputs were not supplied: ${gap.required.join("; ")}. Nothing was approximated or guessed.`,
    facts: {},
    source: { kind: "none" as const, ref: gap.key, label: "missing inputs", observedAt },
    ...(taskId ? { taskId } : {}),
  }));
}

/**
 * Pull completed runs into the evidence ledger. Idempotent per run: a run is
 * absorbed once, and an answer is provenance-verified only when its
 * committed payload re-derived against the node signal (or was recorded by
 * the node with a retained signal).
 */
export async function syncDeskInvestigation(inv: DeskInvestigation): Promise<{ added: number; notes: string[] }> {
  const notes: string[] = [];
  let added = 0;

  const plan = planDeskCapabilities(inv);
  if (inv.evidence.length === 0) {
    // Seed the ledger: declared inputs and named missing evidence, so a file
    // that never ran still tells the truth about what it holds.
    inv.evidence.push(...plan.declared, ...gapEvidence(inv), ...inputGapEvidence(inv, plan.inputGaps));
    added += plan.declared.length + inv.unsupported.length + plan.inputGaps.length;
    notes.push(`Seeded ${plan.declared.length} declared input(s), ${inv.unsupported.length} unsupported requirement(s), ${plan.inputGaps.length} input gap(s).`);
  }

  for (const run of inv.runs) {
    const task = await getTask(run.taskId);
    if (!task) {
      notes.push(`Run ${run.taskId} is no longer in the task store; its evidence cannot be recovered.`);
      continue;
    }
    run.taskState = task.state;
    if (run.absorbed) continue;
    if (task.state === "failed" || task.state === "blocked" || task.state === "rejected") {
      notes.push(`Run ${run.taskId} ended ${task.state}; no intelligence was absorbed from it.`);
      continue;
    }
    const report = task.result?.capabilityReport;
    if (!report) continue;

    for (const dim of report.dimensions) {
      const key = dim.dimension;
      const exists = inv.evidence.some((e) => e.capability === key && e.id.startsWith(run.taskId));
      if (exists) continue;
      if (dim.status === "gap") {
        // Declared gaps were seeded already; a run-time gap that was not
        // declared means the plan itself drifted — record it honestly.
        if (!inv.evidence.some((e) => e.capability === key && e.provenance === "missing")) {
          inv.evidence.push({
            id: `${run.taskId}:${key}:gap`,
            provenance: "missing",
            class: "missing",
            capability: key,
            label: dim.label,
            title: `${dim.label} · unsupported`,
            detail: dim.detail,
            facts: {},
            source: { kind: "none", ref: key, label: "named network gap", observedAt: report.preparedAt },
            taskId: run.taskId,
          });
          added += 1;
        }
        continue;
      }
      if (dim.status === "verified" || dim.status === "recorded") {
        if (!dim.signalHash) {
          notes.push(`${dim.label}: ${dim.status} without a signal hash, so it is not admissible.`);
          continue;
        }
        inv.evidence.push({
          id: `${run.taskId}:${key}`,
          provenance: "verified",
          class: "node_verified",
          capability: key,
          label: dim.label,
          title: dim.label,
          detail: `${dim.detail}${dim.missingFields?.length ? ` Missing fields: ${dim.missingFields.join(", ")}.` : ""}`,
          facts: factsFromValues(dim.values),
          source: {
            kind: "telegraph",
            ref: dim.signalHash,
            label: `${dim.provider ?? "router"} · ${dim.intent ?? "intent"}`,
            observedAt: dim.verifiedAt ?? report.preparedAt,
          },
          taskId: run.taskId,
          signalHash: dim.signalHash,
          receiptHash: dim.receiptHash,
          minerId: dim.provider,
          costUsdCents: dim.priceUsdCents,
          missingFields: dim.missingFields,
          viaRouterFallback: dim.viaRouterFallback,
        });
        added += 1;
        continue;
      }
      if (dim.status === "unverified") {
        inv.evidence.push({
          id: `${run.taskId}:${key}:unverified`,
          provenance: "unverified",
          class: "paid_unverified",
          capability: key,
          label: dim.label,
          title: `${dim.label} · paid answer that could not be verified`,
          detail: dim.detail,
          facts: {},
          source: { kind: "telegraph", ref: dim.intent ?? key, label: `${dim.provider ?? "router"} paid answer`, observedAt: report.preparedAt },
          taskId: run.taskId,
          ...(dim.signalHash ? { signalHash: dim.signalHash } : {}),
          ...(dim.receiptHash ? { receiptHash: dim.receiptHash } : {}),
          costUsdCents: dim.priceUsdCents,
        });
        added += 1;
        continue;
      }
      // routable_unverified: route and price verified by the free probe only.
      inv.evidence.push({
        id: `${run.taskId}:${key}:probe`,
        provenance: "unverified",
        class: "probe_verified",
        capability: key,
        label: dim.label,
        title: `${dim.label} · route verified, no answer purchased`,
        detail: dim.detail,
        facts: { intent: dim.intent ?? "", provider: dim.provider ?? "", priceUsdCents: dim.priceUsdCents ?? 0 },
        source: {
          kind: "telegraph",
          ref: dim.intent ?? "unpaid probe",
          label: `${dim.provider ?? "router"} unpaid probe`,
          observedAt: report.preparedAt,
        },
        taskId: run.taskId,
      });
      added += 1;
    }
    run.absorbed = true;
    notes.push(`Absorbed ${report.counts.verified} verified and ${report.counts.routable_unverified} probe-only dimension(s) from run ${run.taskId}.`);
  }

  return { added, notes };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOTABLE: Array<{
  match: (capability: string, facts: Record<string, string | number | boolean | null>) => DeskSeverity | null;
  title: (facts: Record<string, string | number | boolean | null>) => string;
  significance: string;
}> = [
  {
    match: (capability, facts) =>
      /name_screening|sanctions/.test(capability) && facts.matched === true ? "critical" : null,
    title: (facts) => `Sanctions name match${typeof facts.list_name === "string" ? ` (${facts.list_name})` : ""}`,
    significance: "A sanctions list matched this name at the provider. Treat the file as blocked pending human review; a name screen is probabilistic and is not a legal determination.",
  },
  {
    match: (capability, facts) => (/registry/.test(capability) && facts.active === false ? "material" : null),
    title: () => "Registry record is not active",
    significance: "The official register does not show the entity as active. Resolve the status before any payment or contract relies on this identity.",
  },
  {
    match: (capability, facts) => (/tx_risk/.test(capability) && typeof facts.risk_level === "string"
      ? /high|critical|severe/i.test(facts.risk_level)
        ? "critical"
        : /medium|elevated/i.test(facts.risk_level)
          ? "material"
          : null
      : null),
    title: (facts) => `Transaction risk flagged (${String(facts.risk_level)})`,
    significance: "The risk provider flagged the transaction. A provider risk score is a judgment, not an attribution; review the signals with the cited evidence.",
  },
  {
    match: (capability, facts) => (/invoice_reconcile/.test(capability) && facts.reconciled === false ? "material" : null),
    title: () => "Invoice does not reconcile with the ledger",
    significance: "The provider reports a reconciliation discrepancy. The recorded explanation and evidence sit with the finding.",
  },
  {
    match: (capability, facts) => (/po_verify/.test(capability) && facts.verified === false ? "material" : null),
    title: () => "Purchase order could not be verified",
    significance: "The source system did not confirm the purchase order as asked. Confirm the reference and vendor before relying on it.",
  },
  {
    match: (capability, facts) => (/wash_trading/.test(capability) && typeof facts.verdict === "string" && /wash/i.test(facts.verdict) ? "material" : null),
    title: (facts) => `Wash-trading signals reported (${String(facts.verdict)})`,
    significance: "The provider's heuristic reports wash-trading patterns. It is not proof of intent; read the signals with the evidence.",
  },
];

function significanceFor(capability: string): string {
  return "A verified fact for this investigation, re-derived against the node signal; read it with the cited source.";
}

function buildFindings(inv: DeskInvestigation): DeskFinding[] {
  const findings: DeskFinding[] = [];
  let i = 0;
  for (const e of inv.evidence) {
    if (e.provenance !== "verified") continue;
    const notable = NOTABLE.map((n) => ({ rule: n, severity: n.match(e.capability, e.facts) })).find((r) => r.severity);
    if (notable) {
      findings.push({
        id: `finding:${i++}`,
        severity: notable.severity as DeskSeverity,
        title: notable.rule.title(e.facts),
        detail: e.detail,
        significance: notable.rule.significance,
        evidenceIds: [e.id],
        provenance: "verified",
      });
      continue;
    }
    if (Object.keys(e.facts).length > 0) {
      findings.push({
        id: `finding:${i++}`,
        severity: "info",
        title: `Verified: ${e.label}`,
        detail: e.detail,
        significance: significanceFor(e.capability),
        evidenceIds: [e.id],
        provenance: "verified",
      });
    }
  }
  const order: Record<DeskSeverity, number> = { critical: 0, material: 1, minor: 2, info: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

function buildDiscrepancies(inv: DeskInvestigation): DeskDiscrepancy[] {
  const out: DeskDiscrepancy[] = [];
  let i = 0;
  const subjectName = normalizeName(inv.subject.legalName ?? inv.subject.supplierName ?? inv.subject.assetName ?? "");
  const subjectJurisdiction = (inv.subject.jurisdiction ?? "").trim().toUpperCase();

  for (const e of inv.evidence) {
    if (e.provenance !== "verified") continue;
    const returnedJurisdiction = typeof e.facts.jurisdiction === "string" ? e.facts.jurisdiction.trim().toUpperCase() : "";
    if (subjectJurisdiction && returnedJurisdiction && returnedJurisdiction !== subjectJurisdiction) {
      out.push({
        id: `disc:${i++}`,
        kind: "jurisdiction_refinement",
        title: "Jurisdiction differs from the request",
        detail: `Requested ${subjectJurisdiction}; the registry answer carries ${returnedJurisdiction}. This is commonly a refinement (e.g. US → US-NV) — read it with the evidence, not as an error.`,
        evidenceIds: [e.id],
      });
    }
    const returnedName = typeof e.facts.legal_name === "string" ? normalizeName(e.facts.legal_name) : "";
    if (subjectName && returnedName && returnedName !== subjectName) {
      out.push({
        id: `disc:${i++}`,
        kind: "name_variance",
        title: "Registered name differs from the requested name",
        detail: `Requested "${inv.subject.legalName ?? inv.subject.supplierName ?? ""}"; the registry answers with "${String(e.facts.legal_name)}". Verify you asked about the intended entity.`,
        evidenceIds: [e.id],
      });
    }
    if (e.missingFields?.length) {
      out.push({
        id: `disc:${i++}`,
        kind: "missing_fields",
        title: `${e.label}: promised fields missing from the committed answer`,
        detail: `The dimension expects ${e.missingFields.length} field(s) the answer did not carry: ${e.missingFields.join(", ")}. They are reported missing, never filled.`,
        evidenceIds: [e.id],
      });
    }
    if (e.viaRouterFallback) {
      out.push({
        id: `disc:${i++}`,
        kind: "provider_drift",
        title: `${e.label}: served by the router's fallback`,
        detail: `The pinned provider did not serve this answer; the node's router selected an alternate provider. Attribution is recorded on the evidence.`,
        evidenceIds: [e.id],
      });
    }
  }

  // Cross-source conflicts: registry legal name vs enrichment company name.
  const registry = inv.evidence.find((e) => e.provenance === "verified" && typeof e.facts.legal_name === "string");
  const enrichment = inv.evidence.find(
    (e) => e.provenance === "verified" && /b2b_enrichment|firmographic/.test(e.capability) && typeof e.facts.company === "string",
  );
  if (registry && enrichment && normalizeName(registry.facts.legal_name) !== normalizeName(enrichment.facts.company)) {
    out.push({
      id: `disc:${i++}`,
      kind: "field_conflict",
      title: "Registry name and enrichment name disagree",
      detail: `Registry: "${String(registry.facts.legal_name)}". Enrichment: "${String(enrichment.facts.company)}". Both are verified against their own signals; the conflict is unresolved and named.`,
      evidenceIds: [registry.id, enrichment.id],
    });
  }

  return out;
}

function sectionProvenance(evidence: DeskEvidence[]): ProvenanceClass {
  if (evidence.some((e) => e.provenance === "verified")) return "verified";
  if (evidence.some((e) => e.provenance === "unverified")) return "unverified";
  return "missing";
}

function buildSections(inv: DeskInvestigation): DeskReportSection[] {
  const workflow = DESK_WORKFLOWS[inv.type];
  const sections: DeskReportSection[] = [];
  for (const section of workflow.sections) {
    const relevant = inv.evidence.filter((e) => section.capabilities.includes(e.capability));
    const verified = relevant.filter((e) => e.provenance === "verified").length;
    const unverified = relevant.filter((e) => e.provenance === "unverified").length;
    const missing = relevant.filter((e) => e.provenance === "missing").length;
    const summary =
      relevant.length === 0
        ? "No capability from this section was planned or asked."
        : `${relevant.length} record(s): ${verified} verified, ${unverified} unverified, ${missing} missing.`;
    sections.push({
      id: section.id,
      title: section.title,
      summary,
      capabilityKeys: section.capabilities,
      evidenceIds: relevant.map((e) => e.id),
      provenance: sectionProvenance(relevant),
    });
  }
  return sections;
}

function confidenceOf(inv: DeskInvestigation, verified: number, askedVerifiedOrUnverified: number): DeskConfidence {
  if (verified > 0 && verified === askedVerifiedOrUnverified) return "signal_verified";
  if (verified > 0) return "partially_verified";
  const routable = inv.evidence.filter((e) => e.provenance === "unverified" && e.class === "probe_verified").length;
  if (routable > 0) return "route_verified_only";
  return "unverified";
}

/**
 * Build the report from the evidence ledger only. Deterministic: the same
 * ledger always produces the same report.
 */
export function buildDeskReport(inv: DeskInvestigation, opts: { mode: "free" | "intel"; spendUsdCents?: number; routableOffers?: number }): DeskReport {
  const findings = buildFindings(inv);
  const discrepancies = buildDiscrepancies(inv);
  const sections = buildSections(inv);
  const counts = {
    verified: inv.evidence.filter((e) => e.provenance === "verified").length,
    unverified: inv.evidence.filter((e) => e.provenance === "unverified").length,
    missing: inv.evidence.filter((e) => e.provenance === "missing").length,
    analysis: 0,
  };

  const limitations: string[] = [];
  const paid = opts.mode === "intel";
  limitations.push(
    paid
      ? `${counts.verified} record(s) rest on paid, hash-committed answers; ${counts.unverified} remain unverified.`
      : `Free run: no answer was purchased. The ${counts.unverified} route-verified record(s) carry schema, routing and price only — they are not findings.`,
  );
  if (inv.unsupported.length > 0) {
    limitations.push(
      `${inv.unsupported.length} requirement(s) are unsupported on the network and are named, not approximated: ${inv.unsupported.map((g) => g.label).join(", ")}.`,
    );
  }
  const inputGapCount = inv.evidence.filter((e) => e.id.startsWith("input-gap:")).length;
  if (inputGapCount > 0) {
    limitations.push(`${inputGapCount} capability(ies) were not asked because their required inputs were not supplied.`);
  }
  const declaredCount = inv.evidence.filter((e) => e.class === "declared").length;
  if (declaredCount > 0) {
    limitations.push(`${declaredCount} declared input(s) come from the guided form and were never verified by this workflow.`);
  }
  const drift = inv.evidence.filter((e) => e.viaRouterFallback).length;
  if (drift > 0) {
    limitations.push(`${drift} answer(s) were served by the router's fallback rather than the pinned provider.`);
  }
  limitations.push("This report is generated from recorded evidence only. It is not legal, sanctions, credit or investment advice.");

  const outstandingQuestions: string[] = [];
  for (const gap of inv.unsupported) {
    outstandingQuestions.push(gap.resolution);
  }
  for (const gap of planDeskCapabilities(inv).inputGaps) {
    outstandingQuestions.push(`"${gap.label}" needs ${gap.required.join("; ")} — supply the inputs and re-run to ask it.`);
  }
  const missingFieldQuestions = new Set<string>();
  for (const e of inv.evidence) {
    for (const f of e.missingFields ?? []) missingFieldQuestions.add(`Confirm "${f.replace(/_/g, " ")}" with an independent source — the committed answer omitted it.`);
  }
  outstandingQuestions.push(...missingFieldQuestions);
  if (!paid && (opts.routableOffers ?? 0) > 0) {
    outstandingQuestions.push(`Approve a paid run to purchase the ${(opts.routableOffers ?? 0).toString()} routable answer(s) (planned cost $${(((opts.routableOffers ?? 0) * 1) / 100).toFixed(2)} at the probed price).`);
  }
  if (inv.runs.length === 0) {
    outstandingQuestions.push("No run has been executed yet — start with the free pre-flight.");
  }

  const verifiedAsked = paid ? counts.verified + inv.evidence.filter((e) => e.class === "paid_unverified").length : 0;
  const confidence = confidenceOf(inv, counts.verified, verifiedAsked);
  const spend = opts.spendUsdCents ?? 0;
  const headline =
    counts.verified > 0
      ? `${counts.verified} verified record(s), ${counts.missing} named missing, $${(spend / 100).toFixed(2)} spent — confidence ${confidence.replace("_", " ")}.`
      : paid
        ? `No verified answer in this run. ${counts.unverified} unverified, ${counts.missing} missing — nothing is presented as data.`
        : `Route-verified only: ${counts.unverified} route(s) priced and schema-checked; no answer purchased and none presented as data.`;

  const report: DeskReport = {
    preparedAt: new Date().toISOString(),
    type: inv.type,
    mode: opts.mode,
    headline,
    findings,
    discrepancies,
    sections,
    limitations,
    outstandingQuestions,
    counts,
    confidence,
  };

  // The desk's own synthesis is one labelled analysis record that cites the
  // ledger it used — never rendered beside verified facts as if it were one.
  report.counts.analysis = 1;
  return report;
}

/** Sync + report in one call, then persist. */
export async function reportDeskInvestigation(inv: DeskInvestigation, mode: "free" | "intel"): Promise<{ added: number; notes: string[]; report: DeskReport }> {
  const sync = await syncDeskInvestigation(inv);
  let spendUsdCents = 0;
  let routableOffers = 0;
  for (const run of inv.runs) {
    const task = await getTask(run.taskId);
    if (!task) continue;
    spendUsdCents += task.spend.spentUsdCents;
    const baselineCoverage = task.result?.capabilityReport;
    if (baselineCoverage) routableOffers += baselineCoverage.counts.routable_unverified;
  }
  const report = buildDeskReport(inv, { mode, spendUsdCents, routableOffers });

  inv.evidence.push({
    id: `analysis:${report.preparedAt}`,
    provenance: "analysis",
    class: "analysis",
    capability: "desk_synthesis",
    label: "Desk synthesis",
    title: `Deal Desk synthesis · ${inv.reference}`,
    detail: report.headline,
    facts: {
      findings: report.findings.length,
      discrepancies: report.discrepancies.length,
      verified: report.counts.verified,
      unverified: report.counts.unverified,
      missing: report.counts.missing,
      confidence: report.confidence,
    },
    source: { kind: "none", ref: inv.reference, label: "desk report builder", observedAt: report.preparedAt },
  });

  inv.findings = report.findings;
  inv.report = report;
  inv.status = "reported";
  auditDesk(inv, "desk", "desk_report_built", report.headline);
  await saveDeskInvestigation(inv);
  return { added: sync.added, notes: sync.notes, report };
}
