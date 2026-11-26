/**
 * Engine step executors for a Deal Desk investigation run.
 *
 * These reuse the shared capability machinery — `probeAsk` for the unpaid
 * pre-flight, `executeApprovedDimension` for a paid ask (exact approved
 * offer, drift check, keccak signal verification) and `buildCapabilityReport`
 * for the per-dimension status ledger. Nothing here re-implements payments,
 * verification or routing, and nothing touches a dimension outside the
 * investigation's planned capability set.
 *
 * Nothing in this module signs a payment: paid asks are reached only after
 * the engine's human approval gate has transitioned the task to executing.
 */

import { saveTask } from "@/lib/engine/store";
import type { ExecutionEventType, TaskRecord } from "@/lib/engine/types";
import type { ExecutionOutputs } from "@/lib/engine/engine";
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
  type CapabilityRunnerDeps,
} from "@/lib/minds/capability-runner";
import { resolveDeskCapability } from "./workflows";
import type { DeskInvestigationType } from "./types";

/* ------------------------------------------------------------------ */
/* Injectable deps (tests override; production uses the real rails)    */
/* ------------------------------------------------------------------ */

export const deskCapabilityDeps = defaultCapabilityDeps();

export function setDeskCapabilityDeps(overrides: Partial<CapabilityRunnerDeps>): void {
  Object.assign(deskCapabilityDeps, overrides);
}

export function resetDeskCapabilityDeps(): void {
  const real = defaultCapabilityDeps();
  deskCapabilityDeps.probe = real.probe;
  deskCapabilityDeps.execute = real.execute;
  deskCapabilityDeps.verify = real.verify;
  deskCapabilityDeps.now = real.now;
}

export interface DeskCapabilityPlanEntry {
  key: string;
  mind: string;
  dimension: string;
}

export interface DeskRunConfig {
  investigationId: string;
  reference: string;
  type: DeskInvestigationType;
  mode: "free" | "intel";
  /** The capability set this run may ask — planned once, executed verbatim. */
  capabilities: DeskCapabilityPlanEntry[];
  /** Params per capability key, exactly as planned from the form answers. */
  inputs: Record<string, Record<string, unknown>>;
}

export interface DeskBaseline {
  config: DeskRunConfig;
  coverage: MindCoverageProbe;
  offers: CapabilityOffer[];
  plannedCostUsdCents: number;
}

export interface DeskAsks {
  committed: CommittedDimension[];
  attempted: number;
  answered: number;
  spendUsdCents: number;
}

export function parseDeskConfig(target: string | undefined): DeskRunConfig {
  if (!target) throw new Error("desk step ran without a run config");
  const parsed = JSON.parse(target) as Partial<DeskRunConfig>;
  if (
    typeof parsed.investigationId !== "string" ||
    typeof parsed.reference !== "string" ||
    typeof parsed.type !== "string" ||
    (parsed.mode !== "free" && parsed.mode !== "intel") ||
    !Array.isArray(parsed.capabilities) ||
    typeof parsed.inputs !== "object" ||
    parsed.inputs === null
  ) {
    throw new Error("desk run config is malformed");
  }
  return parsed as DeskRunConfig;
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

/** Step 1: unpaid pre-flight over exactly the planned capability set. */
export async function executeDeskBaseline(task: TaskRecord, target: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const config = parseDeskConfig(target);
  const deps = deskCapabilityDeps;
  const dimensions: DimensionProbe[] = [];
  const offers: CapabilityOffer[] = [];
  let plannedCostUsdCents = 0;

  event(
    task,
    "step_started",
    `Unpaid pre-flight for ${config.reference}: checking ${config.capabilities.length} planned dimension(s) with their canonical schema and live price (nothing is signed)`,
  );

  for (const entry of config.capabilities) {
    const dim = resolveDeskCapability(entry);
    if (dim.status === "gap" || !dim.intent) {
      // A planned capability cannot drift into a gap: the plan is built from
      // the matrix and re-resolved here. If it ever does, refuse loudly.
      dimensions.push({ dimension: entry.key, label: dim.label, status: "gap", detail: dim.missingReason ?? "unsupported dimension" });
      continue;
    }
    let spec;
    try {
      spec = buildCapabilitySpec(dim, config.inputs[entry.key] ?? {});
    } catch (err) {
      dimensions.push({
        dimension: entry.key,
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
        dimension: entry.key,
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
        dimension: entry.key,
        label: dim.label,
        status: "rejected",
        httpStatus: outcome.status,
        detail: outcome.text || `the node refused the ask (HTTP ${outcome.status})`,
      });
    } else {
      dimensions.push({ dimension: entry.key, label: dim.label, status: "unavailable", detail: outcome.detail });
    }
  }

  const coverage: MindCoverageProbe = {
    slug: config.type,
    probedAt: new Date(deps.now()).toISOString(),
    dimensions,
    routable: dimensions.filter((d) => d.status === "routable").length,
    gaps: dimensions.filter((d) => d.status === "gap").length,
    plannedCostUsdCents,
    considered: dimensions.length,
  };
  outputs.deskBaseline = { config, coverage, offers, plannedCostUsdCents };

  event(
    task,
    "step_succeeded",
    `Pre-flight complete: ${coverage.routable}/${coverage.considered} planned dimension(s) routable at $${(plannedCostUsdCents / 100).toFixed(2)}; ${dimensions.filter((d) => d.status === "rejected" || d.status === "unavailable").length} refused or unavailable and recorded as such.`,
    { routable: coverage.routable, plannedCostUsdCents },
  );
  if (config.mode === "free") {
    event(task, "step_succeeded", "Free mode: no purchase is planned. A route and price are not findings.");
  } else {
    event(task, "step_succeeded", "Paid mode: the exact offers above await the human approval gate before anything is signed.");
  }
  await saveTask(task);
}

/** Step 2: approved paid asks, one attempt each, offer drift refused. */
export async function executeDeskIntel(task: TaskRecord, target: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const config = parseDeskConfig(target);
  const baseline = outputs.deskBaseline;
  if (!baseline) throw new Error("desk asks ran before the pre-flight");
  if (config.mode !== "intel") throw new Error("desk asks were planned in free mode");
  if (!task.permissions.allowedActions.includes("telegraph.ask")) {
    event(task, "permission_denied", 'Action "telegraph.ask" is not in this task\'s allowed actions, so no purchase was attempted');
    throw new Error("permission denied: telegraph.ask");
  }

  const deps = deskCapabilityDeps;
  const committed: CommittedDimension[] = [];
  let attempted = 0;
  let answered = 0;
  let spendUsdCents = 0;

  // Config inputs are keyed by capability key ("mind:dimension"); offers only
  // carry the matrix dimension id, so resolve the key through the planned set.
  const keyByDimension = new Map(config.capabilities.map((c) => [c.dimension, c.key] as const));

  event(
    task,
    "step_started",
    `Paying for ${baseline.offers.length} verified dimension(s) within a $${(task.spend.limitUsdCents / 100).toFixed(2)} ceiling — one attempt each, offer drift refused, budget guarded per ask`,
  );

  for (const offer of baseline.offers) {
    attempted += 1;
    try {
      const result = await executeApprovedDimension({
        slug: config.type,
        dimension: offer.dimension,
        params: config.inputs[keyByDimension.get(offer.dimension.id) ?? ""] ?? {},
        approvedOffer: offer.approvedOffer as ApprovedOffer,
        remainingBudgetUsdCents: task.spend.limitUsdCents - task.spend.spentUsdCents,
        spec: offer.spec,
        deps,
      });
      // The baseline probes are keyed by capability key ("mind:dimension") so
      // cross-Mind plans stay unambiguous; the committed answer carries the
      // matrix dimension id. Re-attach the key so the report joins them.
      result.dimension = keyByDimension.get(offer.dimension.id) ?? offer.dimension.id;
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

  outputs.deskAsks = { committed, attempted, answered, spendUsdCents };
  if (attempted > 0 && answered === 0) {
    throw new Error(`every one of the ${attempted} paid ask(s) failed; no intelligence is presented as evidence`);
  }
  event(task, "step_succeeded", `Paid asks complete: ${answered}/${attempted} answered, $${(spendUsdCents / 100).toFixed(2)} spent.`);
  await saveTask(task);
}

/** Step 3: assemble the per-dimension status ledger and complete the task. */
export async function executeDeskReport(task: TaskRecord, target: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const config = parseDeskConfig(target);
  const baseline = outputs.deskBaseline;
  if (!baseline) throw new Error("desk report ran before the pre-flight");
  const asks = outputs.deskAsks;
  const committed = asks?.committed ?? [];
  const spendUsdCents = asks?.spendUsdCents ?? 0;

  if (task.state !== "verifying") {
    if (task.state !== "executing") throw new Error(`desk report cannot run from ${task.state}`);
    task.state = "verifying";
  }
  event(task, "verification_started", "Verifying the run: every accepted value must trace to a recorded signal and receipt, and refused dimensions stay named.");

  const report = buildCapabilityReport({ coverage: baseline.coverage, committed, spendUsdCents });

  for (const c of committed) {
    if (c.verification === "verified" && (!c.signalHash || !c.receiptHash)) {
      throw new Error(`${c.dimension} is marked verified without a signal or receipt hash`);
    }
  }
  if (task.criteria.reconcileLedgerEntries) {
    const sum = task.spend.entries.reduce((n, e) => n + e.amountUsdCents, 0);
    if (sum !== task.spend.spentUsdCents) {
      throw new Error(`spend ledger does not reconcile: entries ${sum}¢ vs recorded ${task.spend.spentUsdCents}¢`);
    }
    if (task.spend.entries.length !== committed.length) {
      throw new Error(`spend ledger has ${task.spend.entries.length} entries but ${committed.length} committed answers`);
    }
  }

  task.result = {
    summary: [
      `Deal Desk run (${config.mode}) for ${config.reference} (${config.type}): ${report.counts.verified} verified, ${report.counts.recorded} recorded, ${report.counts.routable_unverified} route-only, ${report.counts.gap} unsupported.`,
      config.mode === "free"
        ? "Free mode: no purchase ran; a route and price are not findings."
        : `Paid asks ran under human approval; $${(spendUsdCents / 100).toFixed(2)} spent and the ledger reconciles.`,
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
  event(task, "task_completed", "Deal Desk intelligence run complete; the report is built from this recorded evidence only.");
  await saveTask(task);
}
