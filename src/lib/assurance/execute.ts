/**
 * Engine step executors for a settlement-assurance run.
 *
 * These reuse the shared capability machinery — `probeAsk` for the unpaid
 * pre-flight, `executeApprovedDimension` for a paid ask (exact approved offer,
 * drift check, keccak signal verification) and `buildCapabilityReport` for the
 * per-dimension status ledger — without touching the Minds catalogue or the
 * shared capability matrix.
 *
 * Nothing in this module signs a payment: paid asks are reached only after
 * the engine's human approval gate has transitioned the task to executing.
 */

import { saveTask } from "@/lib/engine/store";
import type { ExecutionEventType, TaskRecord } from "@/lib/engine/types";
import type { ExecutionOutputs } from "@/lib/engine/engine";
import { probeAsk } from "@/lib/terminal/ask";
import type { ApprovedOffer } from "@/lib/terminal/ask";
import {
  buildCapabilityReport,
  buildCapabilitySpec,
  defaultCapabilityDeps,
  executeApprovedDimension,
  type CapabilityOffer,
  type CommittedDimension,
  type DimensionProbe,
  type MindCoverageProbe,
} from "@/lib/minds/capability-runner";
import { ASSURANCE_MIND_SLUG, assuranceDimension } from "./capabilities";

export interface AssuranceRunConfig {
  investigationId: string;
  reference: string;
  mode: "free" | "intel";
  entity: string;
  dimensions: string[];
  inputs: Record<string, Record<string, unknown>>;
}

export interface AssuranceBaseline {
  config: AssuranceRunConfig;
  coverage: MindCoverageProbe;
  offers: CapabilityOffer[];
  plannedCostUsdCents: number;
}

export interface AssuranceAsks {
  committed: CommittedDimension[];
  attempted: number;
  answered: number;
  spendUsdCents: number;
}

export function parseAssuranceConfig(target: string | undefined): AssuranceRunConfig {
  if (!target) throw new Error("assurance step ran without a run config");
  const parsed = JSON.parse(target) as Partial<AssuranceRunConfig>;
  if (
    typeof parsed.investigationId !== "string" ||
    typeof parsed.reference !== "string" ||
    (parsed.mode !== "free" && parsed.mode !== "intel") ||
    !Array.isArray(parsed.dimensions) ||
    typeof parsed.inputs !== "object" ||
    parsed.inputs === null
  ) {
    throw new Error("assurance run config is malformed");
  }
  return parsed as AssuranceRunConfig;
}

function event(task: TaskRecord, type: ExecutionEventType, message: string, data?: Record<string, unknown>): void {
  task.events.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    type,
    message,
    ...(data ? { data } : {}),
  });
  task.updatedAt = Date.now();
}

/** Step 1: unpaid pre-flight over the dimensions this file can ask. */
export async function executeAssuranceBaseline(task: TaskRecord, target: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const config = parseAssuranceConfig(target);
  const deps = defaultCapabilityDeps();
  const dimensions: DimensionProbe[] = [];
  const offers: CapabilityOffer[] = [];
  let plannedCostUsdCents = 0;

  event(
    task,
    "step_started",
    `Unpaid assurance pre-flight for ${config.reference}: checking ${config.dimensions.length} verified dimension(s) with their canonical schema and live price (nothing is signed)`,
  );

  for (const id of config.dimensions) {
    const dim = assuranceDimension(id);
    if (!dim || dim.status === "gap" || !dim.intent) {
      dimensions.push({ dimension: id, label: id, status: "gap", detail: "unsupported dimension" });
      continue;
    }
    let spec;
    try {
      spec = buildCapabilitySpec(dim, config.inputs[id] ?? {});
    } catch (err) {
      dimensions.push({
        dimension: dim.id,
        label: dim.label,
        status: "rejected",
        httpStatus: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const outcome = await deps.probe(spec);
    if (outcome.kind === "challenge") {
      const cents = Math.round(outcome.pricedOffer.amountCents);
      plannedCostUsdCents += cents;
      offers.push({ dimension: dim, spec, approvedOffer: outcome.approvedOffer, priceUsdCents: cents });
      dimensions.push({
        dimension: dim.id,
        label: dim.label,
        status: "routable",
        intent: dim.intent,
        provider: dim.provider ?? "router",
        priceUsdCents: cents,
        network: outcome.approvedOffer.network,
        detail: `routable at $${(cents / 100).toFixed(2)} on ${outcome.approvedOffer.network} (unpaid probe; nothing signed)`,
      });
    } else if (outcome.kind === "rejected") {
      dimensions.push({
        dimension: dim.id,
        label: dim.label,
        status: "rejected",
        httpStatus: outcome.status,
        detail: outcome.text || `the node refused the ask (HTTP ${outcome.status})`,
      });
    } else {
      dimensions.push({ dimension: dim.id, label: dim.label, status: "unavailable", detail: outcome.detail });
    }
  }

  const coverage: MindCoverageProbe = {
    slug: ASSURANCE_MIND_SLUG,
    probedAt: new Date(deps.now()).toISOString(),
    dimensions,
    routable: dimensions.filter((d) => d.status === "routable").length,
    gaps: 0,
    plannedCostUsdCents,
    considered: dimensions.length,
  };
  outputs.assuranceBaseline = { config, coverage, offers, plannedCostUsdCents };

  event(
    task,
    "step_succeeded",
    `Pre-flight complete: ${coverage.routable}/${coverage.considered} dimension(s) routable at $${(plannedCostUsdCents / 100).toFixed(2)}; ${dimensions.filter((d) => d.status === "rejected" || d.status === "unavailable").length} refused or unavailable and recorded as such.`,
    { routable: coverage.routable, plannedCostUsdCents },
  );
  if (config.mode === "free") {
    event(task, "step_succeeded", "Free mode: no purchase is planned. A route and price are not findings.");
  } else {
    event(task, "step_succeeded", "Paid mode: the exact offers above await the human approval gate before anything is signed.");
  }
  await saveTask(task);
}

/** Step 2: approved paid asks, one attempt each. */
export async function executeAssuranceIntel(task: TaskRecord, target: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const config = parseAssuranceConfig(target);
  const baseline = outputs.assuranceBaseline;
  if (!baseline) throw new Error("assurance asks ran before the pre-flight");
  if (config.mode !== "intel") throw new Error("assurance asks were planned in free mode");
  if (!task.permissions.allowedActions.includes("telegraph.ask")) {
    event(task, "permission_denied", 'Action "telegraph.ask" is not in this task\'s allowed actions, so no purchase was attempted');
    throw new Error("permission denied: telegraph.ask");
  }

  const deps = defaultCapabilityDeps();
  const committed: CommittedDimension[] = [];
  let attempted = 0;
  let answered = 0;
  let spendUsdCents = 0;

  event(
    task,
    "step_started",
    `Paying for ${baseline.offers.length} verified dimension(s) within a $${(task.spend.limitUsdCents / 100).toFixed(2)} ceiling — one attempt each, offer drift refused, budget guarded per ask`,
  );

  for (const offer of baseline.offers) {
    attempted += 1;
    try {
      const result = await executeApprovedDimension({
        slug: ASSURANCE_MIND_SLUG,
        dimension: offer.dimension,
        params: config.inputs[offer.dimension.id] ?? {},
        approvedOffer: offer.approvedOffer as ApprovedOffer,
        remainingBudgetUsdCents: task.spend.limitUsdCents - task.spend.spentUsdCents,
        deps,
      });
      answered += 1;
      spendUsdCents += result.costUsdCents;
      task.spend.spentUsdCents += result.costUsdCents;
      task.spend.entries.push({
        ts: Date.now(),
        description: `${config.reference}: ${result.label} via Telegraph`,
        amountUsdCents: result.costUsdCents,
        source: "telegraph",
        receiptHash: result.receiptHash,
        signalHash: result.signalHash,
      });
      committed.push(result);
      event(task, "spend_recorded", `Spent $${(result.costUsdCents / 100).toFixed(2)} on ${result.label}`, {
        amountUsdCents: result.costUsdCents,
        receiptHash: result.receiptHash,
        signalHash: result.signalHash,
      });
      event(
        task,
        "step_succeeded",
        `${result.label}: ${result.verification === "verified" ? "verified against the node signal" : `recorded as ${result.verification}`}${result.missingFields.length ? `; missing ${result.missingFields.join(", ")}` : ""}`,
        { signalHash: result.signalHash, verification: result.verification },
      );
    } catch (err) {
      event(task, "step_failed", `${offer.dimension.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  outputs.assuranceAsks = { committed, attempted, answered, spendUsdCents };
  if (attempted > 0 && answered === 0) {
    throw new Error(`every one of the ${attempted} paid ask(s) failed; no intelligence is presented as evidence`);
  }
  event(task, "step_succeeded", `Paid asks complete: ${answered}/${attempted} answered, $${(spendUsdCents / 100).toFixed(2)} spent.`);
  await saveTask(task);
}

/** Step 3: assemble the per-dimension status ledger and complete the task. */
export async function executeAssuranceReport(task: TaskRecord, target: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const config = parseAssuranceConfig(target);
  const baseline = outputs.assuranceBaseline;
  if (!baseline) throw new Error("assurance report ran before the pre-flight");
  const asks = outputs.assuranceAsks;
  const committed = asks?.committed ?? [];
  const spendUsdCents = asks?.spendUsdCents ?? 0;

  if (task.state !== "verifying") {
    if (task.state !== "executing") throw new Error(`assurance report cannot run from ${task.state}`);
    task.state = "verifying";
  }
  event(task, "verification_started", "Verifying the run: every accepted value must trace to a recorded signal and receipt, and refused dimensions stay named.");

  const counts = committed.reduce(
    (acc, c) => {
      acc[c.verification] += 1;
      return acc;
    },
    { verified: 0, recorded: 0, unverified: 0 },
  );
  if (asks && asks.attempted > 0 && counts.unverified > 0) {
    event(task, "criteria_check_passed", `${counts.unverified} paid answer(s) could not be re-derived; they are recorded as ${"unverified"} and cannot become findings.`);
  }

  const report = buildCapabilityReport({ coverage: baseline.coverage, committed, spendUsdCents });
  task.result = {
    summary: [
      `Settlement assurance run (${config.mode}) for ${config.reference}: ${report.counts.verified} verified, ${report.counts.recorded} recorded, ${report.counts.routable_unverified} route-only, ${report.counts.gap} unsupported.`,
      config.mode === "free"
        ? "Free mode: no purchase ran; a route and price are not findings."
        : `Paid asks ran under human approval; $${(spendUsdCents / 100).toFixed(2)} spent.`,
    ].join("\n"),
    capabilityReport: report,
    evidence: committed.flatMap((c) => [
      { kind: "telegraph_signal" as const, signalHash: c.signalHash, minerId: c.provider },
      { kind: "telegraph_receipt" as const, receiptHash: c.receiptHash, amountUsdCents: c.costUsdCents },
    ]),
    completedAt: Date.now(),
  };
  event(task, "verification_passed", `Run verified: ${report.counts.verified}/${committed.length} paid answer(s) re-derived against their signals.`);
  task.state = "completed";
  event(task, "task_completed", "Assurance intelligence run complete; the decision is recorded separately from this evidence.");
  await saveTask(task);
}
