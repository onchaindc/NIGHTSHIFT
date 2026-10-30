import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TaskRecord } from "@/lib/engine/types";
import { choosePersistence, dataDir, persistence, persistenceMode, resetPersistenceForTests } from "@/lib/storage";
import { claimUpdate, isUpdateProcessed, resetSeenUpdates } from "@/lib/telegram/offsets";
import { getTask, listTasks, resetStore, saveTask } from "@/lib/engine/store";
import { createWatch, deleteWatch, listWatches, mutateWatch, resetWatchStore } from "@/lib/watch/store";

/**
 * Persistence regressions.
 *
 * The storage layer (src/lib/storage) is the single swap point between the
 * local JSON-file backend and the durable Postgres backend. These tests lock
 * in the file backend's historical semantics (including the "restart
 * simulation" helpers other suites rely on) and, when a real database URL is
 * available, the Postgres backend's durability and atomicity guarantees. No
 * real paid work or Telegram traffic ever happens here.
 */

const testTask = (id: string, goal = "probe"): TaskRecord =>
  ({
    id,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    state: "working",
    goal,
    plan: [],
    events: [{ id: "e1", at: 1700000000001, kind: "note", message: "hello" }],
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
    origin: { source: "web" },
  }) as never as TaskRecord;

const watchInput = (name: string) => ({
  name,
  protocol: "probe",
  sources: [{ type: "github_releases", label: "releases", target: "https://github.com/x/y" }],
});

const fileBackend = () => {
  const decision = choosePersistence();
  if (decision.persistence.provider !== "file") {
    throw new Error("these tests require the file backend (unset the database env var)");
  }
  return decision.persistence;
};

/** With a real DATABASE_URL deployed (Neon), every terminal command loads it —
 * file-backend suites pin the backend explicitly so they stay hermetic. */
function useFileBackend(): void {
  delete process.env.NIGHTSHIFT_DATABASE_URL;
  delete process.env.DATABASE_URL;
  resetPersistenceForTests();
}

describe("file backend: task store semantics", () => {
  beforeEach(() => {
    useFileBackend();
    process.env.NIGHTSHIFT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ns-persist-"));
    resetStore();
  });

  it("serves saves back across a cache drop (restart simulation)", async () => {
    await saveTask(testTask("p-task-1"));
    expect((await getTask("p-task-1"))?.goal).toBe("probe");

    resetStore(); // drop caches only — the JSON file stays on disk
    expect(existsSync(path.join(dataDir(), "tasks.json"))).toBe(true);
    expect((await getTask("p-task-1"))?.goal).toBe("probe");
    const all = await listTasks();
    expect(all.map((t) => t.id)).toContain("p-task-1");
  });

  it("listTasks returns the newest task first", async () => {
    await saveTask(testTask("p-task-old", "old"));
    await saveTask({ ...testTask("p-task-new", "new"), createdAt: 1700000000900 });
    expect((await listTasks())[0].id).toBe("p-task-new");
  });

  it("clearTasks empties the store entirely (both memory and file)", async () => {
    await saveTask(testTask("p-task-2"));
    await persistence().clearTasks();
    resetStore();
    expect(await getTask("p-task-2")).toBeNull();
    expect(await listTasks()).toHaveLength(0);
  });

  it("persistence mode stays explicit about durability", () => {
    // Not on Vercel, explicit tmp NIGHTSHIFT_DATA_DIR → the env-dir mode.
    expect(persistenceMode()).toBe("env-dir");
    expect(fileBackend()).toBe(persistence());
  });
});

describe("file backend: watch store semantics", () => {
  beforeEach(() => {
    useFileBackend();
    process.env.NIGHTSHIFT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ns-persist-"));
    resetWatchStore();
  });

  it("create → mutate → restart-simulate keeps fingerprints durable", async () => {
    const watch = await createWatch(watchInput("persist probe"));
    await mutateWatch(watch.id, (w) => {
      w.fingerprints.releases = { signature: "sha-old", seenAt: 1700000000002, summary: "old" };
    });
    resetWatchStore(); // drop caches, file stays
    const after = await mutateWatch(watch.id, (w) => {
      w.lastCheckedAt = 1700000099999;
    });
    expect(after?.fingerprints.releases?.signature).toBe("sha-old");
  });

  it("listWatches includes both configs and deletion reports honestly", async () => {
    const first = await createWatch(watchInput("first"));
    const second = await createWatch(watchInput("second"));
    const names = (await listWatches()).map((w) => w.name);
    expect(names).toContain("first");
    expect(names).toContain("second");
    expect(await deleteWatch(first.id)).toBe(true);
    expect(await deleteWatch(second.id)).toBe(true);
    expect(await deleteWatch("never-existed")).toBe(false);
  });
});

describe("file backend: telegram claim semantics", () => {
  beforeEach(() => {
    useFileBackend();
    process.env.NIGHTSHIFT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ns-persist-"));
  });

  it("claims each update id exactly once, even under N parallel invocations", async () => {
    await resetSeenUpdates();
    const attempts = await Promise.all(Array.from({ length: 12 }, () => claimUpdate(4242)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await isUpdateProcessed(4242)).toBe(true);
    // Still claimed after a cache drop (claim state is file-backed).
    await persistence().resetCaches();
    expect(await isUpdateProcessed(4242)).toBe(true);
  });

  it("reset clears the persisted set (a fresh runtime can re-claim)", async () => {
    await claimUpdate(777);
    await resetSeenUpdates();
    expect(existsSync(path.join(dataDir(), "telegram-seen-updates.json"))).toBe(false);
    expect(await claimUpdate(777)).toBe(true);
  });
});

describe("file backend: named documents and leases", () => {
  beforeEach(() => {
    useFileBackend();
    process.env.NIGHTSHIFT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ns-persist-"));
  });

  it("write/read/delete round-trip for named state", async () => {
    const backend = persistence();
    await backend.deleteNamed("p-state");
    await backend.writeNamed("p-state", { pid: 1, ticks: 3 });
    expect(await backend.readNamed<{ pid: number; ticks: number }>("p-state")).toEqual({
      pid: 1,
      ticks: 3,
    });
    await backend.deleteNamed("p-state");
    expect(await backend.readNamed("p-state")).toBeNull();
  });

  it("leases are exclusive until released, then re-acquirable", async () => {
    const backend = persistence();
    const release = await backend.acquireLease("p-lock", 10_000);
    expect(release).not.toBeNull();
    expect(await backend.acquireLease("p-lock", 10_000)).toBeNull();
    await release?.();
    expect(await backend.acquireLease("p-lock", 10_000)).not.toBeNull();
    await backend.clearLease("p-lock");
  });

  it("expired leases are stolen by the next worker", async () => {
    const backend = persistence();
    await backend.acquireLease("p-lock2", 15); // expires almost immediately
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await backend.acquireLease("p-lock2", 10_000)).not.toBeNull();
  });

  it("readLease exposes who holds the lease", async () => {
    const backend = persistence();
    expect(await backend.readLease("p-lock3")).toBeNull();
    const release = await backend.acquireLease("p-lock3", 10_000);
    expect((await backend.readLease("p-lock3"))?.pid).toBe(process.pid);
    await release?.();
    expect(await backend.readLease("p-lock3")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Postgres backend — only run when a real database URL is configured.  */
/* Every data row is test-prefixed and cleaned up; nothing else in a    */
/* shared database is touched, and no paid work or Telegram traffic     */
/* happens here either.                                                 */
/* ------------------------------------------------------------------ */

// setup.ts moves any deployed database URL into the test-only namespace so
// the default suites stay file-backed; only this block opts into the real DB.
const dbUrl =
  process.env.NIGHTSHIFT_TEST_DATABASE_URL ?? process.env.NIGHTSHIFT_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!dbUrl)("postgres backend: durability and atomicity", () => {
  const ids = { lock: "", stamp: 0 };

  beforeEach(async () => {
    if (dbUrl) {
      delete process.env.DATABASE_URL;
      process.env.NIGHTSHIFT_DATABASE_URL = dbUrl; // pin the database backend explicitly
    }
    resetPersistenceForTests();
    delete process.env.NIGHTSHIFT_DATA_DIR;
    const { dbClose, dbMigrate } = await import("@/lib/db/client");
    await dbClose(); // reset the global client singleton for a fresh backend choice
    await dbMigrate();
    ids.lock = `p-pg-lock-${Date.now()}`;
    ids.stamp = 99_900_000 + (Date.now() % 100_000);
  });

  afterEach(async () => {
    const { dbClose, dbSql } = await import("@/lib/db/client");
    const client = dbSql();
    try {
      await client`delete from ns_tasks where id like ${"p-pg-%"}`;
    } catch {
      /* best-effort cleanup */
    }
    try {
      await client`delete from ns_seen_updates where update_id = ${ids.stamp}`;
    } catch {
      /* best-effort cleanup */
    }
    try {
      await client`delete from ns_leases where name = ${ids.lock}`;
    } catch {
      /* best-effort cleanup */
    }
    await dbClose();
  });

  it("migrations are idempotent: applying twice is a no-op", async () => {
    const { dbMigrate } = await import("@/lib/db/client");
    await dbMigrate();
    await expect(dbMigrate()).resolves.toHaveLength(0);
  });

  it("task save/get round-trips through the real database", async () => {
    const id = `p-pg-${Date.now()}-task`;
    await saveTask(testTask(id, "durable probe"));
    expect((await getTask(id))?.goal).toBe("durable probe");
  });

  it("concurrent saves of one task id end with exactly one winner", async () => {
    const id = `p-pg-${Date.now()}-lastwrite`;
    const base = testTask(id, "before");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        saveTask({ ...base, goal: `writer-${i}`, events: [] }),
      ),
    );
    expect((await getTask(id))?.goal).toMatch(/^writer-[0-7]$/);
  });

  it("a claimed telegram update is claimed exactly once under N parallel calls", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => claimUpdate(ids.stamp)),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await isUpdateProcessed(ids.stamp)).toBe(true);
  });

  it("named state round-trips through the database (jsonb in both directions)", async () => {
    const name = ids.lock.replace("p-pg-lock", "p-pg-kv");
    const backend = persistence();
    await backend.writeNamed(name, { pid: 1, ticks: 3 });
    expect(await backend.readNamed<{ pid: number; ticks: number }>(name)).toEqual({ pid: 1, ticks: 3 });
    await backend.deleteNamed(name);
    expect(await backend.readNamed(name)).toBeNull();
  });

  it("leases are mutually exclusive and released when done", async () => {
    const backend = persistence();
    const release = await backend.acquireLease(ids.lock, 10_000);
    expect(release).not.toBeNull();
    expect(await backend.acquireLease(ids.lock, 10_000)).toBeNull();
    await release?.();
    expect(await backend.acquireLease(ids.lock, 10_000)).not.toBeNull();
  });
});
