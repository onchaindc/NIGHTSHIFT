/**
 * NIGHTSHIFT task engine — shared types.
 *
 * The engine is a plain TypeScript module: it imports nothing from Next.js,
 * so the same code serves the web app and the Telegram bot.
 */

/** All states a task moves through. Transitions are constrained by ALLOWED_TRANSITIONS. */
export type TaskState =
  | "created" // goal accepted, nothing yet planned
  | "planning" // building the plan
  | "awaiting_approval" // plan built, waiting for explicit user approval
  | "executing" // running plan steps (purchases happen here)
  | "verifying" // checking the result against real evidence
  | "completed" // result verified against evidence
  | "failed" // a step or verification failed outright
  | "rejected" // user rejected the plan
  | "blocked"; // cannot proceed (missing credentials/integration blockers)

/** Actions the engine may perform on the user's behalf. */
export type ActionId = "telegraph.ask" | "telegram.notify" | "chain.read";

/** Execution event types. `data` carries structured proof (hashes, amounts, errors). */
export type ExecutionEventType =
  | "goal_accepted"
  | "plan_created"
  | "criteria_defined"
  | "approval_required"
  | "plan_approved"
  | "plan_rejected"
  | "step_started"
  | "step_succeeded"
  | "step_failed"
  | "step_retried"
  | "recovery_selected"
  | "action_started"
  | "permission_denied"
  | "spend_denied"
  | "spend_recorded"
  | "telegraph_challenge"
  | "verification_started"
  | "verification_passed"
  | "verification_failed"
  | "criteria_failed"
  | "criteria_check_passed"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  // Protocol Watch lifecycle events
  | "watch_source_checked"
  | "watch_baseline"
  | "watch_change_detected"
  | "watch_paid_skipped"
  | "watch_report_ready"
  | "delivery_started"
  | "delivery_succeeded"
  | "delivery_failed"
  | "delivery_skipped";

export interface ExecutionEvent {
  id: string;
  ts: number; // unix ms
  type: ExecutionEventType;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Success criteria, fixed BEFORE execution. Measurable and checked against
 * real evidence; verification can never relax them.
 */
export interface VerificationCriteria {
  primaryVerifiedAgainstNodeSignal: boolean;
  answerSane: boolean;
  answerMaxAgeSeconds: number;
  ownPaymentSettledOnChain: boolean;
  /** Reconcile the purchase ledger (receipts, txs, hashes, sums) during verification. */
  reconcileLedgerEntries: boolean;
  /** The answer must concern this chain (from the goal text), when known. */
  expectedChain?: string;
  /** The answer must concern this asset (from the goal text), when known. */
  expectedAsset?: string;
  /** Cross-check the purchased answer against our own public chain RPC read. */
  crossCheckChainTelemetry?: boolean;
  /** Goal threshold like "transfers under $0.01" — verified from real evidence only. */
  maxFeeUsdFor21000Gas?: number;
  /** Max relative deviation allowed between the purchased answer and the chain read. */
  agreementToleranceRatio?: number;
}

export interface SpendEntry {
  ts: number;
  description: string;
  amountUsdCents: number;
  source: "telegraph";
  receiptHash?: string;
  txHash?: string;
  signalHash?: string;
}

export interface TaskPermissions {
  allowedActions: ActionId[];
  /** If true, the plan must be explicitly approved before any paid action runs. */
  requiresApproval: boolean;
  maxRetries: number;
}

export interface TaskResult {
  summary: string;
  /** Evidence backing the summary. A task is completed ONLY when evidence verifies. */
  evidence: Evidence[];
  completedAt: number;
}

export type Evidence =
  | { kind: "telegraph_signal"; signalHash: string; minerId: string }
  | { kind: "telegraph_receipt"; receiptHash: string; txHash?: string; amountUsdCents: number }
  | { kind: "on_chain_settlement"; txHash: string; status: string; blockNumber: number; rpcUrl: string }
  | {
      kind: "chain_gas_crosscheck";
      chain: string;
      chainGasGwei: number;
      answerGasGwei: number;
      toleranceRatio: number;
      agreed: boolean;
      rpcUrl: string;
    };

export type PlanStepKind =
  | "telegraph_ask"
  | "verify_settlement"
  | "cross_check"
  | "verify_evidence"
  // Protocol Watch steps
  | "watch_check"
  | "watch_investigate"
  | "watch_deliver"
  | "watch_report";

export interface PlanStep {
  id: string;
  kind: PlanStepKind;
  description: string;
  /** Estimated maximum cost in USD cents; the engine refuses to exceed the budget. */
  maxCostUsdCents?: number;
}

/**
 * Optional provenance for engine task variants. A task with no jobType is an
 * ordinary goal task. Protocol Watch tasks carry the watch reference so the
 * engine can pass watch context to the watch step executors.
 */
export interface WatchRef {
  watchId: string;
  watchName: string;
  /** Who or what triggered this check: "manual" or "auto-scheduler". */
  triggeredBy?: string | null;
  /** The telegram chat that receives the report, if configured. */
  telegramChatId?: string | number | null;
}

/** A task is either an ordinary goal or a protocol-watch check run. */
export type JobType = "goal" | "protocol_watch";

export interface TaskRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  state: TaskState;
  goal: string;
  plan: PlanStep[] | null;
  events: ExecutionEvent[];
  spend: {
    limitUsdCents: number;
    spentUsdCents: number;
    entries: SpendEntry[];
  };
  permissions: TaskPermissions;
  criteria: VerificationCriteria;
  result: TaskResult | null;
  /** Terminal failure/blocker explanation, machine-readable where possible. */
  error: string | null;
  origin: {
    source: "web" | "telegram";
    actor?: string; // telegram chat id, etc.
  };
  /** Task variant: "goal" (default) or software "protocol_watch". */
  jobType?: JobType;
  /** Set when jobType is protocol_watch; carries the watch run context. */
  watch?: WatchRef;
  /**
   * Optional provenance labels set outside the engine (e.g. "audit-rehearsal"
   * marking tasks created by the automated interaction audit). Labels never
   * change task state, spending, or approval.
   */
  labels?: string[];
}

/**
 * Legal state transitions, enforced by the engine. Any transition not listed
 * here is rejected (an invariant asserted in tests).
 */
export const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  created: ["planning", "blocked", "failed"],
  planning: ["awaiting_approval", "executing", "blocked", "failed"],
  awaiting_approval: ["executing", "rejected"],
  executing: ["verifying", "failed", "blocked"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: [],
  rejected: [],
  blocked: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: TaskState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export interface TelegraphAnswer {
  answer: Record<string, unknown>; // result read into the intent's shape
  minerId: string;
  minerName?: string;
  costUsd: number | null;
  signalHash: string | null;
  receipt: TelegraphReceipt | null;
}

/** Doc-confirmed shape of the X-TELEGRAPH-RECEIPT header (base64 JSON). */
export interface TelegraphReceipt {
  receipt_hash: string;
  rail: string;
  payer: string;
  miner: string;
  intent: string;
  amount_uusdc: string;
  epoch_id: number;
  settlement: string;
  chain: string;
  tx_hash?: string;
  timestamp: number;
}
