import type { ExecutionEvent, TaskRecord } from "./types";

/**
 * Ledger reconciliation. Every delivered 200 from Telegraph produces a receipt
 * (accounted in a spend entry with receipt_hash, tx_hash and signal_hash).
 * Anything less is flagged, not hidden:
 *
 *  - consistent ledger: entry count matches the spend_recorded deliveries, each
 *    entry has all three hashes, and the entry sum equals spend.spentUsdCents.
 *  - uncertain outcomes: tasks where the network priced a request (402
 *    challenge) but no answer was delivered. Those are collectible-by-the-
 *    network events we cannot query from the client (the facilitator batches
 *    settlements); reconciliation surfaces them explicitly instead of
 *    pretending they are zero-cost.
 */

export interface LedgerReconciliation {
  entries: number;
  accountedCents: number;
  challengeAttempts: number;
  deliveredAnswers: number;
  uncertainPricedAttempts: number;
  problems: string[];
  consistent: boolean;
}

export function reconcileLedger(task: TaskRecord): LedgerReconciliation {
  const problems: string[] = [];
  const events = task.events as ExecutionEvent[];
  const entries = task.spend.entries;
  const challengeAttempts = events.filter((e) => e.type === "telegraph_challenge").length;
  const deliveredAnswers = events.filter((e) => e.type === "spend_recorded").length;

  for (const e of entries) {
    if (!e.receiptHash) problems.push(`spend entry at ${new Date(e.ts).toISOString()} lacks a receipt hash`);
    if (!e.txHash) problems.push(`spend entry at ${new Date(e.ts).toISOString()} lacks a settlement tx hash`);
    if (!e.signalHash) problems.push(`spend entry at ${new Date(e.ts).toISOString()} lacks a signal hash`);
    if (e.amountUsdCents !== Math.round(e.amountUsdCents) || e.amountUsdCents < 0) {
      problems.push(`spend entry at ${new Date(e.ts).toISOString()} has an invalid amount`);
    }
  }

  const sum = entries.reduce((acc, e) => acc + e.amountUsdCents, 0);
  if (sum !== task.spend.spentUsdCents) {
    problems.push(`ledger sum ${sum}¢ does not match accounted spend ${task.spend.spentUsdCents}¢`);
  }

  // Consistency rule: the event log records a "spend_recorded" delivery only
  // through the same accounting path that pushes the ledger entry, so the two
  // counts must move together. This guards against a future refactor logging a
  // delivery without a ledger entry (or vice versa).
  if (entries.length !== deliveredAnswers) {
    problems.push(
      `${entries.length} ledger entries but ${deliveredAnswers} recorded deliveries, the log and ledger disagree`,
    );
  }

  // Uncertain outcomes: the network priced (and may have settled) attempts that
  // never delivered an answer. Client-side data cannot disprove a settlement;
  // they are flagged for the human, never silently dropped.
  const uncertainPricedAttempts = Math.max(0, challengeAttempts - deliveredAnswers);

  return {
    entries: entries.length,
    accountedCents: sum,
    challengeAttempts,
    deliveredAnswers,
    uncertainPricedAttempts,
    problems,
    consistent: problems.length === 0,
  };
}
