/**
 * Paid-intelligence orchestration for an assurance file.
 *
 * The run is an ordinary engine task (`jobType: "capability_run"`), so it
 * inherits the approval gate, the spend ledger, the per-ask drift check and
 * the node-signal verification. This module supplies the assurance config and
 * translates the completed capability report into evidence with provenance.
 */

import { createTask, defaultDeps, runTask, EngineError } from "@/lib/engine/engine";
import { getTask, saveTask } from "@/lib/engine/store";
import type { PlanStep, TaskRecord, VerificationCriteria } from "@/lib/engine/types";
import { ASSURANCE_MIND_SLUG } from "./capabilities";
import type { AssuranceRunConfig } from "./execute";
import { audit, saveInvestigation } from "./store";
import type { AssuranceEvidence, Investigation } from "./types";

export interface AssuranceRunResult {
  task: TaskRecord;
  accepted: boolean;
}

/** Only dimensions whose required inputs are actually available are asked. */
function dimensionInputs(inv: Investigation): Record<string, Record<string, unknown>> {
  const entity = inv.counterparty.legalName.trim();
  const inputs: Record<string, Record<string, unknown>> = {
    counterparty_registry: {
      company: entity,
      jurisdiction: inv.transaction.jurisdiction.trim() || "US",
    },
    sanctions_screening: { name: entity },
    regulatory_filings: { entity, period: "last 12 months" },
    firmographic_enrichment: { company: entity },
  };
  const documentText = inv.transaction.documents.find((d) => d.content?.trim())?.content?.trim();
  if (documentText) inputs.document_authenticity = { document: documentText };
  if (inv.transaction.contractText?.trim()) inputs.contract_obligations = { contract: inv.transaction.contractText.trim() };
  return inputs;
}

export function assuranceRunConfig(inv: Investigation, mode: "free" | "intel"): AssuranceRunConfig {
  const inputs = dimensionInputs(inv);
  return {
    investigationId: inv.id,
    reference: inv.reference,
    mode,
    entity: inv.counterparty.legalName,
    dimensions: Object.keys(inputs),
    inputs,
  };
}

/**
 * Creates the run for this file. A paid run always stops at
 * `awaiting_approval`; approval uses the existing
 * POST /api/tasks/:id/action {action:"approve"} gate.
 */
export async function createAssuranceRun(
  inv: Investigation,
  mode: "free" | "intel",
  opts: { spendLimitUsdCents?: number; actor?: string } = {},
): Promise<AssuranceRunResult> {
  const config = assuranceRunConfig(inv, mode);
  if (config.dimensions.length === 0) {
    throw new EngineError("this file has no dimension with complete inputs, so no run was planned");
  }
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
      id: "assurance-baseline",
      kind: "assurance_baseline",
      description: `Unpaid pre-flight for ${inv.reference}: probe ${config.dimensions.length} verified dimension(s) with their canonical schema and record the live price; nothing is signed`,
      target,
    },
  ];
  if (paid) {
    steps.push({
      id: "assurance-intel",
      kind: "assurance_intel",
      description: `PAID assurance intelligence for ${inv.reference}: one attempt per routable dimension, each drift-checked against its approved offer and guarded by the plan's ceiling`,
      target,
      maxCostUsdCents: opts.spendLimitUsdCents ?? inv.spendLimitUsdCents,
    });
  }
  steps.push({
    id: "assurance-report",
    kind: "assurance_report",
    description: "Per-dimension status ledger from the recorded signals and receipts; refused or unverified answers never become findings",
    target,
  });

  const task = await createTask({
    goal: `${paid ? "Settlement assurance intelligence" : "Settlement assurance pre-flight"} · ${inv.reference} · ${inv.counterparty.legalName}`,
    spendLimitUsdCents: opts.spendLimitUsdCents ?? inv.spendLimitUsdCents,
    requiresApproval: paid,
    origin: { source: "web" },
    jobType: "capability_run",
    plan: steps,
    criteria,
    assumptions: [
      "beneficial ownership has no verified route and is never planned or inferred",
      "paid asks are one attempt each, pinned to their provider and refused if the live offer drifts from the approved one",
      paid
        ? "nothing is signed until an operator approves this exact plan"
        : "free mode plans no purchase and spends nothing",
    ],
  });

  task.labels = [...(task.labels ?? []), `assurance:${inv.id}`, `assurance-mode:${mode}`];
  await saveTask(task);

  if (task.state === "executing") {
    void runTask(task.id, defaultDeps()).catch((err) =>
      console.error("assurance free run failed:", err instanceof Error ? err.message : err),
    );
  }

  inv.intelligenceRuns.push({
    taskId: task.id,
    mode,
    createdAt: new Date().toISOString(),
    taskState: task.state,
    ceilingUsdCents: task.spend.limitUsdCents,
    absorbed: false,
  });
  audit(inv, opts.actor ?? "operator", "intelligence_run_created", `${mode} run ${task.id} at ${task.state}`);
  if (inv.status === "draft") inv.status = "collecting";
  await saveInvestigation(inv);

  return { task, accepted: task.state === "executing" };
}

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

/**
 * Pulls completed runs into the evidence ledger. Idempotent: a run is
 * absorbed once, and an answer is marked node_verified only when the report
 * says its signal re-derived.
 */
export async function syncIntelligence(inv: Investigation): Promise<{ added: number; notes: string[] }> {
  const notes: string[] = [];
  let added = 0;

  for (const run of inv.intelligenceRuns) {
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
      if (dim.status === "gap") {
        notes.push(`${dim.label}: unsupported on the network. ${dim.detail}`);
        continue;
      }
      if (dim.status === "routable_unverified") {
        inv.evidence.push({
          id: `${run.taskId}:${dim.dimension}:probe`,
          class: "probe_verified",
          capability: dim.dimension,
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
        continue;
      }
      if (dim.status !== "verified" && dim.status !== "recorded") continue;
      if (!dim.signalHash) {
        notes.push(`${dim.label}: ${dim.status} without a signal hash, so it is not admissible.`);
        continue;
      }
      inv.evidence.push({
        id: `${run.taskId}:${dim.dimension}`,
        class: "node_verified",
        capability: dim.dimension,
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
      });
      added += 1;
    }
    run.absorbed = true;
    notes.push(`Absorbed ${report.counts.verified} verified and ${report.counts.routable_unverified} probe-only dimension(s) from run ${run.taskId}.`);
  }

  return { added, notes };
}

export function spendSummary(inv: Investigation, tasks: TaskRecord[]): { spentUsdCents: number; ceilingUsdCents: number } {
  const linked = new Map(tasks.map((t) => [t.id, t]));
  let spent = 0;
  let ceiling = 0;
  for (const run of inv.intelligenceRuns) {
    const task = linked.get(run.taskId);
    if (!task) continue;
    spent += task.spend.spentUsdCents;
    ceiling += task.spend.limitUsdCents;
  }
  return { spentUsdCents: spent, ceilingUsdCents: ceiling };
}

export { ASSURANCE_MIND_SLUG };
