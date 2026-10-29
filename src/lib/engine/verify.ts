import { randomUUID } from "node:crypto";
import type { Evidence, TaskRecord } from "./types";
import type { EngineDeps, ExecutionOutputs } from "./engine";
import { reconcileLedger } from "./ledger";
import { extractUsdCost } from "./planner";
import type { SignalRecord } from "@/lib/telegraph/client";

/**
 * Criteria-based verification. The task's VerificationCriteria are defined
 * BEFORE execution; this module checks them against the strongest REAL
 * evidence available and can evaluate to "failed" regardless of how much was
 * spent. A paid answer alone never completes a goal.
 *
 * Checks performed per configured criterion:
 *  1. primaryVerifiedAgainstNodeSignal — the node serves a record for the
 *     answer's signal hash and its recorded result structurally equals the
 *     answer we accepted.
 *  2. answerSane — intent-aware plausibility (for price data: a positive
 *     finite number; for general answers: non-empty shape).
 *  3. answerMaxAgeSeconds — the on-node record's creation time is within the
 *     defined freshness window (missing timestamp ⇒ cannot verify ⇒ fail).
 *  4. ownPaymentSettledOnChain — OUR purchase's settlement tx exists on the
 *     public Base Sepolia RPC with success status (read locally, not taken
 *     from any miner).
 *
 * The strongest verified failure evidence we saw live: a paid miner claimed a
 * settlement tx was "not found" while the local chain read showed status
 * success — verification must side with the checkable record.
 */

export class VerificationFailure extends Error {}

/** Structural equality: strict on values and array order, agnostic to key order. */
function canonicalEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => canonicalEqual(x, b[i]));
  }
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  const keysA = Object.keys(oa);
  const keysB = Object.keys(ob);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => k in ob && canonicalEqual(oa[k], ob[k]));
}

/** Places where the live signal record carries the answer the client received. */
function candidateResults(record: SignalRecord): unknown[] {
  const result = record.result as { execution?: { result?: unknown } } | undefined;
  const payload = record.payload as { response?: unknown } | undefined;
  return [result?.execution?.result, record.result, payload?.response].filter((x) => x !== undefined);
}

function fail(msg: string): never {
  throw new VerificationFailure(msg);
}

export async function verifyTask(
  task: TaskRecord,
  outputs: ExecutionOutputs,
  deps: EngineDeps,
): Promise<void> {
  const criteria = task.criteria;
  const c = deps.now;
  const evidence: Evidence[] = [];

  // Defense in depth: an execution goal (swap, deployment, transfer...) can
  // only complete with third-party proof of the action itself. A purchased
  // answer, a payment receipt for AI inference, or a self-reported confidence
  // score can never satisfy this, so verification refuses outright.
  if (criteria.requiresExecutionEvidence) {
    fail(
      "the goal requires evidence of an actual external action (a transaction receipt plus an independent outcome verification) that no current integration can produce, so the task cannot be verified as complete", 
    );
  }

  if (!outputs.primary?.signalHash) {
    fail("no verifiable evidence: execution produced no Telegraph signal hash");
  }
  const signalEvidence: Evidence = {
    kind: "telegraph_signal",
    signalHash: outputs.primary!.signalHash!,
    minerId: outputs.primary!.minerId,
  };

  // 1 + 3: answer must match the node's record, and be fresh.
  const record = await deps.telegraph.lookupSignal(signalEvidence.signalHash);
  if (criteria.primaryVerifiedAgainstNodeSignal) {
    if (!record || (record.result === undefined && record.payload === undefined && record.signal_hash === undefined)) {
      fail(`the node returned no record for signal ${signalEvidence.signalHash}`);
    }
    if (!candidateResults(record).some((x) => canonicalEqual(x, outputs.primary!.answer))) {
      fail("the answer recorded on the node does not match the answer returned to us, refusing to verify");
    }
  }

  if (criteria.answerMaxAgeSeconds > 0) {
    const createdAt = (record.signal as { created_at?: string } | undefined)?.created_at;
    if (!createdAt) {
      fail("the node's signal record carries no creation timestamp, so answer freshness cannot be proven");
    }
    const answerMs = Date.parse(createdAt);
    if (!Number.isFinite(answerMs)) fail(`the node's timestamp is not a readable date: ${createdAt}`);
    const ageSeconds = (c() - answerMs) / 1000;
    if (ageSeconds < -30) fail("the node's signal record claims a creation time in the future");
    if (ageSeconds > criteria.answerMaxAgeSeconds) {
      fail(
        `the answer is ${Math.round(ageSeconds)}s old; the task requires evidence fresher than ${criteria.answerMaxAgeSeconds}s`,
      );
    }
  }

  // 2: intent-aware plausibility. The engine auto-routes intents; for numeric
  // price data require a positive finite amount, otherwise require a non-empty
  // answer shape. Verified against the REAL answer, never an expectation.
  const answer = outputs.primary!.answer as { data?: { amount?: unknown } };
  const numeric = answer?.data?.amount;
  if (answer && numeric !== undefined) {
    const n = Number(numeric);
    if (!Number.isFinite(n) || n <= 0) {
      fail(`the purchased answer is not plausible: amount ${JSON.stringify(numeric)} is not a positive finite number`);
    }
    if (criteria.answerSane && n > 10_000_000) {
      fail(`the purchased answer failed the sanity ceiling: amount ${n} exceeds the plausible numeric bound`);
    }
  } else if (!answer || Object.keys(answer).length === 0) {
    fail("the purchased answer is empty; there is nothing verifiable to act on");
  }

  // GOAL-SPECIFIC criteria: a lookup only completes the goal that asked for it.
  if (criteria.expectedAsset && answer) {
    const assetMention = findLooseString(answer, criteria.expectedAsset);
    if (!assetMention) {
      fail(
        `the purchased answer is not about the requested asset: the goal named ${criteria.expectedAsset}, but the answer carries no matching symbol/asset field. A successful purchase would not complete this goal`,
      );
    }
  }
  if (criteria.expectedChain && answer) {
    const chainMention = findLooseString(answer, criteria.expectedChain!);
    if (!chainMention) {
      fail(
        `the purchased answer is not about the requested chain: the goal named ${criteria.expectedChain}, but the answer carries no matching chain field`,
      );
    }
  }

  evidence.push(signalEvidence);
  if (outputs.crossCheck) {
    evidence.push(outputs.crossCheck.evidence);
    if (outputs.crossCheck.evidence.kind === "chain_gas_crosscheck" && !outputs.crossCheck.evidence.agreed) {
      fail(
        `the purchased gas telemetry disagrees with our own chain read: ${outputs.crossCheck.evidence.answerGasGwei} gwei vs ${outputs.crossCheck.evidence.chainGasGwei} gwei (beyond ${(outputs.crossCheck.evidence.toleranceRatio * 100).toFixed(0)}% tolerance)`,
      );
    }
    // The goal's own threshold (e.g. "transfers under $0.05") is verified ONLY
    // from the purchased answer's own cost estimate — never assumed.
    if (criteria.maxFeeUsdFor21000Gas != null && answer) {
      const usdCost = extractUsdCost(answer);
      if (usdCost == null) {
        fail(
          `the goal requires a transfer fee under $${criteria.maxFeeUsdFor21000Gas}, but the purchased answer reports no USD cost estimate to check against`,
        );
      }
      if (usdCost > criteria.maxFeeUsdFor21000Gas) {
        fail(
          `the purchased telemetry reports a 21000-gas transfer costing $${usdCost}, which does not meet the goal's requirement of under $${criteria.maxFeeUsdFor21000Gas}. The goal is NOT achieved (nothing was fabricated to fit it)`,
        );
      }
    }
  }
  if (outputs.primary!.receipt) {
    evidence.push({
      kind: "telegraph_receipt",
      receiptHash: outputs.primary!.receipt!.receipt_hash,
      txHash: outputs.primary!.receipt!.tx_hash,
      amountUsdCents: Math.round((outputs.primary!.costUsd ?? 0) * 100),
    });
  }

  // 4: our own payment must be mined on-chain with success status. Refuses to
  // accept a miner's CLAIM about settlement (we saw such a claim be wrong).
  if (criteria.ownPaymentSettledOnChain) {
    const settlement = outputs.settlement;
    if (!settlement) {
      fail("the settlement step never produced a chain read, so on-chain payment confirmation is unproven");
    }
    if (settlement.status !== "success" || !settlement.blockNumber) {
      fail(
        `the payment settlement is not confirmed on-chain: tx ${settlement.txHash.slice(0, 18)}… status "${settlement.status}"${settlement.blockNumber ? ` at block ${settlement.blockNumber}` : ""}`,
      );
    }
    evidence.push({
      kind: "on_chain_settlement",
      txHash: settlement.txHash,
      status: settlement.status,
      blockNumber: settlement.blockNumber!,
      rpcUrl: settlement.rpcUrl,
    });
  }

  // LEDGER RECONCILIATION: receipts, txs, signal hashes and sums must tie out.
  if (criteria.reconcileLedgerEntries) {
    const rec = reconcileLedger(task);
    if (!rec.consistent) {
      fail(`the purchase ledger does not reconcile: ${rec.problems.join("; ")}`);
    }
    if (rec.uncertainPricedAttempts > 0) {
      // Flagged, not failed: the network may have collected for routing-failed
      // attempts that never delivered an answer. Client data cannot disprove it.
      task.events.push({
        id: randomUUID(),
        ts: c(),
        type: "criteria_check_passed",
        message: `Ledger reconciles; ${rec.uncertainPricedAttempts} priced attempt(s) delivered no answer, any settlement for those is unknowable from the client`,
      });
    }
  }

  const baseSummary = summarizeAnswer(outputs.primary!);
  const summary =
    criteria.goalIntent === "preparation"
      ? `Preparation material only. NIGHTSHIFT did not execute the underlying action; external execution remains unverified.\n\n${baseSummary}`
      : baseSummary;
  task.result = {
    summary,
    evidence,
    completedAt: c(),
  };
}

function summarizeAnswer(answer: TelegraphAnswerShape): string {
  const answerText = JSON.stringify(answer.answer, null, 2);
  const minerLine = [answer.minerName, `miner ${answer.minerId}`].filter(Boolean).join(" / ");
  return `${minerLine}\n\n${answerText.length > 4000 ? answerText.slice(0, 4000) + "…(truncated)" : answerText}`;
}

type TelegraphAnswerShape = { answer: Record<string, unknown>; minerId: string; minerName?: string };

/**
 * Loose key-or-value containment: the answer must actually mention the asset /
 * chain the goal requested (e.g. a symbol field "BTCUSDT" mentions "BTC"),
 * not merely be a successful purchase.
 */
function findLooseString(obj: unknown, needle: string): object | null {
  const lower = needle.toLowerCase();
  let matched: object | null = null;
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") {
      if (typeof node === "string" && node.toLowerCase().includes(lower)) matched = { found: true } as object;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.toLowerCase().includes(lower) && (typeof value === "number" || typeof value === "string")) {
        matched = { found: true } as object;
      }
      visit(value);
    }
  };
  visit(obj);
  return matched;
}
