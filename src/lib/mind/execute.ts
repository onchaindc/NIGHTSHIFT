import { canTransition, type ExecutionEventType, type Evidence, type TaskRecord } from "@/lib/engine/types";
import { saveTask } from "@/lib/engine/store";
import { debitCreditsForRun } from "@/lib/wallet/credits";
import type { ExecutionOutputs } from "@/lib/engine/engine";
import {
  analyzeCounterparty,
  probeCounterparty,
  type CounterpartyRequest,
} from "@/lib/counterparty/intel";
import { executeAsk, unionRails, type ApprovedRail, type ExecuteInput, type ExecuteOutcome } from "@/lib/terminal/ask";
import type { LegalIdentity } from "@/lib/counterparty/intel";
import {
  MINDS_BUILDER_ENDPOINT,
  mindsBuilderAlias,
  notifyMindReport,
  reportMessage,
} from "./builder";
import {
  awaitAndRecordMindReply,
  captureSendFingerprint,
  receiveMindReply,
} from "./builder-receive";
import {
  buildBaseline,
  buildComparison,
  buildIntelResult,
  buildReasoning,
  mindFieldLabel,
  type MindBaseline,
  type MindEntity,
  type MindIntelResult,
  type MindInvestigationReport,
} from "./report";

/**
 * Mind investigation step executors. Imported by the task engine and
 * dispatched by runPlan for plan steps of kind mind_baseline /
 * counterparty_ask / mind_report.
 *
 * Invariants (mirroring the Counterparty flow, never re-built):
 *  - mind_baseline is FREE: probeCounterparty only — the node validates and
 *    prices the pinned ask; nothing is signed here, ever.
 *  - counterparty_ask is PAID and runs only because the human approved the
 *    plan (the engine's approval gate). executeAsk re-reads the live challenge
 *    and refuses on drift; the purchase is ONE attempt with no retry — a bare
 *    refusal after signing is a terminal outcome, never a re-charge.
 *  - mind_report reads only recorded evidence; facts come from the
 *    hash-committed payload; only a keccak-verified purchase counts toward
 *    the with/without-Telegraph comparison.
 */

/* ------------------------------------------------------------------ */
/* Injectable runner deps (tests override; production uses defaults)   */
/* ------------------------------------------------------------------ */

export interface MindRunnerDeps {
  probe: typeof probeCounterparty;
  execute: (input: ExecuteInput) => Promise<ExecuteOutcome>;
  analyze: typeof analyzeCounterparty;
  notify: typeof notifyMindReport;
  /** Two-way round trip: bounded reply wait on the bound conversation. */
  receive: typeof receiveMindReply;
  now: () => number;
}

async function defaultExecute(input: ExecuteInput): Promise<ExecuteOutcome> {
  return executeAsk(input);
}

export const mindDeps: MindRunnerDeps = {
  probe: (req) => probeCounterparty(req),
  execute: defaultExecute,
  analyze: (signalHash, bodyResult, request) => analyzeCounterparty(signalHash, bodyResult, request),
  notify: (input, fetchImpl) => notifyMindReport(input, fetchImpl),
  receive: (request) => receiveMindReply(request),
  now: () => Date.now(),
};

/** Test hook: replace the runner deps, restore with resetMindDeps(). */
export function setMindDeps(overrides: Partial<MindRunnerDeps>): void {
  Object.assign(mindDeps, overrides);
}
export function resetMindDeps(): void {
  mindDeps.probe = (req) => probeCounterparty(req);
  mindDeps.execute = defaultExecute;
  mindDeps.analyze = (signalHash, bodyResult, request) => analyzeCounterparty(signalHash, bodyResult, request);
  mindDeps.notify = (input, fetchImpl) => notifyMindReport(input, fetchImpl);
  mindDeps.receive = (request) => receiveMindReply(request);
  mindDeps.now = () => Date.now();
}

/* ------------------------------------------------------------------ */
/* Local helpers (same persistence discipline as the watch executors)  */
/* ------------------------------------------------------------------ */

async function event(task: TaskRecord, type: ExecutionEventType, message: string, data?: Record<string, unknown>): Promise<void> {
  const e: { id: string; ts: number; type: ExecutionEventType; message: string; data?: Record<string, unknown> } = {
    id: `${mindDeps.now()}-${Math.random().toString(36).slice(2)}`,
    ts: mindDeps.now(),
    type,
    message,
  };
  if (data) e.data = data;
  task.events.push(e);
  task.updatedAt = mindDeps.now();
  // Awaited: an un-awaited save races the engine's own saveTask on the same
  // file (observed as ENOENT on the atomic-rename tmp), so persistence here
  // is strictly sequential.
  await saveTask(task);
}

function guardedTransition(task: TaskRecord, next: Parameters<typeof canTransition>[1]): void {
  if (!canTransition(task.state, next)) {
    throw new Error(`illegal task transition ${task.state} → ${next}`);
  }
  task.state = next;
}

/** The entity this step operates on, from the plan step's target JSON. */
function entityOf(target: string | undefined): MindEntity | null {
  if (!target) return null;
  try {
    const parsed = JSON.parse(target) as { company?: unknown; jurisdiction?: unknown };
    if (typeof parsed.company !== "string" || !parsed.company.trim()) return null;
    return {
      company: parsed.company,
      ...(typeof parsed.jurisdiction === "string" && parsed.jurisdiction.trim()
        ? { jurisdiction: parsed.jurisdiction }
        : {}),
    };
  } catch {
    return null;
  }
}

function counterpartyRequest(entity: MindEntity): CounterpartyRequest {
  return { company: entity.company, ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}) };
}

/* ------------------------------------------------------------------ */
/* Step 1: mind_baseline — FREE                                        */
/* ------------------------------------------------------------------ */

export async function executeMindBaseline(task: TaskRecord, stepTarget: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const entity = entityOf(stepTarget);
  if (!entity) throw new Error("mind baseline ran without a parsed entity");
  const req = counterpartyRequest(entity);

  await event(task, "step_started", `Unpaid pre-flight for ${entity.company}: validating the specialist ask (nothing is signed at this stage)`);

  // The Mind settles through executeAsk, which signs the exact EVM rail with
  // the deployment payer key. The escrow rail needs a personal_sign
  // authorization from the user's wallet and belongs to the interactive
  // flows, so the autonomous run approves the offers it can actually pay.
  // The provider's backend pool alternates rail compositions per request
  // (observed live 2026-11-24: probes drew an Ethereum-Sepolia exact rail,
  // the paid request drew Base Sepolia), so the pre-flight probes TWICE and
  // the approval covers the UNION of the rails seen — displayed to the
  // approver. Execution then accepts any one of them, never anything else.
  const outcome = await mindDeps.probe(req, { preferEscrow: false });
  if (outcome.kind !== "challenge") {
    // fall through: the probe object below carries the failure verbatim
  }
  let rails = outcome.kind === "challenge" ? outcome.rails ?? [] : [];
  if (outcome.kind === "challenge") {
    try {
      const second = await mindDeps.probe(req, { preferEscrow: false });
      if (second.kind === "challenge") rails = unionRails(rails, second.rails ?? []);
    } catch {
      // The union stands on the first probe; the second is best-effort only.
    }
  }

  const probe =
    outcome.kind === "challenge"
      ? {
          status: "challenge" as const,
          priceUsd: outcome.priceUsd,
          offer: {
            scheme: outcome.approvedOffer.scheme,
            network: outcome.approvedOffer.network,
            asset: outcome.approvedOffer.asset,
            payTo: outcome.approvedOffer.payTo,
            amount: outcome.approvedOffer.amount,
          },
          rails,
          /** The FINAL ask params (identity-resolved); the paid step resends these verbatim. */
          params: outcome.body.params as Record<string, unknown>,
          resolvedIdentity: outcome.resolvedIdentity ?? null,
          specVariant: outcome.specVariant,
          intent: outcome.body.intent,
          miner: outcome.spec.minerId ?? "",
          detail: "the network validated the ask and returned the live x402 challenge",
        }
      : outcome.kind === "rejected"
      ? {
          status: "rejected" as const,
          intent: "",
          miner: "",
          rails: [] as ApprovedRail[],
          params: null as Record<string, unknown> | null,
          resolvedIdentity: null as LegalIdentity | null,
          detail: outcome.text || `the node refused the ask (HTTP ${outcome.status})`,
        }
      : {
          status: "unavailable" as const,
          intent: "",
          miner: "",
          rails: [] as ApprovedRail[],
          params: null as Record<string, unknown> | null,
          resolvedIdentity: null as LegalIdentity | null,
          detail: outcome.detail,
        };

  const baseline = buildBaseline(task.goal, entity, probe);
  outputs.mindBaseline = baseline;

  if (probe.status === "challenge") {
    const railsText = probe.rails
      .map((r) => `exact USDC on ${r.network} → ${r.payTo.slice(0, 10)}… ($${(Math.round(r.amountCents * 100) / 100).toFixed(2)})`)
      .join("; ");
    const identityText = probe.resolvedIdentity
      ? probe.specVariant === "identifier"
        ? ` The ask carries the resolved registry identifier — the LEI ${probe.resolvedIdentity.lei} (${probe.resolvedIdentity.legalName}, ${probe.resolvedIdentity.country}${probe.resolvedIdentity.status ? `, ${probe.resolvedIdentity.status}` : ""}) — because the pinned miner refuses name-only GLEIF searches (observed: SEARCH_TOO_BROAD / NOT_FOUND). The intent's param contract takes company + jurisdiction only, so the LEI rides in the company field.`
        : ` The ask targets the resolved legal identity ${probe.resolvedIdentity.legalName} (LEI ${probe.resolvedIdentity.lei}, ${probe.resolvedIdentity.country}${probe.resolvedIdentity.status ? `, ${probe.resolvedIdentity.status}` : ""}), resolved on GLEIF's free registry before anything is paid.`
      : "";
    await event(
      task,
      "mind_baseline_ready",
      `Without-intelligence dossier assembled: 0/${baseline.unknownFields.length} registry fields known from free sources. The specialist ask is routable at $${probe.priceUsd?.toFixed(2)} (${probe.miner}); the paid plan awaits the human approval gate.` +
        (railsText ? ` Approval covers ANY of the rails the node offered for this ask: ${railsText}.` : "") +
        identityText,
      { entity, priceUsd: probe.priceUsd },
    );
  } else {
    await event(
      task,
      "mind_baseline_ready",
      `Without-intelligence dossier assembled: 0/${baseline.unknownFields.length} registry fields known from free sources. The specialist ask is NOT purchasable right now (${probe.detail}).`,
      { entity },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Step 2: counterparty_ask — PAID (human-approved plan only)          */
/* ------------------------------------------------------------------ */

export async function executeCounterpartyAsk(
  task: TaskRecord,
  stepTarget: string | undefined,
  outputs: ExecutionOutputs,
): Promise<void> {
  const entity = entityOf(stepTarget);
  const baseline = outputs.mindBaseline;
  if (!entity || !baseline) throw new Error("counterparty ask ran before the baseline");

  // Permission boundary: same allowlist as any other purchase.
  if (!task.permissions.allowedActions.includes("telegraph.ask")) {
    await event(task, "permission_denied", 'Action "telegraph.ask" is not in this task\'s allowed actions, so no purchase was attempted');
    throw new Error("permission denied: telegraph.ask");
  }
  const remainingUsdCents = task.spend.limitUsdCents - task.spend.spentUsdCents;
  if (remainingUsdCents <= 0) {
    await event(task, "spend_denied", "Spending limit already exhausted, no purchase attempted");
    throw new Error("spend limit exhausted before purchase");
  }
  if (baseline.probe.status !== "challenge" || !baseline.probe.offer) {
    await event(task, "step_failed", `No approved offer to pay: the unpaid probe did not produce a purchasable challenge (${baseline.probe.detail}). Nothing was signed.`);
    throw new Error("no purchasable challenge from the unpaid probe");
  }

  await event(task, "step_started", `Paying for specialist intelligence on ${entity.company} — one attempt, no retry, live offer must match the approved one`);

  const outcome = await mindDeps.execute({
    spec: {
      intent: baseline.probe.intent,
      // The FINAL params from the pre-flight (identity-resolved legal name and
      // LEI when GLEIF resolved them): the paid request must be the exact one
      // the pre-flight validated and the human approved, not a rebuild from
      // the raw entity text.
      params: baseline.probe.params ?? { company: entity.company, ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}) },
      minerId: baseline.probe.miner || undefined,
    },
    approved: true,
    approvedOffer: baseline.probe.offer,
    approvedRails: baseline.probe.rails,
  });

  if (outcome.kind !== "answered") {
    // A drifted live offer is NOT terminal: never sign a rail the human did
    // not approve, but also do not fail a task whose only problem is that the
    // provider changed the offer between the pre-flight and the purchase.
    // Re-park at the approval gate so the fresh offer is approved deliberately.
    // Capped: two re-parks, then fail honestly instead of looping on a
    // provider that keeps changing rails.
    if (outcome.kind === "refused" && outcome.fresh?.kind === "challenge") {
      const reparks = task.events.filter((e) => e.type === "approval_drift_repark").length;
      if (reparks < 2) {
        guardedTransition(task, "awaiting_approval");
        await event(
          task,
          "approval_drift_repark",
          `The live offer drifted from the approved one (${outcome.reason}). Nothing was signed. The task is parked at the approval gate again; approving re-runs the plan with a fresh pre-flight that captures the live offer for review. ${2 - reparks} re-approval(s) remain before this fails outright.`,
        );
        return;
      }
    }
    // Every non-answer is terminal for this attempt; the product's invariant
    // is one paid attempt, no retry. Diagnose honestly and stop.
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
    // Conservative spend accounting: when the paid request reached the node
    // past payment verification (miner-side failure or unverifiable answer),
    // the settlement may have begun even though no receipt came back. The
    // approved amount is booked against the ceiling — the honest worst case —
    // while the refusal and bare-402 paths provably moved nothing.
    const settledAmbiguous = outcome.kind === "integrity" || (outcome.kind === "failed" && outcome.paymentSettled === true);
    if (settledAmbiguous) {
      const approvedCents = Math.round((baseline.probe.priceUsd ?? 0) * 100);
      if (approvedCents > 0 && task.spend.spentUsdCents + approvedCents <= task.spend.limitUsdCents) {
        task.spend.spentUsdCents += approvedCents;
        task.spend.entries.push({
          ts: mindDeps.now(),
          description: `Counterparty intelligence — payment settled but the ask failed (${entity.company}); booked conservatively`,
          amountUsdCents: approvedCents,
          source: "telegraph",
        });
        await debitCreditsForRun(task.owner, approvedCents, task.id, `Counterparty intelligence — payment settled but the ask failed (${entity.company}); booked conservatively`);
        await event(
          task,
          "spend_recorded",
          `A payment of up to $${(approvedCents / 100).toFixed(2)} may have settled on the failed ask (no receipt came back to prove otherwise); the approved amount is booked against the task's spend ceiling.`,
        );
      }
    }
    await event(task, "step_failed", `Specialist purchase did not complete: ${detail}`);
    throw new Error(detail);
  }

  // Account the spend from the receipt's authoritative amount (6-decimal
  // USDC units: 10000 uUSDC = 1 cent) — same discipline as the engine.
  const cents = Math.round(Number(outcome.receipt.amount_uusdc) / 10000);
  task.spend.spentUsdCents += cents;
  task.spend.entries.push({
    ts: mindDeps.now(),
    description: `Counterparty intelligence (${outcome.resultShape ? `${outcome.resultShape} via ` : ""}Telegraph)`,
    amountUsdCents: cents,
    source: "telegraph",
    receiptHash: outcome.receipt.receipt_hash,
    signalHash: outcome.signalHash,
  });
  await debitCreditsForRun(task.owner, cents, task.id, `Counterparty intelligence (${outcome.resultShape ? `${outcome.resultShape} via ` : ""}Telegraph)`);
  await event(
    task,
    "spend_recorded",
    `Spent $${(cents / 100).toFixed(2)} on specialist intelligence (budget now $${(task.spend.spentUsdCents / 100).toFixed(2)} / $${(task.spend.limitUsdCents / 100).toFixed(2)})`,
    { amountUsdCents: cents, receiptHash: outcome.receipt.receipt_hash, signalHash: outcome.signalHash },
  );

  // Post-purchase analysis: keccak verification + the hash-committed payload.
  const bodyResult =
    outcome.result && typeof outcome.result === "object" && !Array.isArray(outcome.result)
      ? (outcome.result as Record<string, unknown>)
      : null;
  const analysis = await mindDeps.analyze(outcome.signalHash, bodyResult, counterpartyRequest(entity));
  if (analysis.kind === "unverified") {
    await event(
      task,
      "step_succeeded",
      `Purchase recorded (signal ${analysis.signalHash}) but verification status is "${analysis.verification.kind}"; its content is reported and excluded from the comparison.`,
    );
    outputs.mindIntel = buildIntelResult({
      purchased: true,
      signalHash: analysis.signalHash,
      verificationStatus: analysis.verification.kind,
      costUsdCents: cents,
      receiptHash: outcome.receipt.receipt_hash,
      classification: null,
    });
    return;
  }

  await event(
    task,
    "step_succeeded",
    `Specialist answer verified (signal ${analysis.signalHash}); the hash-committed payload carries ${analysis.classification?.facts.length ?? 0} fact(s).`,
    { signalHash: analysis.signalHash },
  );
  outputs.mindIntel = buildIntelResult({
    purchased: true,
    signalHash: analysis.signalHash,
    verificationStatus: analysis.verification.kind,
    miner: outcome.resultShape ?? undefined,
    costUsdCents: cents,
    receiptHash: outcome.receipt.receipt_hash,
    classification: analysis.classification,
  });
}

/* ------------------------------------------------------------------ */
/* Step 3: mind_report — evidence evaluation + comparison + completion  */
/* ------------------------------------------------------------------ */

export async function executeMindReport(task: TaskRecord, stepTarget: string | undefined, outputs: ExecutionOutputs): Promise<void> {
  const entity = entityOf(stepTarget);
  guardedTransition(task, "verifying");
  await event(task, "verification_started", "Verifying the investigation: facts must trace to recorded evidence and the comparison must restate both passes");

  const baseline = outputs.mindBaseline ?? null;
  const intel = outputs.mindIntel;
  if (!baseline) throw new Error("mind report ran without a baseline dossier");
  if (task.plan?.some((s) => s.kind === "counterparty_ask") && !intel) {
    throw new Error("the plan purchased specialist intelligence but no intelligence result was recorded");
  }

  const intelUsed = !!intel?.purchased;
  const comparison = intel && intel.purchased ? buildComparison(baseline, intel) : undefined;
  const reasoning = buildReasoning({
    objective: task.goal,
    entity,
    baseline,
    ...(intel ? { intel } : {}),
    ...(comparison ? { comparison } : {}),
    approvedByHuman: task.events.some((e) => e.type === "plan_approved"),
  });

  const confidence: MindInvestigationReport["confidence"] = intel
    ? intel.verificationStatus === "verified"
      ? "signal-verified"
      : "unverified"
    : baseline.probe.status === "challenge"
    ? "routing-only"
    : "none";

  const report: MindInvestigationReport = {
    objective: task.goal,
    entity,
    intelUsed,
    baseline,
    ...(intel ? { intel } : {}),
    ...(comparison ? { comparison } : {}),
    reasoning,
    confidence,
    generatedAt: mindDeps.now(),
  };

  const evidence: Evidence[] = [
    {
      kind: "counterparty_finding",
      entity: baseline.entity.company,
      ...(baseline.entity.jurisdiction ? { jurisdiction: baseline.entity.jurisdiction } : {}),
      probeStatus: baseline.probe.status,
      ...(intel?.signalHash ? { signalHash: intel.signalHash } : {}),
      ...(intel?.receiptHash ? { receiptHash: intel.receiptHash } : {}),
      ...(intel?.costUsdCents !== undefined ? { costUsdCents: intel.costUsdCents } : {}),
      verificationStatus: intel?.verificationStatus ?? "none",
      facts: intel?.facts ?? [],
      missing: intel?.missing ?? [...baseline.unknownFields],
      ...(intel ? { disagreements: intel.disagreements } : {}),
    },
  ];

  // The one invariant that matters: a verified purchase must appear in the
  // comparison; an unverified one must not. Stated, then enforced.
  if (comparison && comparison.verified !== (intel?.verificationStatus === "verified")) {
    throw new Error("comparison invariant failed: verification status mismatch");
  }

  const summaryParts: string[] = [];
  summaryParts.push(
    intelUsed
      ? `INVESTIGATION COMPLETED for ${entity?.company ?? baseline.entity.company}: specialist intelligence purchased, verified, and compared against the intelligence-free baseline.`
      : `INVESTIGATION COMPLETED for ${entity?.company ?? baseline.entity.company} in free mode: no specialist intelligence was purchased; the report states exactly what remains unknown.`,
  );
  summaryParts.push(
    `Without Telegraph intelligence: 0/${baseline.unknownFields.length} registry fields known (routing knowledge only).`,
  );
  if (comparison) {
    summaryParts.push(
      comparison.verified
        ? `With specialist intelligence: ${comparison.fieldsKnownAfter}/${comparison.fieldsTotal} fields known for $${((comparison.costUsdCents ?? 0) / 100).toFixed(2)} (signal-verified).`
        : `With specialist intelligence: purchase unverified (${intel?.verificationStatus}); its content is excluded from the fact set.`,
    );
    if (comparison.remainingGaps.length > 0) {
      summaryParts.push(`Remaining gaps: ${comparison.remainingGaps.map(mindFieldLabel).join(", ")}.`);
    }
    if (comparison.conflicts.length > 0) {
      summaryParts.push(`Conflicts left unresolved: ${comparison.conflicts.map((x) => x.field).join(", ")}.`);
    }
  } else if (baseline.probe.status === "challenge") {
    summaryParts.push(`Specialist intelligence is available for this entity at $${baseline.probe.priceUsd?.toFixed(2)} per ask; it was not purchased.`);
  }

  task.result = {
    summary: summaryParts.join("\n"),
    mindReport: report,
    evidence,
    completedAt: mindDeps.now(),
  };
  await event(
    task,
    "verification_passed",
    `All report invariants verified: facts trace to ${intel?.signalHash ? `signal ${intel.signalHash}` : "the unpaid probe"}; comparison restates both passes.`,
  );
  guardedTransition(task, "completed");
  await event(task, "task_completed", "Mind investigation complete.", { confidence, intelUsed });

  // Optional Minds delivery, now two-way: best-effort, config-gated, never
  // hides a failure. The correlation fingerprint is captured BEFORE the send
  // (documented getLatestHistoryFingerprint → afterFingerprint), the reply
  // wait is bounded, and the whole round trip is persisted on the result.
  const alias = mindsBuilderAlias();
  const fingerprintBefore = await captureSendFingerprint(alias ?? "");
  const sentMessageText = reportMessage({ task, report });
  const delivery = await mindDeps.notify({ task, report });
  await event(
    task,
    delivery.ok ? "delivery_succeeded" : "delivery_skipped",
    delivery.ok
      ? `Investigation report delivered to the requesting Mind (${delivery.detail}).`
      : `Minds delivery skipped: ${delivery.detail}`,
  );
  await awaitAndRecordMindReply({
    task,
    notify: delivery,
    alias,
    fingerprintBefore,
    sentMessageText,
    receive: (request) => mindDeps.receive(request),
    now: mindDeps.now,
    event: (type, message, data) => event(task, type, message, data),
    persist: () => saveTask(task),
  });
}
