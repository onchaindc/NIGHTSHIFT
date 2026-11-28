import type { TaskRecord } from "@/lib/engine/types";
import { reconcileLedger, type LedgerReconciliation } from "@/lib/engine/ledger";
import { signalRecordMatchesAnswer } from "@/lib/engine/verify";
import type { SignalRecord } from "@/lib/telegraph/client";
import type { ChainReceipt } from "@/lib/chain/rpc";

/**
 * Independent task verification (founder mission #20).
 *
 * Re-checks a stored task's evidence against the network and the chain using
 * NIGHTSHIFT's EXISTING verification machinery — the Telegraph signal lookup
 * (`lookupSignal`), the accepted-answer matcher (`signalRecordMatchesAnswer`,
 * the same check the engine runs before a task may complete) and the public
 * chain receipt reader. Nothing here trusts a provider's own "verified"
 * label: the node's assertion is recorded, but never counted as proof.
 *
 * Missing or unverifiable evidence NEVER becomes a successful verification.
 * The verdict is:
 *   verified   — the task claims completion and every applicable check passed
 *                against live, independently fetched records.
 *   failed     — at least one check contradicts the stored evidence.
 *   unverified — nothing contradicts, but the evidence is insufficient to
 *                prove the claim (missing records, no reconstructible answer,
 *                a chain read that cannot be repeated). Reported honestly.
 */

export type EvidenceProvenance = "verified" | "verification_failed" | "unverified" | "missing" | "analysis";

export interface VerificationCheck {
  id: string;
  label: string;
  status: EvidenceProvenance;
  detail: string;
  signalHash?: string;
  txHash?: string;
}

export interface IndependentVerificationReport {
  taskId: string;
  taskState: string;
  /** The task's own claim: is it marked completed? */
  claimedComplete: boolean;
  verdict: "verified" | "failed" | "unverified";
  ledger: Pick<LedgerReconciliation, "consistent" | "entries" | "accountedCents" | "uncertainPricedAttempts" | "problems">;
  checks: VerificationCheck[];
  failures: string[];
  unresolvedGaps: string[];
  /** Labels the node/provider asserted about itself; never accepted as proof. */
  nodeAssertedLabels: string[];
  verifiedAt: string;
  note: string;
}

export interface VerifyTaskDeps {
  lookupSignal(signalHash: string): Promise<SignalRecord>;
  getTransactionReceipt(txHash: string, rpcUrl?: string): Promise<ChainReceipt>;
  now(): number;
}

const VERIFICATION_NOTE =
  "Independent re-verification: the task record was re-read and its evidence re-checked against the " +
  "Telegraph node's signal store and the public chain. A provider's own verified label is never accepted " +
  "as proof; anything that cannot be independently checked is reported as unverified, not as success.";

export function defaultVerifyTaskDeps(): VerifyTaskDeps {
  // Lazy imports keep the module usable in isolation (same pattern as engine.ts).
  return {
    lookupSignal: async (h) => {
      const { lookupSignal } = await import("@/lib/telegraph/client");
      return lookupSignal(h);
    },
    getTransactionReceipt: async (tx, rpcUrl) => {
      const { getTransactionReceipt } = await import("@/lib/chain/rpc");
      return getTransactionReceipt(tx, rpcUrl);
    },
    now: () => Date.now(),
  };
}

/** Truncation bound for report strings. */
const MAX_DETAIL = 500;

function clip(text: string, max = MAX_DETAIL): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`;
}

/** The answer the task accepted, when the record retains enough to re-check.
 *  Capability runs keep one committed response per dimension (checked
 *  individually against each dimension's own signal, in the main loop), so
 *  this helper only covers mind facts and generic goal summaries. */
function answerCandidateOf(task: TaskRecord): { kind: "mind" | "summary"; answer: unknown } | null {
  const result = task.result;
  if (!result) return null;
  if (result.mindReport?.intel?.facts?.length) {
    const facts = result.mindReport.intel.facts;
    return { kind: "mind", answer: facts };
  }
  // Generic goal tasks embed the accepted answer JSON after the miner line in
  // the result summary. When it survives truncation it can be re-checked.
  const summary = result.summary ?? "";
  const split = summary.indexOf("\n\n");
  if (split > 0) {
    const body = summary.slice(split + 2);
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object") return { kind: "summary", answer: parsed };
    } catch {
      // Truncated or non-JSON summary: nothing to compare — reported as a gap.
    }
  }
  return null;
}

function summaryAnswerObject(task: TaskRecord): Record<string, unknown> | null {
  const candidate = answerCandidateOf(task);
  if (candidate && candidate.kind === "summary" && candidate.answer && typeof candidate.answer === "object") {
    return candidate.answer as Record<string, unknown>;
  }
  return null;
}

/**
 * Build the full independent verification report for one stored task.
 * Read-only: this never mutates the task, its state or its ledger.
 */
export async function independentlyVerifyTask(
  task: TaskRecord,
  deps: VerifyTaskDeps = defaultVerifyTaskDeps(),
): Promise<IndependentVerificationReport> {
  const checks: VerificationCheck[] = [];
  const failures: string[] = [];
  const unresolvedGaps: string[] = [];
  const nodeAssertedLabels: string[] = [];
  const result = task.result;

  // 1. LEDGER RECONCILIATION (existing implementation, unchanged semantics).
  const ledger = reconcileLedger(task);
  checks.push({
    id: "ledger_reconciliation",
    label: "Spend ledger reconciliation (receipts, txs, signal hashes, sums)",
    status: ledger.consistent ? "verified" : "verification_failed",
    detail: ledger.consistent
      ? `Ledger reconciles: ${ledger.entries} entries, ${ledger.accountedCents} accounted cents${ledger.uncertainPricedAttempts > 0 ? `, ${ledger.uncertainPricedAttempts} priced attempt(s) delivered no answer (unknowable from the client)` : ""}.`
      : clip(`Ledger problems: ${ledger.problems.join("; ")}`),
  });
  if (!ledger.consistent) failures.push(`ledger does not reconcile: ${ledger.problems.join("; ")}`);

  // Collect the signal hashes the task claims, from every source it stores.
  const evidenceSignals: Array<{ signalHash: string; minerId: string; label: string; committed: Record<string, unknown> | null }> = [];
  for (const e of result?.evidence ?? []) {
    if (e.kind === "telegraph_signal") evidenceSignals.push({ signalHash: e.signalHash, minerId: e.minerId, label: "result evidence", committed: null });
  }
  if (result?.capabilityReport) {
    for (const d of result.capabilityReport.dimensions) {
      if (d.signalHash) {
        evidenceSignals.push({
          signalHash: d.signalHash,
          minerId: d.provider ?? "unknown",
          label: `capability dimension "${d.dimension}"`,
          committed: d.committed && Object.keys(d.committed).length > 0 ? d.committed : null,
        });
      }
    }
  }
  if (result?.mindReport?.intel?.signalHash) {
    evidenceSignals.push({
      signalHash: result.mindReport.intel.signalHash,
      minerId: result.mindReport.intel.miner ?? "unknown",
      label: "mind specialist ask",
      committed: null,
    });
  }

  const uniqueSignals = new Map<string, { signalHash: string; minerId: string; label: string; committed: Record<string, unknown> | null }>();
  for (const s of evidenceSignals) if (!uniqueSignals.has(s.signalHash)) uniqueSignals.set(s.signalHash, s);

  // 2. SIGNAL RECORDS: independently re-fetched from the node, never trusted
  //    from the task. Cross-checked against the ledger's own signal hashes.
  const ledgerSignals = new Set((task.spend?.entries ?? []).map((e) => e.signalHash).filter((h): h is string => !!h));

  for (const s of uniqueSignals.values()) {
    let record: SignalRecord | null = null;
    let lookupError: string | null = null;
    try {
      const fetched = await deps.lookupSignal(s.signalHash);
      const empty = fetched.result === undefined && fetched.payload === undefined && fetched.signal_hash === undefined;
      record = empty ? null : fetched;
    } catch (err) {
      lookupError = err instanceof Error ? err.message : String(err);
    }

    if (!record) {
      checks.push({
        id: `signal_record_${s.signalHash.slice(0, 12)}`,
        label: `Signal record for ${s.label}`,
        status: "missing",
        signalHash: s.signalHash,
        detail: lookupError
          ? clip(`the node did not serve this signal (${lookupError}); the purchase cannot be confirmed from the network`)
          : "the node serves no record for this signal hash; the purchase cannot be confirmed from the network",
      });
      failures.push(`no node record for signal ${s.signalHash}`);
      continue;
    }

    // The node's own assertion is recorded but never accepted as proof.
    if (record.verification?.verified === true) {
      nodeAssertedLabels.push(`node asserts signal ${s.signalHash.slice(0, 12)}… verified (algorithm ${record.verification.algorithm ?? "unknown"}) — not accepted as independent proof`);
    }

    if (s.committed) {
      // Capability runs keep the full committed response: the exact object the
      // engine's matcher originally verified can be re-derived and re-checked.
      const matches = signalRecordMatchesAnswer(record, s.committed);
      checks.push({
        id: `signal_committed_${s.signalHash.slice(0, 12)}`,
        label: `Committed answer for ${s.label} matches the node's recorded signal`,
        status: matches ? "verified" : "verification_failed",
        signalHash: s.signalHash,
        detail: matches
          ? "the stored committed response is materially recorded on the node for this signal hash (re-checked with the engine's accepted-answer matcher)"
          : "the node's record for this signal does NOT match the committed response we stored; refusing to verify",
      });
      if (!matches) failures.push(`committed response for signal ${s.signalHash} does not match the node's record`);
    } else if (result?.mindReport?.intel?.facts?.length) {
      // Mind investigations keep extracted facts: every fact value must appear
      // in the node's recorded material for the same signal.
      const facts = result.mindReport.intel.facts;
      const recorded = facts.filter((f) => signalRecordMatchesAnswer(record, f.value));
      const missing = facts.length - recorded.length;
      const status: EvidenceProvenance = missing === 0 ? "verified" : "verification_failed";
      checks.push({
        id: `signal_facts_${s.signalHash.slice(0, 12)}`,
        label: `Purchased facts for ${s.label} are recorded on the node`,
        status,
        signalHash: s.signalHash,
        detail:
          missing === 0
            ? `all ${facts.length} purchased fact value(s) appear in the node's recorded signal material`
            : clip(`${missing}/${facts.length} purchased fact value(s) are NOT present in the node's record for this signal; refusing to verify`),
      });
      if (missing > 0) failures.push(`${missing} purchased fact value(s) not recorded on the node for signal ${s.signalHash}`);
    } else {
      const parsed = summaryAnswerObject(task);
      if (parsed) {
        const matches = signalRecordMatchesAnswer(record, parsed);
        checks.push({
          id: `signal_answer_${s.signalHash.slice(0, 12)}`,
          label: `Accepted answer matches the node's recorded signal`,
          status: matches ? "verified" : "verification_failed",
          signalHash: s.signalHash,
          detail: matches
            ? "the answer reconstructed from the task's stored summary matches the node's record (engine matcher)"
            : "the node's record for this signal does NOT match the answer the task accepted; refusing to verify",
        });
        if (!matches) failures.push(`accepted answer for signal ${s.signalHash} does not match the node's record`);
      } else {
        checks.push({
          id: `signal_answer_${s.signalHash.slice(0, 12)}`,
          label: `Accepted answer matches the node's recorded signal`,
          status: "unverified",
          signalHash: s.signalHash,
          detail:
            "the node serves a record for this signal, but the task record does not retain the accepted answer verbatim (summary is truncated or not JSON), so the content cannot be re-checked here",
        });
        unresolvedGaps.push(`answer content for signal ${s.signalHash} is not reconstructible from the stored task record; the node record exists but equality was not re-proven`);
      }
    }

    if (!ledgerSignals.has(s.signalHash) && (task.spend?.entries?.length ?? 0) > 0) {
      checks.push({
        id: `signal_ledger_${s.signalHash.slice(0, 12)}`,
        label: `Signal ${s.signalHash.slice(0, 12)}… is accounted in the spend ledger`,
        status: "verification_failed",
        signalHash: s.signalHash,
        detail: "this signal hash appears in the task's evidence but in no spend-ledger entry; a delivered answer must have a ledger entry",
      });
      failures.push(`signal ${s.signalHash} is not accounted in the spend ledger`);
    }
  }

  // 3. ON-CHAIN SETTLEMENT: re-read from the public RPC, not from the task.
  for (const e of result?.evidence ?? []) {
    if (e.kind !== "on_chain_settlement") continue;
    let receipt: ChainReceipt | null = null;
    let error: string | null = null;
    try {
      receipt = await deps.getTransactionReceipt(e.txHash, e.rpcUrl);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (error) {
      checks.push({
        id: `chain_${e.txHash.slice(0, 12)}`,
        label: "On-chain settlement re-read",
        status: "unverified",
        txHash: e.txHash,
        detail: clip(`the chain read failed (${error}); the recorded settlement could not be re-proven right now`),
      });
      unresolvedGaps.push(`settlement tx ${e.txHash} could not be re-read on chain: ${error}`);
      continue;
    }
    if (!receipt || !receipt.found || receipt.status !== e.status) {
      checks.push({
        id: `chain_${e.txHash.slice(0, 12)}`,
        label: "On-chain settlement re-read",
        status: "verification_failed",
        txHash: e.txHash,
        detail: `the chain now reports tx status "${receipt?.status ?? "not_found"}" (found: ${receipt?.found ?? false}) but the task recorded status "${e.status}"`,
      });
      failures.push(`settlement tx ${e.txHash} no longer reads as recorded (chain status ${receipt?.status ?? "not_found"}, recorded ${e.status})`);
      continue;
    }
    const blockMatches = e.blockNumber === receipt.blockNumber;
    checks.push({
      id: `chain_${e.txHash.slice(0, 12)}`,
      label: "On-chain settlement re-read",
      status: blockMatches ? "verified" : "verification_failed",
      txHash: e.txHash,
      detail: blockMatches
        ? `tx re-read live from ${receipt.rpcUrl}: status "${receipt.status}" at block ${receipt.blockNumber}, matching the recorded evidence`
        : `tx is "${receipt.status}" but at block ${receipt.blockNumber}; the recorded block number was ${e.blockNumber}`,
    });
    if (!blockMatches) failures.push(`settlement tx ${e.txHash} block number changed from the recorded value`);
  }

  // 4. RECEIPT EVIDENCE vs LEDGER.
  for (const e of result?.evidence ?? []) {
    if (e.kind !== "telegraph_receipt") continue;
    const entry = (task.spend?.entries ?? []).find((s) => s.receiptHash === e.receiptHash);
    const amountMatches = !!entry && entry.amountUsdCents === e.amountUsdCents;
    checks.push({
      id: `receipt_${e.receiptHash.slice(0, 12)}`,
      label: "Telegraph receipt accounted in the ledger",
      status: amountMatches ? "verified" : "verification_failed",
      detail: amountMatches
        ? `receipt ${e.receiptHash.slice(0, 12)}… is accounted at ${e.amountUsdCents} cents, matching its ledger entry`
        : clip(`receipt ${e.receiptHash.slice(0, 12)}… is ${entry ? `accounted at ${entry.amountUsdCents} cents but the evidence claims ${e.amountUsdCents}` : "not accounted in any spend-ledger entry"}`),
    });
    if (!amountMatches) failures.push(`receipt ${e.receiptHash} is not correctly accounted in the spend ledger`);
  }

  // 5. FREE / NON-NETWORK EVIDENCE: recorded reads cannot be re-proven later.
  for (const e of result?.evidence ?? []) {
    if (e.kind === "chain_read" || e.kind === "public_source_lookup" || e.kind === "chain_gas_crosscheck") {
      checks.push({
        id: `recorded_read_${e.kind}`,
        label: `Recorded public read (${e.kind})`,
        status: "analysis",
        detail: "this evidence is a public read taken at execution time; re-reading now would return new market/network data, so the recorded value cannot be re-proven after the fact",
      });
      unresolvedGaps.push(`${e.kind} evidence cannot be independently re-proven after execution time`);
    }
  }

  // 6. CRITERIA THAT CANNOT BE RE-CHECKED POST HOC.
  const criteria = task.criteria;
  if ((criteria?.answerMaxAgeSeconds ?? 0) > 0) {
    unresolvedGaps.push("the freshness criterion (answerMaxAgeSeconds) was evaluated at execution time and cannot be re-proven later");
  }
  if (criteria?.expectedAsset || criteria?.expectedChain) {
    unresolvedGaps.push("the asset/chain attribution criteria were evaluated against the delivered answer at execution time");
  }
  if (uniqueSignals.size === 0 && !result?.evidence?.length) {
    unresolvedGaps.push("the task carries no evidence at all — there is nothing to independently verify");
  }

  const claimedComplete = task.state === "completed";
  const networkChecks = checks.filter((c) => c.status === "verified" && (c.id.startsWith("signal") || c.id.startsWith("chain") || c.id.startsWith("receipt")));
  const hasFailure = failures.length > 0;
  const verdict: IndependentVerificationReport["verdict"] = hasFailure
    ? "failed"
    : claimedComplete && networkChecks.length > 0 && ledger.consistent
      ? "verified"
      : "unverified";

  return {
    taskId: task.id,
    taskState: task.state,
    claimedComplete,
    verdict,
    ledger: {
      consistent: ledger.consistent,
      entries: ledger.entries,
      accountedCents: ledger.accountedCents,
      uncertainPricedAttempts: ledger.uncertainPricedAttempts,
      problems: ledger.problems.slice(0, 10),
    },
    checks,
    failures: failures.map((f) => clip(f, 300)),
    unresolvedGaps,
    nodeAssertedLabels,
    verifiedAt: new Date(deps.now()).toISOString(),
    note: VERIFICATION_NOTE,
  };
}
