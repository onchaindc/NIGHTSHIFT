import { isTerminal, type TaskRecord } from "@/lib/engine/types";
import { listTasks, deleteTasks } from "@/lib/engine/store";

// The engine store returns full TaskRecords (not storage rows).
type StoreTask = TaskRecord;

/**
 * Storage housekeeping for free-tier databases.
 *
 * Every scheduled Protocol Watch scan creates a full task record — events,
 * snapshots, evidence — and without a ceiling the store grows one row per
 * interval per watch, which fills a 0.5 GB free plan in weeks. This module
 * prunes ONLY what the product does not need to keep:
 *
 *   - routine watch checks in a terminal state (never anything still live:
 *     awaiting approval, executing, … are kept and never touched),
 *   - older than retainDays (default 14),
 *   - WITHOUT real spend (every paid task with a receipt is kept),
 *   - WITHOUT a technical report (investigation deliverables are kept),
 *   - never below the newest keep-floor (default 200 terminal watch tasks),
 *   - bounded per pass (default 200 rows) so a large backlog is reclaimed
 *     gradually instead of one huge delete.
 *
 * Runs at most once per hour from the scheduler tick; housekeeping must
 * never fail a scan.
 */

export interface PrunePolicyOptions {
  now: number;
  retainDays: number;
  keepMinimum: number;
  batchSize: number;
}

const DEFAULTS = {
  retainDays: 14,
  keepMinimum: 200,
  batchSize: 200,
};

/** Environment-backed policy with hard floors: a configuration cannot prune
 * everything (days >= 1, keepMin >= 25, batch <= 1000). */
export function prunePolicyOptions(now: number): PrunePolicyOptions {
  const days = Number(process.env.NIGHTSHIFT_PRUNE_DAYS);
  const keepMin = Number(process.env.NIGHTSHIFT_PRUNE_KEEP_MIN);
  const batch = Number(process.env.NIGHTSHIFT_PRUNE_BATCH);
  return {
    now,
    retainDays: Number.isFinite(days) && days >= 1 ? days : DEFAULTS.retainDays,
    keepMinimum: Number.isFinite(keepMin) && keepMin >= 25 ? keepMin : DEFAULTS.keepMinimum,
    batchSize: Number.isFinite(batch) && batch >= 1 ? Math.min(batch, 1000) : DEFAULTS.batchSize,
  };
}

/** Pure selection logic over terminal protocol_watch task rows. */
export function selectPrunable(
  tasks: Array<Pick<TaskRecord, "id" | "state" | "jobType" | "createdAt" | "spend" | "result">>,
  opts: PrunePolicyOptions,
): string[] {
  type Candidate = Pick<TaskRecord, "id" | "state" | "jobType" | "createdAt" | "spend" | "result">;
  const isWatch = (t: Candidate) => t.jobType === "protocol_watch";
  const candidates = tasks
    .filter((t) => isWatch(t) && isTerminal(t.state))
    // Earliest first: prune old ones before even considering new ones.
    .sort((a, b) => a.createdAt - b.createdAt);
  const cutoff = opts.now - opts.retainDays * 24 * 60 * 60_000;
  const prunable = candidates.filter((t) => {
    if (t.createdAt >= cutoff) return false;
    // Anything the user PAID for is part of the spend audit trail: keep it.
    if ((t.spend?.spentUsdCents ?? 0) > 0) return false;
    // Attachments of an actual investigation are deliverables, not noise.
    if (t.result?.repoReport) return false;
    return true;
  });
  // The newest keepMinimum watch tasks always survive, whatever their age.
  const floor = candidates.slice(Math.max(0, candidates.length - opts.keepMinimum)).map((t) => t.id);
  return prunable.filter((t) => !floor.includes(t.id)).slice(0, opts.batchSize).map((t) => t.id);
}

let lastRunAt = 0;

/** Hourly from the scheduler tick; every failure is contained and logged. */
export async function runTaskHousekeeping(now = Date.now()): Promise<number> {
  const minInterval = watchIntervalFloorMs();
  if (now - lastRunAt < minInterval) return 0;
  lastRunAt = now;
  try {
    const tasks = await listTasks();
    const ids = selectPrunable(
      tasks as StoreTask[],
      prunePolicyOptions(now),
    );
    if (ids.length === 0) return 0;
    const removed = await deleteTasks(ids);
    if (removed > 0) console.log(`[housekeeping] pruned ${removed} routine watch task rows to stay inside the free-tier storage quota`);
    return removed;
  } catch (err) {
    // Deleting old rows must never break a scan or crash the server.
    console.error("[housekeeping] prune pass failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

function watchIntervalFloorMs(): number {
  const v = Number(process.env.NIGHTSHIFT_PRUNE_MIN_GAP_MS);
  return Number.isFinite(v) && v >= 60_000 ? v : 60 * 60_000;
}
