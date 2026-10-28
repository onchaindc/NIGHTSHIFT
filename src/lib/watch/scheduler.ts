import { listWatches } from "./store";

/**
 * Scheduler foundation: an in-process interval that runs FREE checks (never
 * paid) for every configured watch whose fingerprints were last observed
 * longer than the interval ago. It runs only while THIS server process is
 * alive; when the process stops, so does the monitoring, and the UI reports
 * the last observed check time plus the pause explicitly instead of pretending
 * continuity. Fingerprints live in the watch store, so after a restart the
 * check resumes exactly where it stopped and no change is re-reported.
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export function watchIntervalMs(): number {
  const env = Number(process.env.NIGHTSHIFT_WATCH_INTERVAL_MS);
  return Number.isFinite(env) && env >= 30_000 ? env : DEFAULT_INTERVAL_MS;
}

export function autoCheckEnabled(): boolean {
  return process.env.NIGHTSHIFT_WATCH_AUTOCHECK !== "0";
}

let running = false;
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function autoScan(): Promise<void> {
  if (running) return; // never overlap: a slow source read must not stack scans
  running = true;
  try {
    const interval = watchIntervalMs();
    const watches = await listWatches();
    const now = Date.now();
    for (const w of watches) {
      const due = w.lastCheckedAt === null || now - w.lastCheckedAt >= interval;
      if (!due) continue;
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
    }
  } catch (err) {
    // A failed scan tick is logged and retried next interval; it must never
    // crash the server or fabricate a "checked" state it did not perform.
    console.error("protocol watch auto-scan failed:", err);
  } finally {
    running = false;
  }
}

/** Idempotent: safe to call from instrumentation on every server start. */
export function startWatchScheduler(): void {
  if (started || !autoCheckEnabled()) return;
  started = true;
  // First scan shortly after boot (catches up on changes noticed during a
  // pause), then every interval.
  timer = setInterval(() => void autoScan(), watchIntervalMs());
  setTimeout(() => void autoScan(), 15_000);
  // Never keep the process alive just for this timer.
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
}

/** Test/dev helper. */
export function stopWatchScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
