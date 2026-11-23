import { canTransition, type ExecutionEventType, type TaskRecord } from "@/lib/engine/types";
import { saveTask } from "@/lib/engine/store";
import type { ExecutionOutputs } from "@/lib/engine/engine";
import type { ApprovedOffer, ExecuteInput, ExecuteOutcome } from "@/lib/terminal/ask";
import { probeAsk } from "@/lib/terminal/ask";
import {
  analyzeIndexDimension,
  askableDimensions,
  buildDimensionSpec,
  INDEX_DIMENSION_LABELS,
  probeIndexDimension,
  type IndexAssetDefinition,
  type IndexDefinition,
  type IndexDimension,
} from "@/lib/indexdesk/intel";
import { buildIndexProposal, type CollectedAsset, type CollectedDimension } from "@/lib/indexdesk/method";
import {
  buildIndexReasoning,
  indexDeskConfidence,
  type IndexDeskReport,
} from "@/lib/indexdesk/report";

/**
 * Index Reconstitution Desk step executors. Imported by the task engine and
 * dispatched by runPlan for plan steps of kind index_baseline / index_data_ask
 * / index_report. The payment properties of the Mind flow are inherited, not
 * re-built:
 *
 *  - index_baseline is FREE: probeAsk only — the node validates and prices
 *    each asset × dimension ask; nothing is signed here, ever.
 *  - index_data_ask is PAID and runs only because the human approved the plan
 *    (the engine's approval gate). Each ask goes through executeAsk with the
 *    offer its own probe produced (drift-checked live), ONE attempt, no
 *    retry; a per-ask failure is recorded as missing evidence for that asset
 *    and never re-charged. Budget is checked against the task's remaining
 *    spend before every signature.
 *  - index_report reads only recorded evidence; the weighting math is
 *    deterministic (method.ts) and the ledger entries are reconciled during
 *    verification.
 */

/* ------------------------------------------------------------------ */
/* Injectable runner deps (tests override; production uses defaults)   */
/* ------------------------------------------------------------------ */

export interface IndexDeskRunnerDeps {
  probe: (asset: IndexAssetDefinition, dimension: IndexDimension) => ReturnType<typeof probeAsk>;
  execute: (input: ExecuteInput) => Promise<ExecuteOutcome>;
  analyze: typeof analyzeIndexDimension;
  now: () => number;
}

export const indexDeskDeps: IndexDeskRunnerDeps = {
  probe: (asset, dimension) => probeIndexDimension(asset, dimension),
  execute: (input) => import("@/lib/terminal/ask").then((m) => m.executeAsk(input)),
  analyze: (args) => analyzeIndexDimension(args),
  now: () => Date.now(),
};

/** Test hook; restore with resetIndexDeskDeps(). */
export function setIndexDeskDeps(overrides: Partial<IndexDeskRunnerDeps>): void {
  Object.assign(indexDeskDeps, overrides);
}
export function resetIndexDeskDeps(): void {
  indexDeskDeps.probe = (asset, dimension) => probeIndexDimension(asset, dimension);
  indexDeskDeps.execute = (input) => import("@/lib/terminal/ask").then((m) => m.executeAsk(input));
  indexDeskDeps.analyze = (args) => analyzeIndexDimension(args);
  indexDeskDeps.now = () => Date.now();
}

/* ------------------------------------------------------------------ */
/* Local helpers (same persistence discipline as the Mind executors)   */
/* ------------------------------------------------------------------ */

async function event(task: TaskRecord, type: ExecutionEventType, message: string, data?: Record<string, unknown>): Promise<void> {
  const e = { id: `${indexDeskDeps.now()}-${Math.random().toString(36).slice(2)}`, ts: indexDeskDeps.now(), type, message };
  task.events.push(data ? { ...e, data } : e);
  task.updatedAt = indexDeskDeps.now();
  // Awaited: an un-awaited save races the engine's own saveTask on the same
  // file (mind/execute.ts documents the observed ENOENT), so persistence
  // here is strictly sequential too.
  await saveTask(task);
}

function guardedTransition(task: TaskRecord, next: Parameters<typeof canTransition>[1]): void {
  if (!canTransition(task.state, next)) {
    throw new Error(`illegal task transition ${task.state} → ${next}`);
  }
  task.state = next;
}

function definitionOf(target: string | undefined): IndexDefinition | null {
  if (!target) return null;
  try {
    const parsed = JSON.parse(target) as { name?: unknown; assets?: unknown };
    if (typeof parsed.name !== "string" || !Array.isArray(parsed.assets) || parsed.assets.length === 0) return null;
    return parsed as unknown as IndexDefinition;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Outputs carried between steps                                       */
/* ------------------------------------------------------------------ */

export interface IndexProbeRecord {
  symbol: string;
  dimension: IndexDimension;
  status: "challenge" | "rejected" | "unavailable" | "not_askable";
  priceUsdCents?: number;
  miner: string;
  detail: string;
  /** When challenged: the exact spec + approved offer the paid ask will use. */
  offer?: { spec: ReturnType<typeof buildDimensionSpec> & object; approvedOffer: ApprovedOffer };
}

export interface IndexDeskBaselineOutput {
  definition: IndexDefinition;
  mode: "free" | "intel";
  probes: IndexProbeRecord[];
  /** What the full paid plan would cost at the probed prices (cents). */
  plannedCostUsdCents: number;
}

export interface IndexDeskAsksOutput {
  collected: CollectedAsset[];
  paidAsks: number;
  answeredAsks: number;
  spendUsdCents: number;
}

/* ------------------------------------------------------------------ */
/* Step 1: index_baseline — FREE                                       */
/* ------------------------------------------------------------------ */

export async function executeIndexBaseline(task: TaskRecord, stepTarget: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const definition = definitionOf(stepTarget);
  if (!definition) throw new Error("index baseline ran without a parsed index definition");
  const mode: "free" | "intel" = task.plan?.some((s) => s.kind === "index_data_ask") ? "intel" : "free";

  await event(task, "step_started", `Unpaid pre-flight for index "${definition.name}": probing ${definition.assets.length} asset(s) × their askable dimensions (nothing is signed at this stage)`);

  const probes: IndexProbeRecord[] = [];
  let plannedCostUsdCents = 0;

  for (const asset of definition.assets) {
    for (const dimension of askableDimensions(asset)) {
      const outcome = await indexDeskDeps.probe(asset, dimension);
      if (outcome.kind === "challenge") {
        const cents = Math.round(outcome.pricedOffer.amountCents);
        plannedCostUsdCents += cents;
        probes.push({
          symbol: asset.symbol,
          dimension,
          status: "challenge",
          priceUsdCents: cents,
          miner: outcome.approvedOffer.payTo ? `offer ${outcome.approvedOffer.amount} uUSDC` : "",
          detail: `routable at $${(cents / 100).toFixed(2)} (${outcome.approvedOffer.network})`,
          offer: {
            // The paid step re-sends this exact spec and drift-checks this
            // exact offer; probe time freezes the contract.
            spec: buildDimensionSpec(asset, dimension) as ReturnType<typeof buildDimensionSpec> & object,
            approvedOffer: outcome.approvedOffer,
          },
        });
      } else if (outcome.kind === "rejected") {
        probes.push({ symbol: asset.symbol, dimension, status: "rejected", miner: "", detail: outcome.text || `the node refused the ask (HTTP ${outcome.status})` });
      } else {
        probes.push({ symbol: asset.symbol, dimension, status: "unavailable", miner: "", detail: outcome.detail });
      }
    }
  }

  const challengeCount = probes.filter((p) => p.status === "challenge").length;
  outputs.indexDeskBaseline = { definition, mode, probes, plannedCostUsdCents };

  await event(
    task,
    "index_baseline_ready",
    `Baseline assembled: ${challengeCount}/${probes.length} dimension asks are routable (full plan ≈ $${(plannedCostUsdCents / 100).toFixed(2)}). ${
      mode === "intel" ? "The paid step awaits the human approval gate." : "Free mode: no purchase path is planned."
    }`,
    { plannedCostUsdCents, challengeCount },
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: index_data_ask — PAID (human-approved plan only)            */
/* ------------------------------------------------------------------ */

export async function executeIndexDataAsk(task: TaskRecord, stepTarget: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const baseline = outputs.indexDeskBaseline;
  if (!baseline) throw new Error("index data asks ran before the baseline");
  const definition = baseline.definition;

  // Permission boundary: same allowlist as any other purchase.
  if (!task.permissions.allowedActions.includes("telegraph.ask")) {
    await event(task, "permission_denied", 'Action "telegraph.ask" is not in this task\'s allowed actions, so no purchase was attempted');
    throw new Error("permission denied: telegraph.ask");
  }

  const offers = baseline.probes.filter((p) => p.status === "challenge" && p.offer);
  await event(task, "step_started", `Paying for ${offers.length} dimension ask(s) across ${definition.assets.length} asset(s) — one attempt each, live offer must match the approved one, budget guarded per ask`);

  const collected: CollectedAsset[] = definition.assets.map((definition_) => ({ definition: definition_, dimensions: [] }));
  const collectedFor = (symbol: string): CollectedAsset => collected.find((c) => c.definition.symbol === symbol) as CollectedAsset;

  let paidAsks = 0;
  let answeredAsks = 0;
  let spendUsdCents = 0;

  for (const probeRecord of offers) {
    const asset = definition.assets.find((a) => a.symbol === probeRecord.symbol) as IndexAssetDefinition;
    const dimension = probeRecord.dimension;
    const target = collectedFor(probeRecord.symbol);
    const amountCents = probeRecord.priceUsdCents ?? 0;

    const remainingUsdCents = task.spend.limitUsdCents - task.spend.spentUsdCents;
    if (remainingUsdCents < amountCents) {
      target.dimensions.push({
        dimension,
        status: "missing",
        detail: `the ask was planned and priced at $${(amountCents / 100).toFixed(2)} but the task's remaining budget is $${(remainingUsdCents / 100).toFixed(2)}; skipped without signing`,
      });
      await event(task, "spend_denied", `Ask for ${probeRecord.symbol} ${INDEX_DIMENSION_LABELS[dimension]} skipped: $${(amountCents / 100).toFixed(2)} exceeds the remaining budget $${(remainingUsdCents / 100).toFixed(2)}. No payment was signed.`);
      continue;
    }

    paidAsks += 1;
    await event(task, "step_started", `Asking ${probeRecord.symbol} — ${INDEX_DIMENSION_LABELS[dimension]} ($${(amountCents / 100).toFixed(2)})`);

    const outcome = await indexDeskDeps.execute({
      spec: probeRecord.offer!.spec,
      approved: true,
      approvedOffer: probeRecord.offer!.approvedOffer,
    });

    if (outcome.kind !== "answered") {
      const detail =
        outcome.kind === "refused"
          ? `refused before anything was signed: ${outcome.reason}`
          : outcome.kind === "integrity"
            ? `paid delivery could not be reconciled: ${outcome.detail} — a payment may have settled, so this is NEVER retried`
            : outcome.kind === "payment_rejected"
              ? `the payment was rejected: ${outcome.detail}`
              : outcome.kind === "unpaid_rejected"
                ? `the node rejected the request (HTTP ${outcome.status})`
                : `the ask failed: ${outcome.detail}`;
      target.dimensions.push({ dimension, status: "missing", detail });
      await event(task, "step_failed", `${probeRecord.symbol} ${INDEX_DIMENSION_LABELS[dimension]}: ${detail}`);
      continue;
    }

    // Account the spend from the receipt's authoritative amount (6-decimal
    // USDC units: 10000 uUSDC = 1 cent) — same discipline as the engine.
    const cents = Math.round(Number(outcome.receipt.amount_uusdc) / 10000);
    task.spend.spentUsdCents += cents;
    spendUsdCents += cents;
    task.spend.entries.push({
      ts: indexDeskDeps.now(),
      description: `Index desk: ${probeRecord.symbol} ${INDEX_DIMENSION_LABELS[dimension]} via Telegraph`,
      amountUsdCents: cents,
      source: "telegraph",
      receiptHash: outcome.receipt.receipt_hash,
      signalHash: outcome.signalHash,
    });
    await event(
      task,
      "spend_recorded",
      `Spent $${(cents / 100).toFixed(2)} on ${probeRecord.symbol} ${INDEX_DIMENSION_LABELS[dimension]} (task total $${(task.spend.spentUsdCents / 100).toFixed(2)} / $${(task.spend.limitUsdCents / 100).toFixed(2)})`,
      { amountUsdCents: cents, receiptHash: outcome.receipt.receipt_hash, signalHash: outcome.signalHash },
    );

    // Post-purchase analysis: keccak verification + the hash-committed payload.
    const bodyResult =
      outcome.result && typeof outcome.result === "object" && !Array.isArray(outcome.result)
        ? (outcome.result as Record<string, unknown>)
        : null;
    const analysis = await indexDeskDeps.analyze({
      dimension,
      signalHash: outcome.signalHash,
      bodyResult,
      asset,
    });
    const verified = analysis.verification.kind === "verified";
    const dimDetail =
      analysis.verification.kind === "verified"
        ? `verified: ${analysis.verification.note}`
        : analysis.verification.kind === "recorded"
          ? `recorded but not re-derived: ${analysis.verification.note}`
          : `recorded but not verified: ${analysis.verification.detail}`;
    const dim: CollectedDimension = {
      dimension,
      status: verified ? "verified" : "recorded",
      signalHash: outcome.signalHash,
      receiptHash: outcome.receipt.receipt_hash,
      costUsdCents: cents,
      disagreements: analysis.disagreements.length,
      detail: dimDetail,
    };
    if (dimension === "registry") {
      if (analysis.registry) {
        dim.registryFacts = analysis.registry.facts.map((f) => ({ field: f.field, value: f.value }));
        dim.registryMissing = [...analysis.registry.missing];
        const active = analysis.registry.facts.find((f) => f.field === "active");
        dim.registryActive = typeof active?.value === "boolean" ? active.value : null;
      }
    } else {
      if (analysis.value.present) dim.value = analysis.value.value;
      else dim.detail = `verified signal, but the committed answer carries no usable ${dimension} value: ${analysis.value.reason}`;
    }
    target.dimensions.push(dim);
    answeredAsks += 1;
    await event(
      task,
      "step_succeeded",
      `${probeRecord.symbol} ${INDEX_DIMENSION_LABELS[dimension]}: ${verified ? "verified" : "recorded"} (signal ${outcome.signalHash})${analysis.disagreements.length ? `, ${analysis.disagreements.length} disagreement(s) reported` : ""}.`,
      { signalHash: outcome.signalHash },
    );
  }

  outputs.indexDeskAsks = { collected, paidAsks, answeredAsks, spendUsdCents };

  if (paidAsks > 0 && answeredAsks === 0) {
    // Every planned ask failed: there is no partial proposal to salvage, and
    // the spend ledger tells the operator exactly what (if anything) settled.
    throw new Error(`every one of the ${paidAsks} paid ask(s) failed — see the per-ask diagnoses in the events; nothing is presented as data`);
  }
  await event(
    task,
    "step_succeeded",
    `Paid asks complete: ${answeredAsks}/${paidAsks} answered, $${(spendUsdCents / 100).toFixed(2)} spent. Assets with failed asks carry their evidence as missing, never as values.`,
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: index_report — deterministic proposal + completion           */
/* ------------------------------------------------------------------ */

export async function executeIndexReport(task: TaskRecord, stepTarget: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const baseline = outputs.indexDeskBaseline;
  const asks = outputs.indexDeskAsks;
  if (!baseline) throw new Error("index report ran without a baseline");
  guardedTransition(task, "verifying");
  await event(task, "verification_started", "Verifying the desk: weights must trace to recorded evidence, the ledger must reconcile, and every dimension must carry its honest status");

  const mode = baseline.mode;
  const collected = asks?.collected ?? baseline.definition.assets.map((definition_) => ({ definition: definition_, dimensions: [] as CollectedDimension[] }));
  const paidAsks = asks?.paidAsks ?? 0;
  const answeredAsks = asks?.answeredAsks ?? 0;
  const spendUsdCents = asks?.spendUsdCents ?? 0;

  const methodology = buildIndexProposal(baseline.definition, collected);
  const reasoning = buildIndexReasoning({
    definition: baseline.definition,
    mode,
    baseline: { probes: baseline.probes, plannedCostUsdCents: baseline.plannedCostUsdCents },
    methodology,
    approvedByHuman: task.events.some((e) => e.type === "plan_approved"),
    spendUsdCents,
    verifiedAsks: collected.reduce((n, a) => n + a.dimensions.filter((d) => d.status === "verified").length, 0),
    paidAsks,
  });

  const report: IndexDeskReport = {
    definition: baseline.definition,
    mode,
    baseline: { probes: baseline.probes, plannedCostUsdCents: baseline.plannedCostUsdCents },
    intelUsed: mode === "intel",
    methodology,
    assets: methodology.weightedAssets,
    missingDimensions: methodology.missingDimensions,
    reasoning,
    confidence: indexDeskConfidence({ mode, verifiedAsks: collected.reduce((n, a) => n + a.dimensions.filter((d) => d.status === "verified").length, 0), paidAsks }),
    generatedAt: indexDeskDeps.now(),
  };

  const evidence = collected.map((c) => ({
    kind: "index_asset_finding" as const,
    symbol: c.definition.symbol,
    issuer: c.definition.issuer.company,
    issuerJurisdiction: c.definition.issuer.jurisdiction,
    dimensions: c.dimensions.map((d) => ({
      dimension: d.dimension,
      status: d.status,
      ...(d.signalHash ? { signalHash: d.signalHash } : {}),
      ...(d.receiptHash ? { receiptHash: d.receiptHash } : {}),
      ...(d.costUsdCents !== undefined ? { costUsdCents: d.costUsdCents } : {}),
      ...(d.value !== undefined ? { value: d.value } : {}),
      detail: d.detail,
    })),
    totalCostUsdCents: c.dimensions.reduce((n, d) => n + (d.costUsdCents ?? 0), 0),
  }));

  // The invariants that matter, stated then enforced:
  if (report.mode === "free" && task.spend.entries.length > 0) {
    throw new Error("free-mode index desk recorded spend entries — impossible by construction");
  }
  if (methodology.proposal) {
    const universe = new Set(baseline.definition.assets.map((a) => a.symbol));
    const stray = methodology.proposal.weights.filter((w) => !universe.has(w.symbol));
    if (stray.length > 0) throw new Error(`proposal weights name assets outside the declared universe: ${stray.map((s) => s.symbol).join(", ")}`);
    for (const c of collected) {
      for (const d of c.dimensions) {
        if (d.status === "verified" && !d.signalHash) throw new Error(`${c.definition.symbol} ${d.dimension} is marked verified without a signal hash`);
      }
    }
  }
  if (task.criteria.reconcileLedgerEntries) {
    const ledgerSum = task.spend.entries.reduce((a, e) => a + e.amountUsdCents, 0);
    if (ledgerSum !== task.spend.spentUsdCents) {
      throw new Error(`spend ledger does not reconcile: entries sum ${ledgerSum}¢ vs recorded ${task.spend.spentUsdCents}¢`);
    }
    if (task.spend.entries.length !== answeredAsks) {
      throw new Error(`spend ledger has ${task.spend.entries.length} entries but ${answeredAsks} answered asks`);
    }
  }

  const parts: string[] = [];
  parts.push(
    methodology.proposal
      ? `INDEX RECONSTITUTION PROPOSAL for "${baseline.definition.name}" (${methodology.proposal.scheme} rule): ${methodology.proposal.weights
          .map((w) => `${w.symbol} ${w.weightPct.toFixed(2)}%`)
          .join(" · ")}. HHI ${methodology.proposal.concentration.hhi} (effective N ${methodology.proposal.concentration.effectiveN}).`
      : `NO WEIGHTING PROPOSED for "${baseline.definition.name}": ${methodology.proposalBlocker}`,
  );
  parts.push(`Coverage: ${mode === "intel" ? `${answeredAsks}/${paidAsks} paid asks verified against the signal registry, $${(spendUsdCents / 100).toFixed(2)} spent` : "free mode — declared inputs only, nothing purchased"}.`);
  const excluded = methodology.weightedAssets.filter((a) => a.status === "excluded");
  const provisional = methodology.weightedAssets.filter((a) => a.status === "provisional");
  if (excluded.length) parts.push(`Excluded: ${excluded.map((a) => a.symbol).join(", ")}.`);
  if (provisional.length) parts.push(`Provisional (issuer unverified): ${provisional.map((a) => a.symbol).join(", ")}.`);
  parts.push(`Missing-dimension ledger: ${methodology.missingDimensions.length} entries, including the dimensions the network cannot answer (circulating float, trading volumes).`);

  task.result = {
    summary: parts.join("\n"),
    indexDeskReport: report,
    evidence,
    completedAt: indexDeskDeps.now(),
  };
  await event(task, "verification_passed", `All desk invariants verified: weights trace to recorded evidence${mode === "intel" ? `, ledger reconciles ($${(spendUsdCents / 100).toFixed(2)})` : " (free mode, no ledger)"}, every dimension carries its honest status.`);
  guardedTransition(task, "completed");
  await event(task, "task_completed", "Index reconstitution complete.", { confidence: report.confidence, proposal: !!methodology.proposal });
  await event(task, "index_proposal_ready", `Proposal recorded for "${baseline.definition.name}" with ${methodology.weightedAssets.length} asset row(s) and ${methodology.missingDimensions.length} missing-dimension entries.`);
}
