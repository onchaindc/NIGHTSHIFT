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

export function databaseUrl(): string | undefined {
  return (process.env.NIGHTSHIFT_DATABASE_URL || process.env.DATABASE_URL || "").trim() || undefined;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(databaseUrl());
}

interface PostgresGlobal {
  __nightshiftSql?: postgres.Sql;
}

const g = globalThis as typeof globalThis & PostgresGlobal;

/** Lazy shared client; never opens a connection until a query runs. */
function sql(): postgres.Sql {
  if (g.__nightshiftSql) return g.__nightshiftSql;
  const url = databaseUrl();
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

/** Cheap connectivity probe for /api/status (never throws). */
export async function dbHealth(): Promise<"ok" | "unreachable"> {
  try {
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
