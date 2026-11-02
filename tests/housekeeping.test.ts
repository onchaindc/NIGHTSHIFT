import { describe, expect, it } from "vitest";

import { prunePolicyOptions, selectPrunable } from "@/lib/watch/housekeeping";
import { resetStore } from "@/lib/engine/store";
import { resetWatchStore } from "@/lib/watch/store";
import type { TaskRecord } from "@/lib/engine/types";

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

function watchTask(opts: Partial<TaskRecord> & { id: string; createdAt: number }): TaskRecord {
  return {
    id: opts.id,
    createdAt: opts.createdAt,
    state: opts.state ?? "completed",
    jobType: opts.jobType ?? "protocol_watch",
    spend: opts.spend ?? { limitUsdCents: 10, spentUsdCents: 0, entries: [] },
    result: opts.result ?? { summary: "check ok" },
    events: [],
    origin: { source: "web" },
    requiresApproval: false,
    permissions: { allowedActions: [] },
  } as unknown as TaskRecord;
}

function policy(now = NOW): { now: number; retainDays: number; keepMinimum: number; batchSize: number } {
  return { now, retainDays: 14, keepMinimum: 200, batchSize: 200 };
}

describe("free-tier storage housekeeping policy", () => {
  it("prunes only old, terminal, free, report-less watch checks", () => {
    const old = NOW - 20 * DAY;
    const tasks = [
      watchTask({ id: "old-routine", createdAt: old }),
      watchTask({ id: "old-but-live", createdAt: old, state: "awaiting_approval" }), // live: keep
      watchTask({ id: "old-but-executing", createdAt: old, state: "executing" }), // live: keep
      watchTask({ id: "old-but-paid", createdAt: old, spend: { limitUsdCents: 10, spentUsdCents: 1, entries: [] } }), // receipt: keep
      watchTask({ id: "old-but-report", createdAt: old, result: { summary: "s", repoReport: { repository: "o/r" } } as TaskRecord["result"] }), // deliverable: keep
      watchTask({ id: "recent-routine", createdAt: NOW - 2 * DAY }), // inside retention window: keep
      watchTask({ id: "not-a-watch", createdAt: old, jobType: "goal" }), // engine-unrelated: never touched
    ];
    const ids = selectPrunable(tasks, { now: NOW, retainDays: 14, keepMinimum: 0, batchSize: 200 });
    expect(ids).toEqual(["old-routine"]);
  });

  it("honors the keep-floor: the newest N terminal watch tasks survive whatever their age", () => {
    const tasks: TaskRecord[] = [];
    for (let i = 0; i < 230; i++) {
      tasks.push(watchTask({ id: `w-${i}`, createdAt: NOW - (250 + i) * DAY }));
    }
    const ids = selectPrunable(tasks, { now: NOW, retainDays: 14, keepMinimum: 200, batchSize: 200 });
    // In these fixtures higher i is OLDER; the 200 newest (i < 200) stay, and
    // the 30 oldest (i = 200..229) are prunable. The batch cap does not bind.
    expect(ids).toHaveLength(30);
    const pruned = new Set(ids);
    for (let i = 0; i < 200; i++) expect(pruned.has(`w-${i}`)).toBe(false); // newest 200 intact
    expect(pruned.has("w-229")).toBe(true); // oldest included
  });

  it("abides by the batch cap so one pass never issues a giant delete", () => {
    const tasks: TaskRecord[] = [];
    for (let i = 0; i < 500; i++) {
      tasks.push(watchTask({ id: `w-${i}`, createdAt: NOW - (1000 + i) * DAY }));
    }
    const ids = selectPrunable(tasks, { now: NOW, retainDays: 14, keepMinimum: 0, batchSize: 200 });
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe("w-499"); // oldest first (higher i = older in these fixtures)
  });

  it("policy options come from env with hard floors", () => {
    const prev = { days: process.env.NIGHTSHIFT_PRUNE_DAYS, keep: process.env.NIGHTSHIFT_PRUNE_KEEP_MIN, batch: process.env.NIGHTSHIFT_PRUNE_BATCH };
    try {
      delete process.env.NIGHTSHIFT_PRUNE_DAYS;
      delete process.env.NIGHTSHIFT_PRUNE_KEEP_MIN;
      delete process.env.NIGHTSHIFT_PRUNE_BATCH;
      expect(prunePolicyOptions(0)).toEqual({ now: 0, retainDays: 14, keepMinimum: 200, batchSize: 200 });
      process.env.NIGHTSHIFT_PRUNE_DAYS = "7";
      process.env.NIGHTSHIFT_PRUNE_KEEP_MIN = "50";
      process.env.NIGHTSHIFT_PRUNE_BATCH = "100";
      expect(prunePolicyOptions(0)).toEqual({ now: 0, retainDays: 7, keepMinimum: 50, batchSize: 100 });
      process.env.NIGHTSHIFT_PRUNE_DAYS = "0"; // below floor 1
      process.env.NIGHTSHIFT_PRUNE_BATCH = "99999"; // above ceiling 1000
      expect(prunePolicyOptions(0)).toEqual({ now: 0, retainDays: 14, keepMinimum: 50, batchSize: 1000 });
    } finally {
      process.env.NIGHTSHIFT_PRUNE_DAYS = prev.days;
      process.env.NIGHTSHIFT_PRUNE_KEEP_MIN = prev.keep;
      process.env.NIGHTSHIFT_PRUNE_BATCH = prev.batch;
    }
  });

  it("deletes through the store end to end", async () => {
    resetStore();
    resetWatchStore();
    const { saveTask, deleteTasks, getTask } = await import("@/lib/engine/store");
    const t1 = watchTask({ id: "a", createdAt: 1 });
    const t2 = watchTask({ id: "b", createdAt: 2 });
    await saveTask(t1);
    await saveTask(t2);
    const removed = await deleteTasks(["a", "zzz"]);
    expect(removed).toBe(1);
    expect(await getTask("a")).toBeNull();
    expect((await getTask("b"))?.id).toBe("b");
  });
});
