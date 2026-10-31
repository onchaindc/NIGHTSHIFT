import { randomUUID } from "node:crypto";
import { getTask, saveTask } from "./store";
import { planForGoal, describeCriteria } from "./planner";
import { verifyTask, VerificationFailure } from "./verify";
import { extractGasGwei, extractUsdCost } from "./planner";
import { canTransition, type ActionId, type ExecutionEvent, type ExecutionEventType, type TaskRecord, type TaskState, type TelegraphAnswer, type Evidence, type PlanStep, type VerificationCriteria, type JobType, type WatchRef } from "./types";
import * as telegraph from "@/lib/telegraph/client";
import { executeWatchCheck, executeWatchCorroborate, executeWatchInvestigate, executeWatchDeliver, executeWatchReport } from "@/lib/watch/execute";
import type { WatchRunState } from "@/lib/watch/types";
import { getGasPrice, getTransactionReceipt } from "@/lib/chain/rpc";
import type { ChainReceipt, ChainGasPrice } from "@/lib/chain/rpc";
import type { SignalRecord } from "@/lib/telegraph/client";

/**
 * The shared task engine. Both the web API routes and the Telegram bot adapter
 * call these functions; it contains no transport-specific code.
 *
 * Invariants enforced here (asserted in tests):
 *  - No state transition outside ALLOWED_TRANSITIONS.
 *  - No purchase without a permission check ("telegraph.ask" allowed).
 *  - No read action without a permission check ("chain.read") — reads are
 *    permitted but never bypass the allowlist.
 *  - No payment signed when the 402 challenge exceeds the task's budget.
 *  - Failure classification drives recovery: only genuinely transient failed
 *    ATTEMPTS (nothing was paid) are retried. Paid responses that arrive
 *    unverifiable (malformed) are NEVER re-sent, so an uncertain outcome can
 *    never become a double charge.
 *  - No "completed" state without every success criterion verified.
 */

export interface ExecutionOutputs {
  primary?: TelegraphAnswer;
  settlement?: ChainReceipt & { txHash: string };
  crossCheck?: { evidence: Evidence };
  /** Protocol Watch run context, populated by watch_check. */
  watch?: WatchRunState;
  /** Free research evidence: a real public chain RPC read. */
  freeRead?: { chain: string; gasPriceWei: number; gasPriceGwei: number; rpcUrl: string };
  /** Free research evidence: a real public-source price lookup. */
  freeLookup?: { url: string; asset: string; priceUsd: number; fetchedAt: string };
}

export interface EngineDeps {
  telegraph: {
    askAuto(o: telegraph.AskOptions): Promise<TelegraphAnswer>;
    lookupSignal(signalHash: string): Promise<SignalRecord>;
  };
  chain: {
    getReceipt(txHash: string): Promise<ChainReceipt>;
    getGasPrice(chain: string): Promise<{ chain: string; gasPriceWei: number; gasPriceGwei: number; rpcUrl: string }>;
  };
  /** Free research: real reads of key-less public sources (price APIs). */
  publicSource: {
    fetchJSON(url: string): Promise<unknown>;
  };
  now: () => number;
  random?: () => number; // injectable backoff for tests; real jitter by default
}

export function defaultDeps(): EngineDeps {
  return {
    telegraph: {
      askAuto: (o) => telegraph.askAuto(o),
      lookupSignal: (h) => telegraph.lookupSignal(h),
    },
    chain: {
      getReceipt: (h) => getTransactionReceipt(h),
      getGasPrice: (c) => getGasPrice(c),
    },
    publicSource: {
      fetchJSON: async (url) => {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`public source returned HTTP ${res.status}`);
        return (await res.json()) as unknown;
      },
    },
    now: () => Date.now(),
  };
}

export class EngineError extends Error {}
export class BudgetExceededError extends EngineError {}
export class SettlementLookupError extends EngineError {}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function event(
  task: TaskRecord,
  type: ExecutionEventType,
  message: string,
  now: () => number,
  data?: Record<string, unknown>,
): void {
  const e: ExecutionEvent = { id: randomUUID(), ts: now(), type, message };
  if (data) e.data = data;
  task.events.push(e);
  task.updatedAt = now();
}

/* ------------------------------------------------------------------ */
/* State transitions (guarded) + permission boundary                   */
/* ------------------------------------------------------------------ */

function transition(task: TaskRecord, next: TaskState): void {
  if (!canTransition(task.state, next)) {
    throw new EngineError(`illegal task transition ${task.state} → ${next}`);
  }
  task.state = next;
}

/** Permission boundary: an action may only run if explicitly allowed for the task. */
export function hasPermission(task: TaskRecord, action: ActionId): boolean {
  return task.permissions.allowedActions.includes(action);
}

export function defaultSpendLimit(): number {
  const env = Number(process.env.NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS);
  return Number.isFinite(env) && env > 0 ? env : 100; // $1.00 default
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export interface CreateTaskInput {
  goal: string;
  spendLimitUsdCents?: number;
  requiresApproval?: boolean;
  origin: TaskRecord["origin"];
  /** How the planner may answer: "free" (public sources only, $0), "paid"
   * (explicit Telegraph purchase) or "auto" (legacy default). Defaults to
   * "auto" for callers that predate the mode concept. */
  mode?: "auto" | "free" | "paid";
  /** Overrides for job variants like Protocol Watch. When a plan is supplied
   * it replaces the deterministic goal planner entirely. */
  jobType?: JobType;
  watch?: WatchRef;
  plan?: PlanStep[];
  criteria?: VerificationCriteria;
  assumptions?: string[];
}

export async function createTask(input: CreateTaskInput, deps: EngineDeps = defaultDeps()): Promise<TaskRecord> {
  const goal = (input.goal || "").trim();
  if (!goal) throw new EngineError("goal is required");
  const limitUsdCents = Math.round(input.spendLimitUsdCents ?? defaultSpendLimit());
  if (!Number.isFinite(limitUsdCents) || limitUsdCents <= 0) {
    throw new EngineError("spend limit must be greater than zero");
  }

  const now = deps.now;
  const planned: { steps: PlanStep[]; criteria: VerificationCriteria | null; assumptions: string[]; executionBlocker?: string } =
    input.plan?.length
      ? { steps: input.plan, criteria: input.criteria ?? null, assumptions: input.assumptions ?? [] }
      : planForGoal(goal, limitUsdCents, input.mode ?? "auto");
  const steps = planned.steps;
  const criteria: VerificationCriteria = planned.criteria ?? {
    primaryVerifiedAgainstNodeSignal: false,
    answerSane: false,
    answerMaxAgeSeconds: 0,
    ownPaymentSettledOnChain: false,
    reconcileLedgerEntries: false,
  };
  // Execution goals (classified by the planner) stop before any step runs.
  const executionBlocker = input.plan?.length ? undefined : planned.executionBlocker;
  const assumptions = planned.assumptions;
  const task: TaskRecord = {
    id: randomUUID(),
    createdAt: now(),
    updatedAt: now(),
    state: "created",
    goal,
    plan: steps,
    events: [],
    spend: { limitUsdCents, spentUsdCents: 0, entries: [] },
    permissions: {
      allowedActions: ["telegraph.ask", "telegram.notify", "chain.read"],
      requiresApproval: input.requiresApproval ?? false,
      maxRetries: 2,
    },
    criteria,
    result: null,
    error: null,
    origin: input.origin,
    ...(input.jobType ? { jobType: input.jobType } : {}),
    ...(input.watch ? { watch: input.watch } : {}),
  };
  event(task, "goal_accepted", `Goal accepted with a spend limit of ${(limitUsdCents / 100).toFixed(2)} USD`, now);
  await saveTask(task);

  transition(task, "planning");
  event(
    task,
    "plan_created",
    executionBlocker
      ? "No execution plan was built: the goal asks for an external action this system cannot carry out (see the criteria note below)."
      : `Plan built: ${steps.map((s) => s.description).join(" → ")}`,
    now,
  );
  if (input.plan?.length) {
    // Job variants define their own verification semantics; state them plainly.
    event(
      task,
      "criteria_defined",
      `Success criteria (fixed before execution): every finding must restate what the monitored sources actually returned, source failures stay failures, unchanged sources produce no findings, and no more of the budget may be used than recorded receipts prove.`,
      now,
      { criteria },
    );
  } else {
    if (executionBlocker) {
      event(
        task,
        "criteria_defined",
        `Success criteria fixed before execution: the goal is an execution goal, so completing it requires evidence of the actual external action, a mined transaction receipt covering the action itself plus an independent outcome verification (for a swap or transfer, for example, the resulting balance change). An inference response, a payment receipt for AI inference, or a self-reported confidence score is NOT sufficient. No such evidence can be produced today, so the task stops before spending anything.`,
        now,
        { criteria },
      );
    } else {
    // Plan-aware by construction: a free plan can never state a purchase or
    // settlement requirement it will not exercise (describeCriteria derives
    // every line from the criteria actually set by the planner).
    const criteriaLines: string[] = describeCriteria(criteria);
    event(
      task,
      "criteria_defined",
      `Success criteria (fixed before execution): ${criteriaLines.join("; ")}.`,
      now,
      { criteria },
    );
    }
  }
  for (const a of assumptions) {
    event(task, "criteria_defined", `Planning assumption: ${a}`, now);
  }
  // Cost source labeling, fixed at creation (never switched behind the task's back).
  if (criteria.primarySource === "free") {
    event(
      task,
      "criteria_defined",
      `Cost: FREE (public sources and read-only chain RPC only). This operation never signs a payment and will spend $0.00.`,
      now,
    );
  } else if (steps.some((s) => s.kind === "telegraph_ask")) {
    event(
      task,
      "criteria_defined",
      `Cost: PAID intelligence (Telegraph). Requires TELEGRAPH_EVM_PRIVATE_KEY (a Base Sepolia wallet funded with test USDC). Maximum ${"$"}${(limitUsdCents / 100).toFixed(2)}; refused before signing if the network prices above what remains.`,
      now,
    );
  }
  await saveTask(task);

  // Execution goals stop here: without wallet/exchange/deployment integrations
  // they can never be honestly completed, so nothing runs and nothing is spent.
  if (executionBlocker) {
    transition(task, "blocked");
    event(task, "task_blocked", executionBlocker, now);
    task.error = executionBlocker;
    await saveTask(task);
    return task;
  }

  if (task.permissions.requiresApproval) {
    transition(task, "awaiting_approval");
    event(task, "approval_required", "Plan ready. Waiting for your approval before spending anything.", now);
    await saveTask(task);
  } else {
    transition(task, "executing");
    event(task, "plan_approved", "Approval not required, executing immediately", now);
    await saveTask(task);
  }
  return task;
}

/* ------------------------------------------------------------------ */
/* Approval flow                                                       */
/* ------------------------------------------------------------------ */

export async function approveTask(id: string, deps: EngineDeps = defaultDeps()): Promise<TaskRecord> {
  const task = await getTask(id);
  if (!task) throw new EngineError(`task ${id} not found`);
  transition(task, "executing");
  event(task, "plan_approved", "Plan approved by the user, execution begins", deps.now);
  await saveTask(task);
  return runPlan(task, deps);
}

export async function rejectTask(id: string, deps: EngineDeps = defaultDeps()): Promise<TaskRecord> {
  const task = await getTask(id);
  if (!task) throw new EngineError(`task ${id} not found`);
  transition(task, "rejected");
  event(task, "plan_rejected", "Plan rejected by the user, no actions were taken", deps.now);
  task.error = "plan rejected";
  await saveTask(task);
  return task;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export async function runTask(id: string, deps: EngineDeps = defaultDeps()): Promise<TaskRecord> {
  const task = await getTask(id);
  if (!task) throw new EngineError(`task ${id} not found`);
  if (task.state !== "executing") {
    throw new EngineError(`task ${id} is ${task.state}; runTask requires the executing state`);
  }
  return runPlan(task, deps);
}

async function runPlan(task: TaskRecord, deps: EngineDeps): Promise<TaskRecord> {
  await saveTask(task);
  const plan = task.plan ?? [];
  const outputs: ExecutionOutputs = {};

  for (const step of plan) {
    try {
      if (step.kind === "telegraph_ask") {
        outputs.primary = await executeTelegraphAsk(task, deps);
        if (task.state !== "executing") return task; // blocked during attempt
      } else if (step.kind === "watch_check") {
        await executeWatchCheck(task, deps, outputs);
        if (task.state !== "executing") return task;
      } else if (step.kind === "watch_corroborate") {
        await executeWatchCorroborate(task, deps, outputs);
        if (task.state !== "executing") return task;
      } else if (step.kind === "watch_investigate") {
        await executeWatchInvestigate(task, deps, outputs);
        if (task.state !== "executing") return task;
      } else if (step.kind === "watch_deliver") {
        await executeWatchDeliver(task, deps, outputs);
        if (task.state !== "executing") return task;
      } else if (step.kind === "watch_report") {
        await executeWatchReport(task, deps, outputs);
        if (task.state !== "executing") return task;
      } else if (step.kind === "free_chain_read") {
        outputs.freeRead = await executeFreeChainRead(task, deps);
        if (task.state !== "executing") return task;
      } else if (step.kind === "free_public_lookup") {
        outputs.freeLookup = await executeFreePublicLookup(task, deps, step);
        if (task.state !== "executing") return task;
      } else if (step.kind === "cross_check") {
        outputs.crossCheck = await executeCrossCheck(task, deps, outputs.primary ?? null);
        if (task.state !== "executing") return task;
      } else if (step.kind === "verify_settlement") {
        outputs.settlement = await executeSettlementCheck(task, deps, outputs.primary ?? null);
        if (task.state !== "executing") return task;
      } else if (step.kind === "verify_evidence") {
        transition(task, "verifying");
        event(task, "verification_started", "Verifying the goal outcome against all success criteria", deps.now);
        await saveTask(task);
        await verifyTask(task, outputs, deps);
        event(task, "verification_passed", "All criteria verified against recorded evidence", deps.now);
        transition(task, "completed");
        event(task, "task_completed", "Goal outcome verified. Task complete.", deps.now, {
          evidence: task.result?.evidence,
        });
        await saveTask(task);
        return task;
      }
    } catch (err) {
      if (err instanceof VerificationFailure) {
        event(task, "criteria_failed", `Success criterion not met: ${messageOf(err)}`, deps.now);
      }
      finishWithError(task, deps, err);
      await saveTask(task);
      return task;
    }
  }

  // Defensive: plan exhausted without a verify step.
  finishWithError(task, deps, new Error("plan exhausted without producing verified evidence"));
  await saveTask(task);
  return task;
}

/* ------------------------------------------------------------------ */
/* Recovery: failure classification → selected alternative             */
/* ------------------------------------------------------------------ */

type FailureCategory = "budget_refusal" | "missing_credentials" | "paid_outcome_unverifiable" | "transient";

function classifyFailure(err: unknown): { category: FailureCategory; diagnostic: string; retryable: boolean } {
  if (err instanceof telegraph.TelegraphBudgetExceededError) {
    return { category: "budget_refusal", diagnostic: messageOf(err), retryable: false };
  }
  if (err instanceof telegraph.TelegraphBlockedError) {
    return { category: "missing_credentials", diagnostic: messageOf(err), retryable: false };
  }
  if (err instanceof telegraph.TelegraphResponseIntegrityError) {
    return {
      category: "paid_outcome_unverifiable",
      diagnostic: `${messageOf(err)} A paid delivery may have settled, so re-sending could charge again. Refusing to retry.`,
      retryable: false,
    };
  }
  const msg = messageOf(err);
  const transient =
    /routing failed|HTTP 5\d\d|HTTP 4?\d\d request failed|ECONNRESET|ETIMEDOUT|network|abort|timeout|fetch failed|connection/i.test(
      msg,
    );
  if (transient) {
    return {
      category: "transient",
      diagnostic: `No payment was taken (only a delivered 200 settles). Detail: ${msg}`,
      retryable: true,
    };
  }
  // Unknown / deterministic errors: retrying would not improve the odds of an
  // honest outcome, so the task stops with the diagnosis recorded.
  return { category: "transient", diagnostic: msg, retryable: false };
}

async function withRecovery(
  task: TaskRecord,
  deps: EngineDeps,
  opName: string,
  op: () => Promise<TelegraphAnswer>,
): Promise<TelegraphAnswer> {
  const overall = { attempt: 0 };
  let lastError: unknown;
  let lastDiagnosis: { category: FailureCategory; diagnostic: string; retryable: boolean } | null = null;

  while (overall.attempt <= task.permissions.maxRetries) {
    if (overall.attempt > 0) event(task, "step_retried", `${opName}: attempt ${overall.attempt + 1}`, deps.now);
    try {
      return await op();
    } catch (err) {
      lastError = err;
      lastDiagnosis = classifyFailure(err);
      if (lastDiagnosis.category === "budget_refusal") {
        event(task, "spend_denied", `Purchase refused, ${lastDiagnosis.diagnostic}. No payment was signed.`, deps.now);
      }
      if (!lastDiagnosis.retryable) break;
      const backoffMs = 1500;
      event(
        task,
        "recovery_selected",
        `Failure diagnosis (${lastDiagnosis.category}): ${lastDiagnosis.diagnostic}. Selected alternative: wait ${backoffMs}ms and re-request, the router re-ranks miners live.`,
        deps.now,
        { category: lastDiagnosis.category, attempt: overall.attempt + 1, backoffMs },
      );
      overall.attempt++;
      await sleep(backoffMs);
    }
  }

  event(
    task,
    "step_failed",
    `${opName} failed after ${overall.attempt + 1} attempt(s): ${lastDiagnosis?.diagnostic ?? messageOf(lastError)}`,
    deps.now,
  );
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Step executors                                                      */
/* ------------------------------------------------------------------ */

async function executeTelegraphAsk(task: TaskRecord, deps: EngineDeps): Promise<TelegraphAnswer> {
  const now = deps.now;

  if (!hasPermission(task, "telegraph.ask")) {      event(task, "permission_denied", 'Action "telegraph.ask" is not in this task\'s allowed actions, so no purchase was attempted', now);
    throw new EngineError("permission denied: telegraph.ask");
  }

  const remainingUsdCents = task.spend.limitUsdCents - task.spend.spentUsdCents;
  if (remainingUsdCents <= 0) {
    event(task, "spend_denied", "Spending limit already exhausted, no purchase attempted", now);
    throw new BudgetExceededError("spend limit exhausted before purchase");
  }

  event(task, "step_started", "Purchasing intelligence from the Telegraph network", now);

  const answer = await withRecovery(task, deps, "telegraph purchase", async () =>
    deps.telegraph.askAuto({
      query: task.goal,
      remainingBudgetUsdCents: remainingUsdCents,
      onChallenge: (info) => {
        event(
          task,
          "telegraph_challenge",
          `Network priced the request at ${(info.amountUsdCents / 100).toFixed(2)} USD (${info.amountUsdCents}¢ units), budget${
            info.amountUsdCents > remainingUsdCents ? " exceeded" : " OK"
          }, then paid via x402`,
          now,
          { amountUsdCents: info.amountUsdCents },
        );
      },
    }),
  );

  // Account the spend from the receipt's authoritative amount (6-decimal USDC
  // units: 10000 uUSDC = 1 cent).
  const cents = answer.receipt?.amount_uusdc
    ? Math.round(Number(answer.receipt.amount_uusdc) / 10000)
    : Math.round((answer.costUsd ?? 0) * 100);
  task.spend.spentUsdCents += cents;
  task.spend.entries.push({
    ts: now(),
    description: `Telegraph answer (${answer.minerName ?? answer.minerId})`,
    amountUsdCents: cents,
    source: "telegraph",
    receiptHash: answer.receipt?.receipt_hash,
    txHash: answer.receipt?.tx_hash,
    signalHash: answer.signalHash ?? undefined,
  });
  event(
    task,
    "spend_recorded",
    `Spent ${(cents / 100).toFixed(2)} USD on a Telegraph answer (budget now ${(task.spend.spentUsdCents / 100).toFixed(2)} / ${(task.spend.limitUsdCents / 100).toFixed(2)})`,
    now,
    {
      amountUsdCents: cents,
      receiptHash: answer.receipt?.receipt_hash,
      signalHash: answer.signalHash,
      txHash: answer.receipt?.tx_hash,
      minerId: answer.minerId,
    },
  );
  event(task, "step_succeeded", `Answer received from ${answer.minerName ?? answer.minerId} (signal ${answer.signalHash})`, now);
  return answer;
}

/** Free, read-only real action: independently confirm our payment settled on-chain. */
async function executeSettlementCheck(
  task: TaskRecord,
  deps: EngineDeps,
  primary: TelegraphAnswer | null,
): Promise<ExecutionOutputs["settlement"]> {
  const now = deps.now;

  if (!hasPermission(task, "chain.read")) {
    event(task, "permission_denied", 'Action "chain.read" is not in this task\'s allowed actions, settlement check skipped', now);
    throw new SettlementLookupError("permission denied: chain.read");
  }

  const txHash = primary?.receipt?.tx_hash;
  if (!txHash) {
    throw new SettlementLookupError(
      "the purchase returned no settlement transaction hash, so the on-chain settlement cannot be independently confirmed",
    );
  }

  event(task, "action_started", `Check chosen next action: read OUR OWN payment settlement ${txHash.slice(0, 18)}… on the public Base Sepolia RPC (free, read-only)`, now);

  let lastError: unknown;
  let lastDiagnosis: { diagnostic: string; retryable: boolean } | null = null;
  let attempts = 1;
  let receipt: ChainReceipt | null = null;

  for (let attempt = 0; attempt <= task.permissions.maxRetries; attempt++) {
    try {
      receipt = await deps.chain.getReceipt(txHash);
      lastDiagnosis = null;
      break;
    } catch (err) {
      lastError = err;
      // A failed RPC READ is transient by definition (no spend, just network).
      lastDiagnosis = {
        diagnostic: `settlement lookup failed (read-only, no payment involved): ${messageOf(err)}`,
        retryable: attempt < task.permissions.maxRetries,
      };
      if (lastDiagnosis.retryable) {
        event(
          task,
          "recovery_selected",
          `Failure diagnosis (transient): ${lastDiagnosis.diagnostic}. Selected alternative: wait 1500ms and re-read the chain.`,
          deps.now,
          { category: "transient", attempt: attempt + 1, backoffMs: 1500 },
        );
        attempts++;
        await sleep(1500);
      }
    }
  }

  if (!receipt) {
    event(task, "step_failed", `Settlement check failed: ${lastDiagnosis?.diagnostic ?? messageOf(lastError)}`, deps.now);
    throw new SettlementLookupError(lastDiagnosis?.diagnostic ?? messageOf(lastError));
  }

  event(
    task,
    "step_succeeded",
    `Chain read complete: tx ${txHash.slice(0, 18)}… status ${receipt.status}${receipt.blockNumber ? `, block ${receipt.blockNumber}` : ""}, read directly from the chain rather than taken from a miner`,
    deps.now,
  );
  return { ...receipt, txHash };
}

/**
 * Real cross-check action, INFORMED by the paid answer: the purchased gas
 * telemetry is compared against live figures read from our own public RPC for
 * the chain the goal (or the answer itself) points at. The check is evidence,
 * not trust: a miner's numbers are only usable when they agree with chain data
 * within the criteria's tolerance.
 */
async function executeCrossCheck(
  task: TaskRecord,
  deps: EngineDeps,
  primary: TelegraphAnswer | null,
): Promise<ExecutionOutputs["crossCheck"]> {
  const now = deps.now;

  if (!hasPermission(task, "chain.read")) {
    event(task, "permission_denied", 'Action "chain.read" is not in this task\'s allowed actions, cross-check skipped', now);
    throw new EngineError("permission denied: chain.read");
  }
  if (!primary) {
    throw new EngineError("the cross-check step requires the purchased answer, which is missing");
  }

  const chain = task.criteria.expectedChain ?? "base";
  event(
    task,
    "action_started",
    `Reading live gas telemetry for ${chain} from our own public RPC to cross-check the purchased answer (free, read-only)`,
    now,
  );

  const chainGas = await retryRead(task, deps, "chain gas read", () => deps.chain.getGasPrice(chain));
  const answerGwei = extractGasGwei(primary.answer);
  if (answerGwei === null) {
    throw new EngineError(
      `the purchased answer carries no gwei-labeled gas figure comparable with the chain read, so this was treated as a generic lookup rather than goal-specific evidence`,
    );
  }

  const tolerance = task.criteria.agreementToleranceRatio ?? 0.5;
  const relativeDeviation = Math.abs(answerGwei - chainGas.gasPriceGwei) / Math.max(Math.abs(chainGas.gasPriceGwei), 1e-9);
  const agreed = relativeDeviation <= tolerance;

  event(
    task,
    "step_succeeded",
    `Cross-check: purchased telemetry ${answerGwei} gwei vs our own chain read ${chainGas.gasPriceGwei.toFixed(6)} gwei (${(relativeDeviation * 100).toFixed(1)}% deviation, tolerance ${(tolerance * 100).toFixed(0)}%), ${agreed ? "AGREE" : "DISAGREE"}`,
    now,
    { chainGasGwei: chainGas.gasPriceGwei, answerGasGwei: answerGwei, relativeDeviation, agreed },
  );

  return {
    evidence: {
      kind: "chain_gas_crosscheck",
      chain,
      chainGasGwei: chainGas.gasPriceGwei,
      answerGasGwei: answerGwei,
      toleranceRatio: tolerance,
      agreed,
      rpcUrl: chainGas.rpcUrl,
    },
  };
}

/* ------------------------------------------------------------------ */
/* FREE research executors: real public reads, $0 spent, no payments    */
/* ------------------------------------------------------------------ */

/** Genuine free action: read live gas telemetry from the chain's public RPC. */
async function executeFreeChainRead(task: TaskRecord, deps: EngineDeps): Promise<ExecutionOutputs["freeRead"]> {
  const now = deps.now;
  if (!hasPermission(task, "chain.read")) {
    event(task, "permission_denied", 'Action "chain.read" is not in this task\'s allowed actions, so no chain read was performed', now);
    throw new EngineError("permission denied: chain.read");
  }
  const chain = task.criteria.freeChainRead ?? task.criteria.expectedChain ?? "base";
  event(task, "step_started", `Free read: live gas price for ${chain} from a public read-only RPC`, now);
  const read = await retryRead(task, deps, `gas read for ${chain}`, () => deps.chain.getGasPrice(chain));
  event(
    task,
    "step_succeeded",
    `Free read complete: ${chain} gas price is ${read.gasPriceGwei.toFixed(6)} gwei (${read.gasPriceWei} wei), read from ${read.rpcUrl} at no cost`,
    now,
    { chain: read.chain, gasPriceGwei: read.gasPriceGwei, rpcUrl: read.rpcUrl },
  );
  return { chain: read.chain, gasPriceWei: read.gasPriceWei, gasPriceGwei: read.gasPriceGwei, rpcUrl: read.rpcUrl };
}

/** Genuine free action: read a public, key-less price source for one asset. */
async function executeFreePublicLookup(
  task: TaskRecord,
  deps: EngineDeps,
  step: PlanStep,
): Promise<ExecutionOutputs["freeLookup"]> {
  const now = deps.now;
  if (!step.target) {
    // A malformed plan is an engine bug, not a transient failure: never guess a source.
    throw new EngineError("free public lookup step carries no target asset; refusing to guess a price source");
  }
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(step.target)}&vs_currencies=usd`;
  event(task, "step_started", `Free read: ${step.target} USD price from a public key-less price source`, now);
  const body = (await retryRead(task, deps, "public price read", () => deps.publicSource.fetchJSON(url))) as Record<string, unknown>;
  const entry = body?.[step.target] as { usd?: unknown } | undefined;
  const price = Number(entry?.usd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new EngineError(
      `the public price source returned no usable USD figure for ${step.target} (${JSON.stringify(entry)}); reporting the read as failed instead of inventing a price`,
    );
  }
  const fetchedAt = new Date(now()).toISOString();
  event(task, "step_succeeded", `Free read complete: ${step.target} USD price is $${price} (public source, no account, no payment)`, now, {
    url,
    priceUsd: price,
  });
  return { url, asset: step.target, priceUsd: price, fetchedAt };
}

async function retryRead<T>(task: TaskRecord, deps: EngineDeps, name: string, op: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= task.permissions.maxRetries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (attempt < task.permissions.maxRetries) {
        event(
          task,
          "recovery_selected",
          `Failure diagnosis (transient, read-only): ${name} failed, ${messageOf(err)}. Selected alternative: wait 1500ms and re-read.`,
          deps.now,
          { category: "transient", attempt: attempt + 1, backoffMs: 1500 },
        );
        await sleep(1500);
      }
    }
  }
  event(task, "step_failed", `${name} failed: ${messageOf(lastError)}`, deps.now);
  throw new SettlementLookupError(`${name} failed: ${messageOf(lastError)}`);
}

/* ------------------------------------------------------------------ */
/* Terminal handling                                                   */
/* ------------------------------------------------------------------ */

function finishWithError(task: TaskRecord, deps: EngineDeps, err: unknown): void {
  const message = messageOf(err);
  if (err instanceof telegraph.TelegraphBlockedError) {
    transition(task, "blocked");
    event(task, "task_blocked", message, deps.now, { missingEnvKeys: err.missingEnvKeys });
    task.error = `blocked: ${message}`;
    return;
  }
  if (err instanceof EngineError) {
    transition(task, "failed");
    event(task, "task_failed", message, deps.now);
    task.error = message;
    return;
  }
  transition(task, "failed");
  event(task, "task_failed", `Execution failed: ${message}`, deps.now);
  task.error = message;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
