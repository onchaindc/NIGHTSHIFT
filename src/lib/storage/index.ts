import { promises as fs } from "node:fs";
import path from "node:path";
import type { TaskRecord } from "@/lib/engine/types";
import type { WatchConfig } from "@/lib/watch/types";
import { dbClose, dbHealth, dbSql, isDatabaseConfigured } from "@/lib/db/client";

/**
 * Swappable persistence backend for every durable store in the app:
 *
 *   - tasks (engine history),
 *   - watches (Protocol Watch configs incl. fingerprints),
 *   - telegram update claims (at-most-once webhook dedup),
 *   - named documents (scheduler tick state),
 *   - ttl leases (cross-worker scheduler coordination).
 *
 * Two backends implement the same interface:
 *   FilePersistence — the historical JSON stores under NIGHTSHIFT_DATA_DIR
 *     (identical file names and formats as before, byte-for-byte readable).
 *   PostgresPersistence — versioned, indexed document tables (migrations in
 *     src/lib/db/client.ts) used wherever NIGHTSHIFT_DATABASE_URL is set, so
 *     serverless function restarts DO NOT lose history, fingerprints or
 *     dedup state. Atomicity is delegated to the database.
 *
 * Callers never know which one runs: they get a persistence() handle and the
 * backend selection below decides (a configured database always wins).
 */

export type PersistenceProvider = "postgres" | "file";

export interface TaskRow {
  id: string;
  createdAt: number;
  state: string;
  data: TaskRecord;
}

export interface Persistence {
  readonly provider: PersistenceProvider;
  /** Idempotent one-time setup (e.g. schema migration for Postgres). */
  ready(): Promise<void>;
  health(): Promise<"ok" | "unreachable" | "unconfigured">;

  // tasks
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(): Promise<TaskRow[]>;
  saveTask(task: TaskRecord): Promise<void>;
  clearTasks(): Promise<void>;

  // watches
  listWatches(): Promise<WatchConfig[]>;
  getWatch(id: string): Promise<WatchConfig | null>;
  insertWatch(watch: WatchConfig): Promise<void>;
  removeWatch(id: string): Promise<boolean>;
  /** Atomic read-modify-write; the LAST mutation wins, none interleave. */
  updateWatch(id: string, mutate: (w: WatchConfig) => void): Promise<WatchConfig | null>;
  clearWatches(): Promise<void>;

  // telegram updates (claims are atomic)
  /** Returns true when THIS call became the owner of the update. */
  claimUpdate(updateId: number | undefined): Promise<boolean>;
  isUpdateClaimed(updateId: number | undefined): Promise<boolean>;
  clearSeenUpdates(): Promise<void>;

  // named state documents (scheduler tick state)
  readNamed<T>(name: string): Promise<T | null>;
  writeNamed<T>(name: string, value: T): Promise<void>;
  deleteNamed(name: string): Promise<void>;

  /** Returns a release fn, or null when another live worker holds the lease. */
  acquireLease(name: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
  clearLease(name: string): Promise<void>;
  /** Current lease contents (pid + expiry), or null when nobody holds it. */
  readLease(name: string): Promise<{ pid: number; expiresAt: number } | null>;

  /**
   * Drops every in-memory cache WITHOUT deleting persisted data — the
   * "process restart" simulation used by tests (files/db are re-read after).
   */
  resetCaches(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Local file backend — historical file names and formats               */
/* ------------------------------------------------------------------ */

/**
 * Local durable directory: an explicit NIGHTSHIFT_DATA_DIR always wins. On
 * Vercel the repo filesystem is read-only, so the default is the only
 * guaranteed-writable location (/tmp) — explicitly NON-durable across
 * function instances; /api/status reports it loudly as such.
 */
export function dataDir(): string {
  const explicit = (process.env.NIGHTSHIFT_DATA_DIR || "").trim();
  if (explicit) return explicit;
  if (isVercelRuntime()) return "/tmp/nightshift-data";
  return path.join(process.cwd(), ".data");
}

export function isVercelRuntime(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.NIGHTSHIFT_ON_VERCEL);
}

export type PersistenceMode = "postgres" | "env-dir" | "local" | "ephemeral";
export function persistenceMode(): PersistenceMode {
  if (isDatabaseConfigured()) return "postgres";
  if ((process.env.NIGHTSHIFT_DATA_DIR || "").trim()) return "env-dir";
  if (isVercelRuntime()) return "ephemeral";
  return "local";
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback; // missing or unreadable file → empty store (fresh start)
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

class FilePersistence implements Persistence {
  readonly provider = "file" as const;
  ready(): Promise<void> {
    return Promise.resolve();
  }
  async health(): Promise<"ok" | "unreachable" | "unconfigured"> {
    // The file backend is "healthy" when its directory is writable.
    try {
      await fs.mkdir(dataDir(), { recursive: true });
      return "ok";
    } catch {
      return "unreachable";
    }
  }

  // In-memory caches mirror the original stores: load once per process, then
  // every mutation rewrites the full document. resetCaches() simulates a
  // process restart by dropping them (files are re-read afterwards).
  private tasksCache: TaskRecord[] | null = null;
  private watchesCache: WatchConfig[] | null = null;
  private seen = new Set<number>();
  private seenLoaded = false;
  private claimChain: Promise<unknown> = Promise.resolve();

  private taskFile(): string {
    return path.join(dataDir(), "tasks.json");
  }
  private watchFile(): string {
    return path.join(dataDir(), "watches.json");
  }
  private seenFile(): string {
    return path.join(dataDir(), "telegram-seen-updates.json");
  }
  private namedFile(name: string): string {
    // scheduler-state.json keeps its historical name and format.
    return path.join(dataDir(), name === "scheduler" ? "scheduler-state.json" : `${name}.json`);
  }
  private leaseFile(name: string): string {
    // scheduler.lock keeps its historical name and format.
    return path.join(dataDir(), name === "scheduler" ? "scheduler.lock" : `${name}.lock`);
  }

  // tasks — the task file keeps its HISTORICAL format: a plain TaskRecord
  // array (top-level state/error fields), readable by every old tool. TaskRow
  // views are derived on demand for the postgres-shaped callers.
  private async ensureTasksLoaded(): Promise<TaskRecord[]> {
    if (this.tasksCache) return this.tasksCache;
    this.tasksCache = await readJsonFile<TaskRecord[]>(this.taskFile(), []);
    return this.tasksCache;
  }
  private rowOf(record: TaskRecord): TaskRow {
    return { id: record.id, createdAt: record.createdAt, state: record.state, data: record };
  }
  async getTask(id: string): Promise<TaskRecord | null> {
    const rows = await this.ensureTasksLoaded();
    return rows.find((r) => r.id === id) ?? null;
  }
  async listTasks(): Promise<TaskRow[]> {
    return [...(await this.ensureTasksLoaded())].map((r) => this.rowOf(r));
  }
  async saveTask(task: TaskRecord): Promise<void> {
    const rows = await this.ensureTasksLoaded();
    const record = JSON.parse(JSON.stringify(task)) as TaskRecord;
    const idx = rows.findIndex((r) => r.id === task.id);
    if (idx >= 0) rows[idx] = record;
    else rows.push(record);
    await atomicWrite(this.taskFile(), JSON.stringify(rows, null, 2));
  }
  async clearTasks(): Promise<void> {
    this.tasksCache = [];
    try {
      await fs.rm(this.taskFile(), { force: true });
    } catch {
      /* already gone */
    }
  }

  // watches — same load-once cache pattern as the original watch store
  private async ensureWatchesLoaded(): Promise<WatchConfig[]> {
    if (this.watchesCache) return this.watchesCache;
    this.watchesCache = await readJsonFile<WatchConfig[]>(this.watchFile(), []);
    return this.watchesCache;
  }
  async listWatches(): Promise<WatchConfig[]> {
    return [...(await this.ensureWatchesLoaded())];
  }
  async getWatch(id: string): Promise<WatchConfig | null> {
    const all = await this.ensureWatchesLoaded();
    return all.find((w) => w.id === id) ?? null;
  }
  async insertWatch(watch: WatchConfig): Promise<void> {
    const all = await this.ensureWatchesLoaded();
    all.push(watch);
    await atomicWrite(this.watchFile(), JSON.stringify(all, null, 2));
  }
  async removeWatch(id: string): Promise<boolean> {
    const all = await this.ensureWatchesLoaded();
    const next = all.filter((w) => w.id !== id);
    if (next.length === all.length) return false;
    this.watchesCache = next;
    await atomicWrite(this.watchFile(), JSON.stringify(next, null, 2));
    return true;
  }
  async updateWatch(id: string, mutate: (w: WatchConfig) => void): Promise<WatchConfig | null> {
    const all = await this.ensureWatchesLoaded();
    const idx = all.findIndex((w) => w.id === id);
    if (idx < 0) return null;
    const nextWatch: WatchConfig = JSON.parse(JSON.stringify(all[idx])) as WatchConfig;
    mutate(nextWatch);
    nextWatch.updatedAt = Date.now();
    all[idx] = nextWatch;
    await atomicWrite(this.watchFile(), JSON.stringify(all, null, 2));
    return nextWatch;
  }
  async clearWatches(): Promise<void> {
    this.watchesCache = [];
    try {
      await fs.rm(this.watchFile(), { force: true });
    } catch {
      /* already gone */
    }
  }

  // telegram updates: in-memory set layered over the persisted file, exactly
  // like the original offsets.ts (claims serialize through a promise chain).
  private async ensureSeenLoaded(): Promise<void> {
    if (this.seenLoaded) return;
    const ids = await readJsonFile<number[]>(this.seenFile(), []);
    for (const id of ids) this.seen.add(Number(id));
    this.seenLoaded = true;
  }
  private async persistSeen(): Promise<void> {
    await atomicWrite(this.seenFile(), JSON.stringify([...this.seen]));
  }

  async claimUpdate(updateId: number | undefined): Promise<boolean> {
    const next = this.claimChain.then(async (): Promise<boolean> => {
      await this.ensureSeenLoaded();
      if (updateId === undefined) return true; // no id → nothing to dedupe on (historical behavior)
      if (this.seen.has(updateId)) return false;
      this.seen.add(updateId);
      // Persisted BEFORE the claim resolves: a later cache drop (restart
      // simulation) must still see the claim, the same way the DB backend does.
      await this.persistSeen();
      return true;
    });
    this.claimChain = next.catch(() => undefined);
    return next as Promise<boolean>;
  }
  async isUpdateClaimed(updateId: number | undefined): Promise<boolean> {
    await this.ensureSeenLoaded();
    return updateId === undefined ? false : this.seen.has(updateId);
  }
  async clearSeenUpdates(): Promise<void> {
    this.seen.clear();
    this.claimChain = Promise.resolve();
    this.seenLoaded = true; // stay cleared for the remainder of this run
    try {
      await fs.rm(this.seenFile(), { force: true });
    } catch {
      /* already gone */
    }
  }

  // named state documents (scheduler tick state)
  async readNamed<T>(name: string): Promise<T | null> {
    return readJsonFile<T | null>(this.namedFile(name), null);
  }
  async writeNamed<T>(name: string, value: T): Promise<void> {
    await atomicWrite(this.namedFile(name), JSON.stringify(value, null, 2));
  }
  async deleteNamed(name: string): Promise<void> {
    try {
      await fs.rm(this.namedFile(name), { force: true });
    } catch {
      /* already gone */
    }
  }

  // leases: exclusive create (wx) + steal expired + OWNER-CONDITIONAL release
  async acquireLease(name: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const file = this.leaseFile(name);
    const lease = JSON.stringify({ pid: process.pid, takenAt: Date.now(), expiresAt: Date.now() + ttlMs });
    try {
      const handle = await fs.open(file, "wx");
      await handle.writeFile(lease, "utf8");
      await handle.close();
      return () => this.releaseLease(name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return null; // degrade: no lock readable, proceed (fingerprints keep us honest)
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as { pid: number; takenAt: number; expiresAt: number };
        if (Date.now() < raw.expiresAt) return null; // another worker owns this tick
      } catch {
        // unreadable lock file: treat as stale and steal it
      }
      await atomicWrite(file, lease); // steal expired/unreadable lease
      return () => this.releaseLease(name);
    }
  }
  /**
   * Release removes the lock ONLY when it still belongs to this process: a
   * stray late release (e.g. from a timer that was cleared afterwards) must
   * never delete a lease another worker legitimately took in the meantime.
   */
  private async releaseLease(name: string): Promise<void> {
    const file = this.leaseFile(name);
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as { pid: number };
      if (raw.pid !== process.pid) return; // not ours (anymore): hands off
    } catch {
      return; // unreadable/gone: nothing to release
    }
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
  async clearLease(name: string): Promise<void> {
    try {
      await fs.rm(this.leaseFile(name), { force: true });
    } catch {
      /* already gone */
    }
  }
  async readLease(name: string): Promise<{ pid: number; expiresAt: number } | null> {
    const raw = await readJsonFile<{ pid: number; takenAt: number; expiresAt: number } | null>(
      this.leaseFile(name),
      null,
    );
    return raw ? { pid: Number(raw.pid), expiresAt: Number(raw.expiresAt) } : null;
  }

  /** Drops every in-memory cache WITHOUT deleting persisted files. */
  async resetCaches(): Promise<void> {
    this.tasksCache = null;
    this.watchesCache = null;
    this.seen.clear();
    this.seenLoaded = false;
    this.claimChain = Promise.resolve();
  }
}

/* ------------------------------------------------------------------ */
/* Postgres backend — durable, atomic, serverless-safe                  */
/* ------------------------------------------------------------------ */

class PostgresPersistence implements Persistence {
  readonly provider = "postgres" as const;
  private migrated = false;

  async ready(): Promise<void> {
    if (this.migrated) return;
    if (!isDatabaseConfigured()) throw new Error("postgres persistence requested without a database URL");
    await this.migrate();
  }
  private async migrate(): Promise<void> {
    const client = dbSql();
    await client`create table if not exists ns_migrations (
      version integer primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )`;
    await client.unsafe(`select 1`); // no-op touch: fail fast if unreachable
    this.migrated = true;
  }
  async health(): Promise<"ok" | "unreachable" | "unconfigured"> {
    if (!isDatabaseConfigured()) return "unconfigured";
    return dbHealth();
  }

  // tasks (validated/normalized in engine/store.ts; this is pure storage)
  async getTask(id: string): Promise<TaskRecord | null> {
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`select data from ns_tasks where id = ${id}`;
    return rows.length > 0 ? (rows[0].data as TaskRecord) : null;
  }
  async listTasks(): Promise<TaskRow[]> {
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`select id, created_at, state, data from ns_tasks order by created_at desc`;
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      state: String(r.state),
      data: r.data as TaskRecord,
    }));
  }
  async saveTask(task: TaskRecord): Promise<void> {
    const client = dbSql();
    // Whole-record upsert keyed by id: the last write per task id wins, every
    // write is atomic per row. Engine ordering (step by step) stays intact.
    await client`insert into ns_tasks (id, created_at, state, data)
      values (${task.id}, ${task.createdAt}, ${task.state}, ${client.json(task as never)})
      on conflict (id) do update
        set state = excluded.state, data = excluded.data`;
  }
  async clearTasks(): Promise<void> {
    await dbSql()`delete from ns_tasks`;
  }
  /** Postgres keeps no read-cache state: there is nothing to drop. */
  async resetCaches(): Promise<void> {
    return Promise.resolve();
  }

  // watches (validated in watch/store.ts; this is pure storage)
  async listWatches(): Promise<WatchConfig[]> {
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`select data from ns_watches order by created_at desc`;
    return rows.map((r: Record<string, unknown>) => r.data as WatchConfig);
  }
  async getWatch(id: string): Promise<WatchConfig | null> {
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`select data from ns_watches where id = ${id}`;
    return rows.length > 0 ? (rows[0].data as WatchConfig) : null;
  }
  async insertWatch(watch: WatchConfig): Promise<void> {
    const client = dbSql();
    await client`insert into ns_watches (id, created_at, data)
      values (${watch.id}, ${watch.createdAt}, ${client.json(watch as never)})
      on conflict (id) do update set data = excluded.data`;
  }
  async removeWatch(id: string): Promise<boolean> {
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`delete from ns_watches where id = ${id} returning id`;
    return rows.length > 0;
  }
  /**
   * Atomic read-modify-write: the row is locked with FOR UPDATE inside a
   * transaction, mutated with the existing mutator function, and written
   * back. Two overlapping workers can never interleave their mutations.
   */
  async updateWatch(id: string, mutate: (w: WatchConfig) => void): Promise<WatchConfig | null> {
    const client = dbSql();
    return (await client.begin(async (tx) => {
      const locked = await tx<Record<string, unknown>[]>`select data from ns_watches where id = ${id} for update`;
      if (locked.length === 0) return null;
      const watch = locked[0].data as WatchConfig;
      const next = JSON.parse(JSON.stringify(watch)) as WatchConfig;
      mutate(next);
      next.updatedAt = Date.now();
      await tx`update ns_watches set data = ${tx.json(next as never)} where id = ${id}`;
      return next;
    })) as WatchConfig | null;
  }
  async clearWatches(): Promise<void> {
    await dbSql()`delete from ns_watches`;
  }

  // telegram updates: ATOMIC at-most-once claim (unique pk + insert-if-absent)
  async claimUpdate(updateId: number | undefined): Promise<boolean> {
    if (updateId === undefined) return true; // no id → nothing to dedupe on (historical behavior)
    await this.ready();
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`insert into ns_seen_updates (update_id)
      values (${updateId})
      on conflict (update_id) do nothing
      returning update_id`;
    return rows.length > 0;
  }
  async isUpdateClaimed(updateId: number | undefined): Promise<boolean> {
    if (updateId === undefined) return false;
    await this.ready();
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`select 1 from ns_seen_updates where update_id = ${updateId}`;
    return rows.length > 0;
  }
  async clearSeenUpdates(): Promise<void> {
    await dbSql()`delete from ns_seen_updates`;
  }

  // named state documents (scheduler tick state)
  async readNamed<T>(name: string): Promise<T | null> {
    await this.ready();
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`select data from ns_kv where name = ${name}`;
    if (rows.length === 0) return null;
    const data = rows[0].data;
    // The column is jsonb; if a driver version hands it back as text, decode it.
    return typeof data === "string" ? (JSON.parse(data) as T) : (data as T);
  }
  async writeNamed<T>(name: string, value: T): Promise<void> {
    await this.ready();
    const client = dbSql();
    await client`insert into ns_kv (name, data) values (${name}, ${JSON.stringify(value)}::jsonb)
      on conflict (name) do update set data = excluded.data, updated_at = now()`;
  }
  async deleteNamed(name: string): Promise<void> {
    await dbSql()`delete from ns_kv where name = ${name}`;
  }

  // leases: atomic ttl lease with steal-on-expiry (INSERT ... ON CONFLICT)
  async acquireLease(name: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    await this.ready();
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`insert into ns_leases (name, pid, expires_at)
      values (${name}, ${process.pid}, now() + (${ttlMs}::text || ' milliseconds')::interval)
      on conflict (name) do update
        set pid = excluded.pid, expires_at = excluded.expires_at
        where ns_leases.expires_at < now()
      returning name`;
    if (rows.length === 0) return null; // another live worker holds the lease
    return () => this.releaseLease(name);
  }
  /** Owner-conditional release: a late release of a REPLACED lease is a no-op. */
  private async releaseLease(name: string): Promise<void> {
    const client = dbSql();
    await client`delete from ns_leases where name = ${name} and pid = ${process.pid}`.catch(() => undefined);
  }
  async clearLease(name: string): Promise<void> {
    await dbSql()`delete from ns_leases where name = ${name}`;
  }
  async readLease(name: string): Promise<{ pid: number; expiresAt: number } | null> {
    await this.ready();
    const client = dbSql();
    const rows = await client<Record<string, unknown>[]>`select pid, expires_at from ns_leases where name = ${name}`;
    if (rows.length === 0) return null;
    return { pid: Number(rows[0].pid), expiresAt: new Date(rows[0].expires_at as string).getTime() };
  }
}

/* ------------------------------------------------------------------ */
/* Backend selection                                                    */
/* ------------------------------------------------------------------ */

interface StorageGlobal {
  __nightshiftPersistence?: Persistence;
}

const g2 = globalThis as typeof globalThis & StorageGlobal;

function singleton(kind: PersistenceProvider): Persistence {
  const existing = g2.__nightshiftPersistence;
  if (existing && existing.provider === kind) return existing;
  if (existing) void dbClose().catch(() => undefined); // orphan postgres client
  const next: Persistence = kind === "postgres" ? new PostgresPersistence() : new FilePersistence();
  g2.__nightshiftPersistence = next;
  return next;
}

export interface StorageDecision {
  persistence: Persistence;
  /** Why this backend was selected (surfaced by /api/status). */
  reason: "database-configured" | "file-default" | "file-fallback-without-database";
}

/**
 * Chooses the persistence backend ONCE per runtime:
 *  - a configured database (NIGHTSHIFT_DATABASE_URL or DATABASE_URL) always wins;
 *  - otherwise the JSON file stores run as they always have;
 *  - on Vercel without a database the writable-/tmp fallback still works so
 *    the app keeps functioning, and /api/status reports it loudly as NOT durable.
 */
export function choosePersistence(): StorageDecision {
  if (isDatabaseConfigured()) {
    return { persistence: singleton("postgres"), reason: "database-configured" };
  }
  if (isVercelRuntime()) {
    return { persistence: singleton("file"), reason: "file-fallback-without-database" };
  }
  return { persistence: singleton("file"), reason: "file-default" };
}

export function persistence(): Persistence {
  return choosePersistence().persistence;
}

/**
 * Test hook: forgets the chosen backend so the next persistence() re-decides.
 * Lets tests pin a backend by manipulating the selection env vars first.
 */
export function resetPersistenceForTests(): void {
  g2.__nightshiftPersistence = undefined;
}
