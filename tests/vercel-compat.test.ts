import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dataDir, persistenceMode } from "@/lib/engine/store";
import {
  resetSchedulerForTests,
  schedulerStatus,
  startWatchScheduler,
  stopWatchScheduler,
} from "@/lib/watch/scheduler";

/**
 * Vercel compatibility regressions.
 *
 * Production runs on serverless functions: the deployment filesystem is
 * read-only except for /tmp, and there is no long-lived process. These tests
 * lock in behavior that keeps every store, every launch endpoint and the
 * scheduled worker working (or honestly reporting their limits) there.
 */

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  // Fresh scheduler state per test so timer decisions are not carried over.
  resetSchedulerForTests();
});

afterEach(async () => {
  await stopWatchScheduler();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

describe("writable data dir on Vercel", () => {
  it("defaults to /tmp when running on Vercel, instead of the read-only repo path", () => {
    setEnv("VERCEL", "1");
    setEnv("NIGHTSHIFT_DATA_DIR", undefined);
    expect(dataDir()).toBe("/tmp/nightshift-data");
    expect(persistenceMode()).toBe("ephemeral");
  });

  it("an explicit data dir always wins and is reported as durable", () => {
    setEnv("VERCEL", "1");
    setEnv("NIGHTSHIFT_DATA_DIR", "/custom/volume");
    expect(dataDir()).toBe("/custom/volume");
    expect(persistenceMode()).toBe("env-dir");
  });

  it("local (non-Vercel) runs keep the repo-local .data directory", () => {
    setEnv("VERCEL", undefined);
    setEnv("NIGHTSHIFT_DATA_DIR", undefined);
    expect(dataDir()).toBe(path.join(process.cwd(), ".data"));
    expect(persistenceMode()).toBe("local");
  });
});

describe("scheduler worker on Vercel", () => {
  it("never arms an in-process interval timer there; work must come from the external trigger", async () => {
    setEnv("VERCEL", "1");
    startWatchScheduler();
    const status = await schedulerStatus();
    expect(status.activeInProcess).toBe(false);
    expect(status.workerMode).toBe("external-trigger");
  });

  it("reports the missing external trigger honestly when no cron is configured", async () => {
    setEnv("VERCEL", "1");
    setEnv("NIGHTSHIFT_EXTERNAL_CRON", undefined);
    const status = await schedulerStatus();
    expect(status.workerMode).toBe("external-trigger");
    expect(status.degraded).toBe(true);
    expect(status.degradedReason).toContain("external trigger");
    expect(status.degradedReason).toContain("NIGHTSHIFT_EXTERNAL_CRON");
  });

  it("stops degrading once the external trigger is configured, while other failure states still degrade", async () => {
    setEnv("VERCEL", "1");
    setEnv("NIGHTSHIFT_EXTERNAL_CRON", "1");
    const configured = await schedulerStatus();
    expect(configured.degraded).toBe(true); // stale: no scan ever ran in this fresh process
    expect(configured.degradedReason).toBeNull();
  });

  it("auto-check disable still wins over everything", async () => {
    setEnv("VERCEL", undefined);
    setEnv("NIGHTSHIFT_WATCH_AUTOCHECK", "0");
    startWatchScheduler();
    const status = await schedulerStatus();
    expect(status.autoChecks).toBe(false);
    expect(status.activeInProcess).toBe(false);
    setEnv("NIGHTSHIFT_WATCH_AUTOCHECK", undefined);
  });
});

describe("schedule persistence is untouched by the runtime switch", () => {
  it("data dir creation under the /tmp fallback really writes and reads", async () => {
    setEnv("VERCEL", "1");
    const { resetStore, saveTask, getTask } = await import("@/lib/engine/store");
    await resetStore();
    const task = {
      id: "vercel-compat-task",
      createdAt: 0,
      updatedAt: 0,
      state: "completed" as const,
      goal: "probe",
      plan: [],
      events: [],
      spend: { limitUsdCents: 0, spentUsdCents: 0, entries: [] },
      permissions: { allowedActions: [], requiresApproval: false, maxRetries: 0 },
      criteria: {
        primaryVerifiedAgainstNodeSignal: false,
        answerSane: false,
        answerMaxAgeSeconds: 0,
        ownPaymentSettledOnChain: false,
        reconcileLedgerEntries: false,
      },
      result: null,
      error: null,
      origin: { source: "web" as const },
    };
    await saveTask(task);
    // A fresh module instance (simulating another function instance) reads
    // the same /tmp directory this instance wrote.
    const reloaded = await getTask("vercel-compat-task");
    expect(reloaded?.goal).toBe("probe");
  });
});
