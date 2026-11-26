import postgres from "postgres";

/**
 * Postgres connection for NIGHTSHIFT's durable stores.
 *
 * Serverless-safety: the client pool is capped at ONE connection and reuses
 * the same client across hot reloads via the global cache, so concurrent
 * serverless invocations never multiply connections. `prepare: false` is
 * required when a pooled connection string (like Neon's pooled endpoint)
 * may back the connection. The client connects lazily: configuration alone
 * never opens a socket.
 */

/**
 * Every configured Postgres URL, in preference order, de-duplicated.
 * A deployment can legitimately carry more than one (a pooled URL, a direct
 * URL, an environment-specific override); the store connects to whichever
 * one actually answers instead of dying on a stale entry.
 */
function candidateUrls(): string[] {
  const configured = [process.env.NIGHTSHIFT_DATABASE_URL, process.env.DATABASE_URL]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  // The direct/unpooled twin is only a fallback: when both primary variables are
  // blank the deployment has deliberately opted out of Postgres (tests, local
  // file store), and a leftover variable must not overrule that.
  const fallback = configured.length > 0 ? [(process.env.DATABASE_URL_UNPOOLED ?? "").trim()] : [];
  return [...configured, ...fallback].filter((v, i, all) => v.length > 0 && all.indexOf(v) === i);
}

/** Active URL chosen by the last successful probe (per process). */
function activeUrl(): string | undefined {
  return g.__nightshiftActiveUrl ?? candidateUrls()[0];
}

export function databaseUrl(): string | undefined {
  return activeUrl();
}

export function isDatabaseConfigured(): boolean {
  return candidateUrls().length > 0;
}

/**
 * Connections per process. One is right for serverless, where many instances
 * each hold a single connection. Tests and CLIs can raise it to exercise real
 * concurrency: a one-connection pool serializes writers, so a concurrency test
 * against it is not testing concurrency at all.
 */
/**
 * Connections per runtime. Two is the floor on purpose: a page that reads two
 * collections in parallel (Promise.all) issued two queries at once, and with a
 * single-connection pool the second one waited for a connection that was never
 * handed to it, so the request hung forever against a perfectly healthy
 * database. Two connections still sit comfortably behind a pooled endpoint
 * (pgbouncer), so serverless safety is preserved.
 */
function poolMax(): number {
  const raw = Number(process.env.NIGHTSHIFT_DB_POOL_MAX ?? "");
  if (!Number.isFinite(raw) || raw === 0) return 2;
  const n = Math.floor(raw);
  return n >= 2 && n <= 20 ? n : 2;
}

interface PostgresGlobal {
  __nightshiftSql?: postgres.Sql;
  __nightshiftActiveUrl?: string;
  __nightshiftResolving?: Promise<DbResolution>;
  __nightshiftMigrated?: Promise<Array<{ version: number; name: string }>>;
}

const g = globalThis as typeof globalThis & PostgresGlobal;

export interface DbResolution {
  ok: boolean;
  /** Host of the URL actually in use (never credentials). */
  host: string | null;
  /** Every candidate tried, host + failure class only. */
  tried: Array<{ host: string; ok: boolean; error?: string }>;
}

/** Hard cap on a single candidate probe: DNS and TCP stalls included. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(label) as Error & { code?: string };
      err.code = "timeout";
      reject(err);
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/** Hostname only: safe to log and to surface in status responses. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable url)";
  }
}

/** Hard client-side cap for one shared-client query. */
const QUERY_TIMEOUT_MS = 15_000;

/**
 * Client-side timeout for one query. statement_timeout is enforced by the
 * SERVER, so it protects nothing against the failure where the server never
 * receives the query at all: a suspended Neon compute behind its pooled
 * endpoint accepts TCP, accepts auth, takes the query — and answers nothing.
 * The request then hangs until the platform kills it and the browser shows a
 * dropped connection. Bounding the promise client-side turns that class of
 * outage into a fast, honest error the routes already know how to render.
 */
export function boundedQuery<T>(work: Promise<T>, ms = QUERY_TIMEOUT_MS, label = "database query timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(label) as Error & { code?: string };
      err.code = "QUERY_TIMEOUT";
      reject(err);
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/**
 * Lazy shared client; never opens a connection until a query runs. Every
 * query issued through it carries the client-side bound above — callers get
 * that guarantee for free and must not bypass this factory.
 */
function sql(): postgres.Sql {
  if (g.__nightshiftSql) return g.__nightshiftSql;
  const url = activeUrl();
  if (!url) throw new Error("no database configured: NIGHTSHIFT_DATABASE_URL / DATABASE_URL is missing");
  const real = postgres(url, {
    max: poolMax(), // small per runtime, pooled upstream
    // A pooled endpoint can accept a connection and then never answer (a
    // cancelled serverless invocation can leave a transaction behind). Without
    // these, the request hangs until the platform kills it and the caller sees
    // nothing; with them it fails in seconds with a real error.
    queue_timeout: 8_000,
    connection: { statement_timeout: 12_000 },
    prepare: false, // pgbouncer/Neon pooled endpoints do not support named prepared statements
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}, // CREATE TABLE IF NOT EXISTS notices are noise
  });
  // Bounded facade over the real client: the tagged-template call and unsafe()
  // carry the client-side timeout; everything else passes through untouched.
  const tagged = real as unknown as (query: TemplateStringsArray, ...args: unknown[]) => Promise<unknown>;
  const unsafeFn = real.unsafe as unknown as (query: string, ...args: unknown[]) => Promise<unknown>;
  const bound = ((query: TemplateStringsArray, ...args: unknown[]) => boundedQuery(tagged(query, ...args))) as postgres.Sql;
  bound.unsafe = ((query: string, ...args: unknown[]) => boundedQuery(unsafeFn(query, ...args))) as typeof real.unsafe;
  bound.end = (...args: Parameters<typeof real.end>) => real.end(...args);
  const proxy = new Proxy(bound, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      const value = Reflect.get(real, prop, real);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
    apply(target, _thisArg, args) {
      return (target as unknown as (...a: unknown[]) => Promise<unknown>)(...args) as never;
    },
  }) as postgres.Sql;
  g.__nightshiftSql = proxy;
  return g.__nightshiftSql;
}

/**
 * Picks the first configured URL that answers `select 1`, once per process.
 * Probes are read-only and short-lived; a failed candidate is reported by
 * hostname and error code only. Never throws.
 */
export function resolveDatabase(): Promise<DbResolution> {
  // Already connected in this process: answer from the live client.
  if (g.__nightshiftSql && g.__nightshiftActiveUrl) {
    const host = hostOf(g.__nightshiftActiveUrl);
    return Promise.resolve({ ok: true, host, tried: [{ host, ok: true }] });
  }
  // Share one in-flight attempt between concurrent callers, but only while it
  // is in flight. Keeping the settled promise would freeze the first outcome
  // for the life of the process: one stalled probe or one unreachable moment
  // would hang or fail every later request until a restart.
  if (g.__nightshiftResolving) return g.__nightshiftResolving;
  const attempt = (async (): Promise<DbResolution> => {
    const urls = candidateUrls();
    if (urls.length === 0) return { ok: false, host: null, tried: [] };
    const tried: DbResolution["tried"] = [];
    for (const url of urls) {
      const host = hostOf(url);
      let probe: postgres.Sql | undefined;
      try {
        probe = postgres(url, {
          max: poolMax(),
          queue_timeout: 6_000,
          connection: { statement_timeout: 8_000 },
          prepare: false,
          connect_timeout: 6,
          idle_timeout: 0,
          onnotice: () => {},
        });
        await withTimeout(probe`select 1`, 7000, "probe timeout");
        tried.push({ host, ok: true });
        g.__nightshiftActiveUrl = url;
        if (g.__nightshiftSql && g.__nightshiftSql !== probe) {
          await g.__nightshiftSql.end({ timeout: 5 }).catch(() => undefined);
        }
        g.__nightshiftSql = probe;
        return { ok: true, host, tried };
      } catch (err) {
        const code =
          typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "error";
        tried.push({ host, ok: false, error: code });
        console.error(`database candidate ${host} unavailable: ${code}`);
        if (probe) {
          try {
            await withTimeout(probe.end({ timeout: 2 }), 2500, "close timeout");
          } catch {
            /* a failed probe's socket may already be gone */
          }
        }
      }
    }
    return { ok: false, host: null, tried };
  })();
  g.__nightshiftResolving = attempt;
  void attempt.then(
    () => {
      if (g.__nightshiftResolving === attempt) g.__nightshiftResolving = undefined;
    },
    () => {
      if (g.__nightshiftResolving === attempt) g.__nightshiftResolving = undefined;
    },
  );
  return attempt;
}

/** Cheap connectivity probe for /api/status (never throws). */
export async function dbHealth(): Promise<"ok" | "unreachable"> {
  try {
    const resolved = await resolveDatabase();
    if (!resolved.ok) return "unreachable";
    await sql()`select 1`;
    return "ok";
  } catch (err) {
    console.error("database health check failed:", err instanceof Error ? err.message : err);
    return "unreachable";
  }
}

/** Closes the shared client (tests and CLI only). */
export async function dbClose(): Promise<void> {
  if (g.__nightshiftSql) {
    await g.__nightshiftSql.end({ timeout: 5 }).catch(() => undefined);
    g.__nightshiftSql = undefined;
  }
  g.__nightshiftMigrated = undefined;
  // Let the next caller re-probe candidates (CLI and tests run repeatedly).
  g.__nightshiftResolving = undefined;
  g.__nightshiftActiveUrl = undefined;
}

/* ------------------------------------------------------------------ */
/* Versioned migrations                                                 */
/* ------------------------------------------------------------------ */

export const MIGRATIONS: Array<{ version: number; name: string; statements: string[] }> = [
  {
    version: 1,
    name: "initialize document tables, dedup table, leases and indexes",
    statements: [
      `create table if not exists ns_migrations (
         version integer primary key,
         name text not null,
         applied_at timestamptz not null default now()
       )`,
      `create table if not exists ns_tasks (
         id text primary key,
         created_at bigint not null,
         state text not null,
         data jsonb not null
       )`,
      `create index if not exists ns_tasks_created_idx on ns_tasks (created_at desc)`,
      `create index if not exists ns_tasks_state_idx on ns_tasks (state)`,
      `create table if not exists ns_watches (
         id text primary key,
         created_at bigint not null,
         data jsonb not null
       )`,
      `create index if not exists ns_watches_created_idx on ns_watches (created_at desc)`,
      `create table if not exists ns_kv (
         name text primary key,
         data jsonb not null,
         updated_at timestamptz not null default now()
       )`,
      `create table if not exists ns_seen_updates (
         update_id bigint primary key,
         seen_at timestamptz not null default now()
       )`,
      `create table if not exists ns_leases (
         name text primary key,
         pid integer not null,
         expires_at timestamptz not null
       )`,
    ],
  },
];

/**
 * Applies all pending migrations. Safe to call from every cold serverless
 * instance and from the db:migrate CLI: statement list is explicitly
 * idempotent, and each applied version is recorded exactly once.
 *
 * Single-flight per process, and the success is remembered. Two migrations
 * running at once deadlock on the schema tables and never return; a page that
 * reads two collections in parallel (Promise.all) does exactly that on its very
 * first request against a cold instance, which is how a request could hang
 * forever with a perfectly healthy database.
 */
export function dbMigrate(): Promise<Array<{ version: number; name: string }>> {
  if (g.__nightshiftMigrated) return g.__nightshiftMigrated;
  const attempt = runMigrations();
  g.__nightshiftMigrated = attempt;
  // A failed migration must be retried by the next caller instead of being
  // cached as the permanent answer for this process.
  attempt.catch(() => {
    if (g.__nightshiftMigrated === attempt) g.__nightshiftMigrated = undefined;
  });
  return attempt;
}

async function runMigrations(): Promise<Array<{ version: number; name: string }>> {
  const resolved = await resolveDatabase();
  if (!resolved.ok) {
    const detail = resolved.tried.map((t) => `${t.host}: ${t.error ?? "unknown"}`).join("; ");
    throw new Error(`no reachable database (${detail || "nothing configured"})`);
  }
  const client = sql();
  const applied: Array<{ version: number; name: string }> = [];
  await client`create table if not exists ns_migrations (
    version integer primary key,
    name text not null,
    applied_at timestamptz not null default now()
  )`;
  for (const migration of MIGRATIONS) {
    const done = await client`select version from ns_migrations where version = ${migration.version}`;
    if (done.length > 0) continue;
    for (const statement of migration.statements) {
      await client.unsafe(statement);
    }
    await client`insert into ns_migrations (version, name) values (${migration.version}, ${migration.name})
      on conflict (version) do nothing`;
    applied.push({ version: migration.version, name: migration.name });
  }
  return applied;
}

export { sql as dbSql };
