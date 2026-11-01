import { listWatches } from "./store";
import { isVercelRuntime } from "@/lib/engine/store";
import { persistence } from "@/lib/storage";
import { randomUUID } from "node:crypto";
import { canTransition } from "@/lib/engine/types";
import { deliverAlerts } from "./alerts";
import { resolveWebhookBaseUrl } from "@/lib/telegram/webhook-register";

/**
 * Whether scheduled monitoring is expected to come from an EXTERNAL trigger
 * in this deployment (cron hitting /api/watches/scheduler-tick) instead of
 * the in-process timer. Vercel functions have no long-lived process, so an
 * in-process setInterval is not a supported worker there.
 */
export function externalCronConfigured(): boolean {
  return process.env.NIGHTSHIFT_EXTERNAL_CRON === "1";
}

/**
 * Scheduler for Protocol Watch.
 *
 * Reliability model, stated honestly:
 *  - The schedule itself is persistent: a watch's due time derives from its
 *    persisted lastCheckedAt, so after any restart the next scan catches up.
 *  - A tick's live state (started, last success, last error) is PERSISTED to
 *    scheduler-state.json so /api/status can report truthfully even for a
 *    restarted (or stopped) process, instead of fabricating "running".
 *  - Duplicate workers (two server processes on one data dir) are guarded by
 *    a ttl lease file: an unexpired lease makes other workers skip the tick.
 *    Even if two scans overlap anyway, fingerprints make double execution
 *    idempotent: the second scan diffs against the persisted fingerprints and
 *    reports no change, so nothing is ever reported twice.
 *  - When the server process stops, monitoring stops: status says so (stale
 *    lastSuccess) instead of claiming continuous monitoring.
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export function watchIntervalMs(): number {
  const env = Number(process.env.NIGHTSHIFT_WATCH_INTERVAL_MS);
  return Number.isFinite(env) && env >= 30_000 ? env : DEFAULT_INTERVAL_MS;
}

export function autoCheckEnabled(): boolean {
  return process.env.NIGHTSHIFT_WATCH_AUTOCHECK !== "0";
}

/** Persisted tick state: what status and restarts report. Survives restarts. */
export interface SchedulerState {
  pid: number;
  startedAt: number;
  lastScanStartedAt: number | null;
  lastScanCompletedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  skippedByOtherWorker: number;
}

let state: SchedulerState = {
  pid: process.pid,
  startedAt: Date.now(),
  lastScanStartedAt: null,
  lastScanCompletedAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  skippedByOtherWorker: 0,
};

async function loadPersistedState(): Promise<void> {
  try {
    const raw = await persistence().readNamed<SchedulerState>("scheduler");
    if (raw && typeof raw === "object" && typeof raw.pid === "number") {
      state = raw;
    }
  } catch (err) {
    console.error("failed to load scheduler state:", err instanceof Error ? err.message : err);
  }
}

let stateLoaded = false;

async function persistState(): Promise<void> {
  try {
    await persistence().writeNamed("scheduler", state);
  } catch (err) {
    console.error("failed to persist scheduler state:", err);
  }
}

let running = false;
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let catchUpTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Inter-process duplicate worker guard: a ttl lease acquired by exclusive
 * create. A live lease (not expired, holder still writing heartbeats) makes
 * this worker skip the tick. An expired lease is stolen atomically.
 * Returns release() or null when another live worker holds the lease.
 */
async function acquireLease(ttlMs: number): Promise<(() => Promise<void>) | null> {
  // The backend serializes the ttl lease: an unexpired lease held by another
  // worker makes this worker skip the tick; expired leases are stolen
  // atomically. Fingerprints make any accidental double scan idempotent.
  return persistence().acquireLease("scheduler", ttlMs);
}

async function autoScan(): Promise<void> {
  if (!stateLoaded) {
    await loadPersistedState();
    stateLoaded = true;
    state.pid = process.pid;
    await persistState();
  }
  if (running) return; // never overlap within this process
  // Cross-process guard: the lease ttl covers the interval plus a scan margin.
  const release = await acquireLease(watchIntervalMs() + 5 * 60_000);
  if (!release) {
    state.skippedByOtherWorker++;
    await persistState();
    return; // another worker owns this tick; it will do the work
  }
  running = true;
  state.lastScanStartedAt = Date.now();
  await persistState();
  try {
    const interval = watchIntervalMs();
    const watches = await listWatches();
    const now = Date.now();
    await reconcileStaleTasks(now);
    for (const w of watches) {
      const due = w.lastCheckedAt === null || now - w.lastCheckedAt >= interval;
      if (!due) continue;
      // Per-watch lease: two fleet workers (multi-instance deployment) cannot
      // run the same watch's check concurrently. A manual check remains
      // intentionally un-leased: it is a fresh, deliberate task, and its
      // overlaps stay harmless through merged fingerprints + alert dedupe.
      const watchRelease = await persistence().acquireLease(`watch-run:${w.id}`, interval + 5 * 60_000);
      if (!watchRelease) continue; // another worker is checking this watch right now
      try {
        // Auto checks are always FREE: the scheduler never triggers a purchase.
        const { createTask, runTask } = await import("@/lib/engine/engine");
        const task = await createTask({
          goal: `Protocol Watch check: ${w.name} (${w.protocol})`,
          spendLimitUsdCents: w.spendLimitUsdCents,
          requiresApproval: false,
          origin: { source: "web" },
          jobType: "protocol_watch",
          watch: { watchId: w.id, watchName: w.name, triggeredBy: "auto-scheduler", telegramChatId: w.telegramChatId ?? null },
          plan: (await import("./execute")).planWatchSteps(w, false),
          criteria: (await import("./types")).WATCH_CRITERIA,
        });
        if (task.state === "executing") {
          await runTask(task.id);
        }
      } finally {
        await watchRelease();
      }
    }
    // Pending alert retries: alerts whose Telegram delivery failed stay
    // pending in the persisted ledger; every tick re-attempts them after
    // their bounded backoff, so a transient outage never loses an alert.
    for (const w of watches) {
      if (!w.telegramChatId) continue;
      try {
        await deliverAlerts(
          { watchId: w.id, watchName: w.name, protocol: w.protocol, telegramChatId: w.telegramChatId },
          [],
          resolveWebhookBaseUrl(),
          Date.now(),
        );
      } catch (err) {
        console.error(`pending alert retry failed for watch ${w.id}:`, err);
      }
    }
    state.lastSuccessAt = Date.now();
    state.lastError = null;
    state.consecutiveFailures = 0;
  } catch (err) {
    // A failed scan tick is logged, persisted, and retried next interval; it
    // must never crash the server or fake a "checked" state it did not do.
    state.lastError = err instanceof Error ? err.message : String(err);
    state.consecutiveFailures++;
    console.error("protocol watch auto-scan failed:", err);
  } finally {
    state.lastScanCompletedAt = Date.now();
    await persistState();
    running = false;
    await release();
  }
}

/** One immediate scan; exported for tests and manual recovery. */
export async function runAutoScanOnce(): Promise<void> {
  await autoScan();
}

/**
 * Interrupted-run recovery for ordinary goal tasks. A paid or free operation
 * whose worker died mid-run (frozen lambda, deploy, crash) leaves its task
 * record in executing/verifying (or the transient pre-run states) forever;
 * without this every such task pollutes the Overview and History as
 * "Working" while its activity log already shows the failed purchases.
 *
 * SAFETY: the record only gets an honest terminal state, after a grace
 * window far beyond any legitimate run (the request keeps running up to
 * maxDuration), guarded by canTransition so a live runner is never touched
 * and reconciliation is never applied twice. Spend entries recorded before
 * the interruption stay on record; nothing is marked complete.
 */
export async function reconcileStaleTasks(now: number, graceMs = 15 * 60_000): Promise<number> {
  const watchReconciled = await reconcileStaleWatchTasks(now, graceMs);
  const { listTasks, getTask, saveTask } = await import("@/lib/engine/store");
  let reconciled = 0;
  try {
    for (const t of await listTasks()) {
      if (t.jobType === "protocol_watch") continue; // handled by reconcileStaleWatchTasks
      if (t.state !== "created" && t.state !== "planning" && t.state !== "executing" && t.state !== "verifying") continue;
      if (now - t.updatedAt <= graceMs) continue; // could still be a live run
      const fresh = await getTask(t.id);
      if (!fresh || fresh.state !== t.state || !canTransition(fresh.state, "failed")) continue;
      fresh.state = "failed";
      fresh.error = "Execution was interrupted before a result was recorded (the worker stopped mid-run). Nothing was completed; relaunch the objective if it still matters.";
      fresh.events.push({
        id: randomUUID(),
        ts: now,
        type: "task_failed",
        message: "Execution was interrupted mid-run (worker loss). Nothing was completed; recorded spend entries stay on the record.",
      });
      await saveTask(fresh);
      reconciled++;
    }
  } catch (err) {
    console.error("stale task reconciliation failed:", err);
  }
  return watchReconciled + reconciled;
}

/**
 * Interrupted-scan recovery. A check run that died mid-execution (frozen
 * lambda, deploy, crash, OOM) leaves its task record in executing/verifying
 * forever; without this every such run would pollute history as "running".
 *
 * SAFETY: the WATCH itself needs no state repair — its fingerprints and
 * alert ledger persisted at each step, and lastCheckedAt is only written on
 * a scan that actually completed, so the missed scan simply re-happens on
 * the next tick (idempotent: unchanged sources re-diff against old
 * fingerprints, already-alerted changes are deduped by key). Only the task
 * RECORD gets an honest terminal state, after a grace window far beyond any
 * legitimate check duration, guarded by canTransition so a live runner is
 * never touched and reconciliation is never applied twice.
 */
export async function reconcileStaleWatchTasks(now: number, graceMs = 15 * 60_000): Promise<number> {
  const { listTasks, getTask, saveTask } = await import("@/lib/engine/store");
  let reconciled = 0;
  try {
    for (const t of await listTasks()) {
      if (t.jobType !== "protocol_watch") continue;
      if (t.state !== "executing" && t.state !== "verifying") continue;
      if (now - t.updatedAt <= graceMs) continue; // could still be a live run
      const fresh = await getTask(t.id);
      if (!fresh || fresh.state !== t.state || !canTransition(fresh.state, "failed")) continue;
      fresh.state = "failed";
      fresh.error = "Scan interrupted: the worker died mid-run. Persisted fingerprints make the next scheduled scan cover the missed work.";
      fresh.events.push({
        id: randomUUID(),
        ts: now,
        type: "scan_interrupted",
        message: "This scan was interrupted mid-run (worker loss). It was reconciled by a later scheduled tick; the watch re-checks automatically and alert dedupe prevents duplicate notifications.",
      });
      await saveTask(fresh);
      reconciled++;
    }
  } catch (err) {
    console.error("stale watch task reconciliation failed:", err);
  }
  return reconciled;
}

export interface SchedulerStatus {
  autoChecks: boolean;
  intervalMs: number;
  /** Whether a timer is armed in THIS process. */
  activeInProcess: boolean;
  workerPid: number;
  startedAt: number;
  lastScanStartedAt: number | null;
  lastScanCompletedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  skippedByOtherWorker: number;
  /** Best-effort estimate of the next scan time; null when inactive. */
  nextRunAt: number | null;
  /**
   * Honest degradation: a crashed process restarts due checks on boot, but
   * while the process is down no monitoring happens. Degraded also covers
   * repeated scan failures and monitoring idle far beyond the interval.
   */
  degraded: boolean;
  degradedReason: string | null;
  /** True when another worker process holds an unexpired scan lease. */
  otherWorkerActive: boolean;
  /** How scans are triggered: an in-process timer, or an external cron trigger. */
  workerMode: "in-process" | "external-trigger";
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  if (!stateLoaded) {
    await loadPersistedState();
    stateLoaded = true;
  }
  // Self-heal: dev bundles (and any missed instrumentation hook) can yield
  // separate module instances. This idempotent arm guarantees the process
  // actually HAS a worker, and the reported state then reflects truth.
  if (!started && autoCheckEnabled() && !isVercelRuntime()) startWatchScheduler();
  const interval = watchIntervalMs();
  const now = Date.now();
  let otherWorkerActive = false;
  try {
    const lease = await persistence().readLease("scheduler");
    otherWorkerActive = lease ? lease.pid !== process.pid && now < lease.expiresAt : false;
  } catch {
    otherWorkerActive = false;
  }
  const stale = state.lastSuccessAt === null || now - state.lastSuccessAt > 2.5 * interval;
  // On Vercel this process never holds the timer: scheduled work is expected
  // from the external trigger. Report honestly whether that trigger is (per
  // configuration, NIGHTSHIFT_EXTERNAL_CRON=1) expected to exist at all.
  const serverless = isVercelRuntime();
  const cronExpected = serverless && externalCronConfigured();
  const commonDegraded = state.consecutiveFailures > 0 || (!otherWorkerActive && stale);
  const degraded = serverless ? !cronExpected || commonDegraded : !started || commonDegraded;  const degradedReason = serverless
    ? cronExpected
      ? state.consecutiveFailures > 0
        ? `the last ${state.consecutiveFailures} scan(s) failed: ${state.lastError ?? "unknown error"}; next trigger retries`
        : null
      : "no external trigger is configured (NIGHTSHIFT_EXTERNAL_CRON): scheduled Protocol Watch checks do not run until a cron hits /api/watches/scheduler-tick"
    : !started
    ? "no worker timer is running in this process; monitoring is paused until the server process starts"
    : state.consecutiveFailures > 0
    ? `the last ${state.consecutiveFailures} scan(s) failed: ${state.lastError ?? "unknown error"}; next tick retries`
    : otherWorkerActive
    ? null
    : stale
    ? "no successful scan in the last interval window; a doze may have followed a stopped process"
    : null;
  return {
    autoChecks: autoCheckEnabled(),
    intervalMs: interval,
    activeInProcess: started,
    workerPid: started ? process.pid : state.pid,
    /** How scheduled scans are triggered in this deployment. */
    workerMode: serverless ? "external-trigger" : "in-process",
    startedAt: state.startedAt,
    lastScanStartedAt: state.lastScanStartedAt,
    lastScanCompletedAt: state.lastScanCompletedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    skippedByOtherWorker: state.skippedByOtherWorker,
    nextRunAt: started
      ? state.lastScanStartedAt !== null
        ? state.lastScanStartedAt + interval
        : state.startedAt + 15_000 // the boot catch-up scan
      : null,
    degraded,
    degradedReason,
    otherWorkerActive,
  };
}

/** Idempotent: safe to call from instrumentation on every server start. */
export function startWatchScheduler(): void {
  if (started || !autoCheckEnabled()) return;
  // On Vercel an in-process interval timer will not survive the request and
  // writes event loop leaks into an isolated lambda. Scheduled work there
  // MUST come from the external trigger; the timer is intentionally not armed
  // and /api/status says so.
  if (isVercelRuntime()) return;
  started = true;
  // On a fresh boot (no persisted state yet) we claim this process as the
  // worker. Restart recovery keeps the persisted timestamps so history of the
  // previous process is not overwritten before its first real scan here.
  if (!stateLoaded) {
    state.startedAt = Date.now();
    state.pid = process.pid;
    void persistState();
  }
  // First scan shortly after boot (catches up on changes noticed during a
  // pause), then every interval.
  timer = setInterval(() => void autoScan(), watchIntervalMs());
  const catchUp = setTimeout(() => void autoScan(), 15_000);
  catchUp.unref?.();
  catchUpTimeout = catchUp;
  // Never keep the process alive just for this timer.
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
}

/** Test/dev helper: forgets in-memory state so the next call re-reads from disk. */
export function resetSchedulerForTests(): void {
  if (catchUpTimeout) clearTimeout(catchUpTimeout); // no stray boot scan leaking into the next test
  catchUpTimeout = null;
  stateLoaded = false;
  state = { pid: process.pid, startedAt: Date.now(), lastScanStartedAt: null, lastScanCompletedAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, skippedByOtherWorker: 0 };
}

/** Test/dev helper. Releases the lease and clears state visibility. */
export async function stopWatchScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  if (catchUpTimeout) clearTimeout(catchUpTimeout); // no orphan boot scan after a stop
  catchUpTimeout = null;
  timer = null;
  started = false;
  running = false;
  try {
    await persistence().clearLease("scheduler");
  } catch {
    /* already gone */
  }
}
