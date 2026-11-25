import type { TaskRecord } from "@/lib/engine/types";
import {
  callerIdentity,
  bearerTokenOf,
  operatorCookieFromHeader,
  requestAuthorizedFromParts,
} from "@/lib/api/auth";

/**
 * Public read projection for task and investigation records.
 *
 * Before this gate, GET /api/tasks, GET /api/tasks/:id and
 * GET /api/mind/investigations handed EVERY record to ANY caller: objectives,
 * full event timelines, purchased intelligence (reports, reasoning, evidence),
 * Terminal request payloads and the spend ledger with receipt and signal
 * hashes. Those are the operator's private operational data.
 *
 * What stays public is genuinely DISCOVERY-level information: that a task
 * exists, its kind, its lifecycle state, when it ran and what it cost in
 * aggregate. Nothing that names objectives, carries purchased content, or
 * resolves to settlement proofs crosses this gate anonymously.
 */

/** True when a record carries private content that redaction removed. */
export function isRedactedTask(task: TaskRecord): boolean {
  return task.goal === "" && (task.plan === null || task.plan.length === 0) && task.events.length === 0;
}

/**
 * Discovery-level view of a task. The shape stays TaskRecord-compatible so
 * the console components keep compiling and rendering; private fields are
 * emptied (never partially present). Aggregate spend totals stay public —
 * they are the deployment's transparency claim — but the entries that carry
 * receipt hashes, signal hashes and per-payment details do not.
 */
export function publicTaskView(task: TaskRecord): TaskRecord {
  return {
    id: task.id,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    state: task.state,
    goal: "", // objective withheld
    plan: null, // plan steps name targets and capabilities
    events: [], // event timeline carries step results and hashes
    spend: {
      limitUsdCents: task.spend.limitUsdCents,
      spentUsdCents: task.spend.spentUsdCents,
      entries: [], // per-payment ledger: receiptHash, signalHash, payer, miner
    },
    permissions: {
      allowedActions: [],
      requiresApproval: false,
      maxRetries: 0,
    },
    criteria: {
      primaryVerifiedAgainstNodeSignal: false,
      answerSane: false,
      answerMaxAgeSeconds: 0,
      ownPaymentSettledOnChain: false,
      reconcileLedgerEntries: false,
    },
    result: null, // reports, reasoning, evidence
    error: null, // failure text can name internal steps
    origin: { source: task.origin.source }, // actor (telegram chat id) dropped
    jobType: task.jobType,
    // terminal (request body, offer, payer), watch (monitoring targets) and
    // labels are optional keys: omitted entirely rather than emptied.
  };
}

/** Read authorization for a route-handler Request: bearer token or operator session. */
export function readAuthorized(req: Request): boolean {
  return requestAuthorizedFromParts(bearerTokenOf(req), operatorCookieFromHeader(req.headers.get("cookie")));
}

/** Present tasks with the right fidelity for the caller's authorization.
 *
 * Identity-aware since multi-user: the operator sees everything; a signed-in
 * wallet user sees their OWN tasks in full (owner matches their session
 * address) and everyone else's tasks only as the public projection; an
 * anonymous caller sees only public projections, as before. */
export function tasksForCaller(req: Request, tasks: TaskRecord[]): { tasks: TaskRecord[]; redacted: boolean } {
  const identity = callerIdentity(req);
  if (identity.kind === "operator") return { tasks, redacted: false };
  if (identity.kind === "user") {
    const address = identity.address;
    return {
      tasks: tasks.map((t) => (t.owner?.toLowerCase() === address ? t : publicTaskView(t))),
      redacted: false,
    };
  }
  return { tasks: tasks.map(publicTaskView), redacted: true };
}

/** Single-task variant of tasksForCaller. */
export function taskForCaller(req: Request, task: TaskRecord): { task: TaskRecord; redacted: boolean } {
  const identity = callerIdentity(req);
  if (identity.kind === "operator") return { task, redacted: false };
  if (identity.kind === "user" && task.owner?.toLowerCase() === identity.address) {
    return { task, redacted: false };
  }
  return { task: publicTaskView(task), redacted: true };
}
