/**
 * Generic capability-run executors for the Minds.
 *
 * This is the shared execution path every non-desk Mind uses: the plan is
 * built from the verified capability matrix, the baseline is unpaid, the
 * paid step is reachable only through the engine's human approval gate, and
 * the report is assembled from recorded evidence only.
 *
 * Inherited, not re-built:
 *  - `probeAsk` for the free pre-flight (schema, routing and live price),
 *  - `executeAsk` for a paid ask (exact approved offer + drift check),
 *  - `verifySignal` for keccak re-derivation over the committed payload,
 *  - the engine's spend ledger and task persistence.
 */

import { canTransition, type ExecutionEventType, type TaskRecord } from "@/lib/engine/types";
import { saveTask } from "@/lib/engine/store";
import type { ExecutionOutputs } from "@/lib/engine/engine";
import type { ApprovedOffer } from "@/lib/terminal/ask";
import { CAPABILITIES } from "@/lib/minds/capabilities";
import {
  buildCapabilityReport,
  defaultCapabilityDeps,
  executeApprovedDimension,
  probeCapabilitySet,
  type CapabilityRunnerDeps,
  type CapabilityOffer,
  type CommittedDimension,
  type MindCoverageProbe,
} from "@/lib/minds/capability-runner";
import type { CapabilityRunConfig } from "@/lib/minds/capability-plan";
import { BITCOIN_MINING_SLUG } from "@/lib/bitcoinmining/intel";
import { buildBitcoinMiningReport } from "@/lib/bitcoinmining/report";

/* ------------------------------------------------------------------ */
/* Injectable deps (tests override; production uses the real rails)    */
/* ------------------------------------------------------------------ */

export const capabilityDeps: CapabilityRunnerDeps = defaultCapabilityDeps();

export function setCapabilityDeps(overrides: Partial<CapabilityRunnerDeps>): void {
  Object.assign(capabilityDeps, overrides);
}

export function resetCapabilityDeps(): void {
  const real = defaultCapabilityDeps();
  capabilityDeps.probe = real.probe;
  capabilityDeps.execute = real.execute;
  capabilityDeps.verify = real.verify;
  capabilityDeps.notify = real.notify;
  capabilityDeps.now = real.now;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function event(task: TaskRecord, type: ExecutionEventType, message: string, data?: Record<string, unknown>): Promise<void> {
  const e = { id: `${capabilityDeps.now()}-${Math.random().toString(36).slice(2)}`, ts: capabilityDeps.now(), type, message };
  task.events.push(data ? { ...e, data } : e);
  task.updatedAt = capabilityDeps.now();
  await saveTask(task);
}

function guardedTransition(task: TaskRecord, next: Parameters<typeof canTransition>[1]): void {
  if (!canTransition(task.state, next)) throw new Error(`illegal task transition ${task.state} → ${next}`);
  task.state = next;
}

function configOf(target: string | undefined): CapabilityRunConfig {
  if (!target) throw new Error("capability step ran without a run config");
  const parsed = JSON.parse(target) as Partial<CapabilityRunConfig>;
  if (typeof parsed.slug !== "string" || (parsed.mode !== "free" && parsed.mode !== "intel") || typeof parsed.inputs !== "object" || parsed.inputs === null) {
    throw new Error("capability run config is malformed");
  }
  return parsed as CapabilityRunConfig;
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export interface CapabilityBaselineOutput {
  config: CapabilityRunConfig;
  coverage: MindCoverageProbe;
  offers: CapabilityOffer[];
  plannedCostUsdCents: number;
}

export interface CapabilityAsksOutput {
  committed: CommittedDimension[];
  attempted: number;
  answered: number;
  spendUsdCents: number;
}

/* ------------------------------------------------------------------ */
/* Step 1: capability_baseline — FREE                                  */
/* ------------------------------------------------------------------ */

export async function executeCapabilityBaseline(
  task: TaskRecord,
  stepTarget: string | undefined,
  outputs: ExecutionOutputs,
): Promise<void> {
  const config = configOf(stepTarget);
  const caps = CAPABILITIES[config.slug];
  if (!caps) throw new Error(`no capability matrix for ${config.slug}`);

  await event(
    task,
    "step_started",
    `Unpaid pre-flight for ${config.slug}: checking ${caps.plan.order.length} supported dimension(s) against the live node with their canonical schema and price (nothing is signed)`,
  );

  const { coverage, offers } = await probeCapabilitySet(config.slug, config.inputs, { deps: capabilityDeps });
  outputs.capabilityBaseline = {
    config,
    coverage,
    offers,
    plannedCostUsdCents: coverage.plannedCostUsdCents,
  };

  const rejected = coverage.dimensions.filter((d) => d.status === "rejected" || d.status === "unavailable");
  await event(
    task,
    "capability_baseline_ready",
    `Baseline assembled: ${coverage.routable}/${coverage.considered - coverage.gaps} supported dimension(s) are routable at $${(coverage.plannedCostUsdCents / 100).toFixed(2)}; ${coverage.gaps} dimension(s) are unsupported and were not asked.`,
    { routable: coverage.routable, gaps: coverage.gaps, plannedCostUsdCents: coverage.plannedCostUsdCents },
  );
  for (const failure of rejected) {
    await event(task, "step_failed", `${failure.label}: ${failure.detail}`);
  }
  if (config.mode === "free") {
    await event(task, "step_succeeded", "Free mode: only the pre-flight ran. No offer was signed and no answer is presented as data.");
  } else {
    await event(task, "step_succeeded", "Paid mode: the exact offers above await the human approval gate before anything is signed.");
  }
}

/* ------------------------------------------------------------------ */
/* Step 2: capability_ask — PAID (approved plan only)                  */
/* ------------------------------------------------------------------ */

export async function executeCapabilityAsk(
  task: TaskRecord,
  stepTarget: string | undefined,
  outputs: ExecutionOutputs,
): Promise<void> {
  const config = configOf(stepTarget);
  const baseline = outputs.capabilityBaseline;
  if (!baseline) throw new Error("capability asks ran before the baseline");
  if (config.mode !== "intel") throw new Error("capability asks were planned in free mode");

  if (!task.permissions.allowedActions.includes("telegraph.ask")) {
    await event(task, "permission_denied", 'Action "telegraph.ask" is not in this task\'s allowed actions, so no purchase was attempted');
    throw new Error("permission denied: telegraph.ask");
  }

  await event(
    task,
    "step_started",
    `Paying for ${baseline.offers.length} verified dimension(s) with a $${(task.spend.limitUsdCents / 100).toFixed(2)} ceiling — one attempt each, live offer must match the approved one, budget guarded per ask`,
  );

  const committed: CommittedDimension[] = [];
  let attempted = 0;
  let answered = 0;
  let spendUsdCents = 0;

  for (const offer of baseline.offers) {
    const remaining = task.spend.limitUsdCents - task.spend.spentUsdCents;
    attempted += 1;

    try {
      const result = await executeApprovedDimension({
        slug: config.slug,
        dimension: offer.dimension,
        params: config.inputs[offer.dimension.id] ?? {},
        approvedOffer: offer.approvedOffer,
        remainingBudgetUsdCents: remaining,
        deps: capabilityDeps,
      });
      answered += 1;
      spendUsdCents += result.costUsdCents;
      task.spend.spentUsdCents += result.costUsdCents;
      task.spend.entries.push({
        ts: capabilityDeps.now(),
        description: `${config.slug}: ${result.label} via Telegraph`,
        amountUsdCents: result.costUsdCents,
        source: "telegraph",
        receiptHash: result.receiptHash,
        signalHash: result.signalHash,
      });
      committed.push(result);
      await event(
        task,
        "spend_recorded",
        `Spent $${(result.costUsdCents / 100).toFixed(2)} on ${result.label} (task total $${(task.spend.spentUsdCents / 100).toFixed(2)} / $${(task.spend.limitUsdCents / 100).toFixed(2)})`,
        { amountUsdCents: result.costUsdCents, receiptHash: result.receiptHash, signalHash: result.signalHash },
      );
      await event(
        task,
        "step_succeeded",
        `${result.label}: ${result.verification === "verified" ? "verified against the node signal" : `recorded as ${result.verification}`} (signal ${result.signalHash})${result.missingFields.length ? `; committed answer is missing ${result.missingFields.join(", ")}` : ""}`,
        { signalHash: result.signalHash, verification: result.verification },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const label = offer.dimension.label;
      await event(task, "step_failed", `${label}: ${detail}`);
    }
  }

  outputs.capabilityAsks = { committed, attempted, answered, spendUsdCents };
  if (attempted > 0 && answered === 0) {
    throw new Error(`every one of the ${attempted} paid ask(s) failed — see the per-dimension diagnoses; nothing is presented as data`);
  }
  await event(
    task,
    "step_succeeded",
    `Paid asks complete: ${answered}/${attempted} answered, $${(spendUsdCents / 100).toFixed(2)} spent. Failed asks remain missing evidence, never values.`,
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: capability_report — structured deliverable                  */
/* ------------------------------------------------------------------ */

export async function executeCapabilityReport(
  task: TaskRecord,
  stepTarget: string | undefined,
  outputs: ExecutionOutputs,
): Promise<void> {
  const config = configOf(stepTarget);
  const baseline = outputs.capabilityBaseline;
  if (!baseline) throw new Error("capability report ran before the baseline");
  const asks = outputs.capabilityAsks;
  const committed = asks?.committed ?? [];
  const spendUsdCents = asks?.spendUsdCents ?? 0;

  guardedTransition(task, "verifying");
  await event(task, "verification_started", "Verifying the capability run: every verified value must trace to a recorded signal and receipt, the ledger must reconcile, and gaps must remain named.");

  const report = buildCapabilityReport({
    coverage: baseline.coverage,
    committed,
    spendUsdCents,
  });

  const bitcoinReport =
    config.slug === BITCOIN_MINING_SLUG
      ? buildBitcoinMiningReport({
          mode: config.mode,
          inputs: config.inputs,
          committed,
          preparedAt: new Date(capabilityDeps.now()).toISOString(),
          spendUsdCents,
          capabilityReport: report,
        })
      : undefined;

  if (config.mode === "free" && task.spend.entries.length > 0) {
    throw new Error("free-mode capability run recorded spend entries — impossible by construction");
  }
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

  const verified = report.counts.verified;
  const paid = committed.length;
  const confidence =
    paid === 0 ? "unverified" : verified === paid ? "signal-verified" : verified > 0 ? "partially-verified" : "unverified";
  const parts = [
    `${config.slug.toUpperCase()} capability run (${config.mode}): ${verified} verified, ${report.counts.recorded} recorded, ${report.counts.unverified} unverified, ${report.counts.routable_unverified} routable-only, ${report.counts.gap} unsupported.`,
    config.mode === "free"
      ? "Free mode: no purchase ran. Routable dimensions have a verified schema, provider route and price only; they are not findings."
      : `Paid asks ran under human approval; $${(spendUsdCents / 100).toFixed(2)} of the task budget was spent and the ledger reconciles.`,
    report.missing.length ? `Gap ledger: ${report.missing.map((m) => m.dimension).join(", ")}.` : "No unsupported dimensions were recorded.",
  ];

  const evidence = committed.flatMap((c) => [
    { kind: "telegraph_signal" as const, signalHash: c.signalHash, minerId: c.provider },
    { kind: "telegraph_receipt" as const, receiptHash: c.receiptHash, amountUsdCents: c.costUsdCents },
  ]);

  if (bitcoinReport) {
    const f = bitcoinReport.findings;
    parts.push(
      `Mining findings: hashprice ${f.hashpriceUsdPerPhDay === null ? "unavailable" : `$${f.hashpriceUsdPerPhDay.toFixed(2)}/PH/day (${f.hashpriceUsdBasis === "derived_from_btc" ? "derived from committed sats × committed BTC" : "provider"})`}, BTC ${f.btcPriceUsd === null ? "unavailable" : `$${f.btcPriceUsd.toLocaleString("en-US")}`}, ERCOT ${f.energyZone ?? "zone"} ${f.lmpUsdPerMwh === null ? "unavailable" : `$${f.lmpUsdPerMwh.toFixed(2)}/MWh`}${bitcoinReport.breakEven ? `, break-even ${bitcoinReport.breakEven.efficiencyJPerTh.toFixed(1)} J/TH` : ""}.`,
      bitcoinReport.alignment.aligned
        ? "Timestamps are aligned for an operational read."
        : "Timestamp alignment is not clean; read the explicit alignment notes before treating this as a current operating picture.",
    );
  }

  task.result = {
    summary: parts.join("\n"),
    capabilityReport: report,
    bitcoinMiningReport: bitcoinReport,
    evidence,
    completedAt: capabilityDeps.now(),
  };

  await event(task, "verification_passed", `Capability run verified: ${verified}/${paid} paid answer(s) verified against their signals, ledger reconciles${paid === 0 ? " (no purchase)" : ""}, and every gap is named.`);
  guardedTransition(task, "completed");
  await event(task, "task_completed", "Capability run complete.", { confidence, verified, gaps: report.counts.gap });
  await event(task, "capability_report_ready", `Report recorded for ${config.slug}: ${verified} verified, ${report.counts.gap} unsupported.`);

  // Bitcoin Mining Intelligence is the first Mind wired for report delivery to
  // Minds by Animoca Brands. Delivery is environment-gated, best-effort, and
  // recorded as skipped when the key or a bound alias is absent. A failed
  // delivery never changes the investigation result.
  if (bitcoinReport && config.mode === "intel" && capabilityDeps.notify) {
    const objective = bitcoinReport.objective
      ? `Bitcoin mining economics · block ${bitcoinReport.objective.blockHeight} · ${bitcoinReport.objective.zone} · ${bitcoinReport.objective.intervalStart}`
      : `Bitcoin mining economics · ${config.slug}`;
    const delivery = await capabilityDeps.notify({
      task: {
        id: task.id,
        goal: task.goal,
        state: task.state,
        summary: task.result?.summary,
      },
      report: {
        objective,
        confidence,
        intelUsed: true,
        reasoning: parts,
      },
    });
    await event(
      task,
      delivery.ok ? "delivery_succeeded" : "delivery_skipped",
      delivery.ok
        ? `Bitcoin mining report delivered to the connected Mind (${delivery.detail}).`
        : `Minds delivery skipped: ${delivery.detail}`,
    );
  }
}
