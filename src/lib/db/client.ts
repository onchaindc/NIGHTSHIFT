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

interface PostgresGlobal {
  __nightshiftSql?: postgres.Sql;
  __nightshiftActiveUrl?: string;
  __nightshiftResolving?: Promise<DbResolution>;
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

/** Lazy shared client; never opens a connection until a query runs. */
function sql(): postgres.Sql {
  if (g.__nightshiftSql) return g.__nightshiftSql;
  const url = activeUrl();
  if (!url) throw new Error("no database configured: NIGHTSHIFT_DATABASE_URL / DATABASE_URL is missing");
  g.__nightshiftSql = postgres(url, {
    max: 1, // serverless-safe: one connection per runtime, pooled upstream
    prepare: false, // pgbouncer/Neon pooled endpoints do not support named prepared statements
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}, // CREATE TABLE IF NOT EXISTS notices are noise
  });
  return g.__nightshiftSql;
}

/**
 * Picks the first configured URL that answers `select 1`, once per process.
 * Probes are read-only and short-lived; a failed candidate is reported by
 * hostname and error code only. Never throws.
 */
export function resolveDatabase(): Promise<DbResolution> {
  if (g.__nightshiftResolving) return g.__nightshiftResolving;
  g.__nightshiftResolving = (async (): Promise<DbResolution> => {
    const urls = candidateUrls();
    if (urls.length === 0) return { ok: false, host: null, tried: [] };
    const tried: DbResolution["tried"] = [];
    for (const url of urls) {
      const host = hostOf(url);
      let probe: postgres.Sql | undefined;
      try {
        probe = postgres(url, {
          max: 1,
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
  return g.__nightshiftResolving;
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
 */
export async function dbMigrate(): Promise<Array<{ version: number; name: string }>> {
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
