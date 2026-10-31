import { getTask, listTasks } from "@/lib/engine/store";
import { runTask, defaultDeps, type EngineDeps } from "@/lib/engine/engine";
import { persistence } from "@/lib/storage";
import type { PlanStepKind, TaskRecord } from "@/lib/engine/types";

/**
 * Abandoned-task recovery — accepted work must never silently die with the
 * instance that accepted it.
 *
 * The failure mode fixed here: a Telegram /goal is claimed (at-most-once) and
 * executed inside after() with a bounded duration. If the serverless instance
 * is frozen/killed mid-run, the task record stays `executing` forever, the
 * chat is left with "Working on it, live updates follow." and nothing else,
 * and because the webhook update was already claimed, no redelivery ever
 * happens. Without recovery the work is lost while the user waits.
 *
 * This module re-runs such tasks. SAFETY ANALYSIS for re-running:
 * - Only free-mode Telegram goal tasks are eligible: their plan steps are
 *   read-only public lookups / free chain reads, so replaying from the start
 *   of the plan performs the same public reads again and costs $0.
 * - Paid steps (`telegraph_ask`, and `verify_settlement` which only exists
 *   for paid research receipts) are NEVER auto-resumed: re-running a paid
 *   plan risks a second purchase. Those tasks stay `executing` and remain
 *   surveyable via /tasks; live progress can only come from a new run the
 *   user asks for.
 * - Eligibility requires the task to have been untouched (no event, no save)
 *   for a grace window — far longer than any free step legitimately takes —
 *   so a live runner is not mistaken for a dead one.
 * - A persistence-level task lease guards concurrent triggers (a webhook
 *   invocation and a cron tick cannot both re-run the same task).
 */

const LEASE_TTL_MS = 10 * 60_000;
const DEFAULT_IDLE_MS = 10 * 60_000;

/** Step kinds whose re-execution could spend money again. */
const PAID_STEP_KINDS: ReadonlySet<PlanStepKind> = new Set<PlanStepKind>(["telegraph_ask", "verify_settlement"]);

export interface RecoveryOptions {
  /** Engine deps for the re-run; defaults to real free-mode deps. */
  deps?: EngineDeps;
  /** How long a task must have been untouched before it is considered abandoned. */
  idleMs?: number;
  /** Injectable clock for tests. */
  now?: number;
  /**
   * Outbound send used to re-deliver a recovered result. Defaults to the
   * production sendMessage gateway; tests inject a collector so they never
   * touch the real Telegram API.
   */
  send?: (chatId: string | number, text: string) => Promise<void>;
}

export interface RecoveryResult {
  recovered: string[];
  considered: number;
}

function isRecoverableCandidate(t: TaskRecord, now: number, idleMs: number): boolean {
  if (t.state !== "executing") return false;
  if (t.origin.source !== "telegram") return false;
  // Protocol Watch runs have their own scheduler/lease work; goals only.
  if (t.jobType && t.jobType !== "goal") return false;
  const steps = t.plan ?? [];
  if (steps.some((s) => PAID_STEP_KINDS.has(s.kind))) return false;
  return now - t.updatedAt > idleMs;
}

/**
 * Re-run abandoned free-mode Telegram tasks, delivering the outcome once more
 * to the chat would not be possible from here (the originating chat id is
 * `origin.actor` only when it is numeric — a user id, which equals the chat id
 * in private chats). For those, the result is re-delivered directly; for
 * non-numeric actors (e.g. @username actors in group contexts) the re-run
 * still completes the task so /tasks shows a truthful final state.
 */
export async function recoverAbandonedFreeTasks(options: RecoveryOptions = {}): Promise<RecoveryResult> {
  const deps = options.deps ?? defaultDeps();
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? Date.now();
  const tasks = await listTasks();
  const recovered: string[] = [];
  for (const t of tasks) {
    if (!isRecoverableCandidate(t, now, idleMs)) continue;
    const release = await persistence().acquireLease(`task-${t.id}`, LEASE_TTL_MS);
    if (!release) continue; // another worker is already handling this task
    try {
      // Re-check under the lease: the record may have finished or been
      // resumed between the initial list and now.
      const fresh = await getTask(t.id);
      if (!fresh || !isRecoverableCandidate(fresh, now, idleMs)) continue;
      console.log(`recovery: re-running abandoned free task ${t.id} (idle ${Math.round((now - fresh.updatedAt) / 1000)}s)`);
      await runTask(t.id, deps);
      recovered.push(t.id);
      await maybeRedeliverResult(fresh, options.send);
    } catch (err) {
      console.error(`recovery: re-run failed for task ${t.id}:`, err);
    } finally {
      await release();
    }
  }
  return { recovered, considered: tasks.length };
}

/**
 * Outbound send for recovered results: only when the chat id is recoverable
 * from origin. Send failures are logged, never thrown — recovery's job is to
 * complete the task record truthfully; message delivery is best-effort.
 */
async function maybeRedeliverResult(task: TaskRecord, send?: (chatId: string | number, text: string) => Promise<void>): Promise<void> {
  try {
    const chatId = Number(task.origin.actor);
    if (!Number.isFinite(chatId)) return; // group/username actor: /tasks reports state
    const finalTask = (await getTask(task.id)) ?? task;
    const adapter = await import("./adapter");
    await adapter.deliverResult(String(chatId), finalTask, send);
  } catch (err) {
    console.error(`recovery: result delivery failed for task ${task.id}:`, err);
  }
}
