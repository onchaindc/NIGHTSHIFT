/**
 * db:verify — proves the configured Postgres store is genuinely usable.
 *
 * Usage: bun run db:verify
 *
 * 1. resolves the configured URL (probes every candidate, host only in output)
 * 2. applies the versioned schema (idempotent)
 * 3. writes a probe row to ns_tasks, reads it back, then removes ONLY that row
 *
 * It never prints credentials, never touches existing rows, and never calls the
 * network/payment path.
 */
import { dbClose, dbMigrate, dbSql, isDatabaseConfigured, resolveDatabase } from "../src/lib/db/client";

if (!isDatabaseConfigured()) {
  console.error("No database configured. Set DATABASE_URL (or NIGHTSHIFT_DATABASE_URL).");
  process.exit(1);
}

// Watchdog: a wedged socket must never hang a verification run.
const watchdog = setTimeout(() => {
  console.error("verification timed out after 45s");
  process.exit(1);
}, 45_000);
watchdog.unref?.();

const resolved = await resolveDatabase();
if (!resolved.ok) {
  console.error("No reachable database:");
  for (const t of resolved.tried) console.error(`  ${t.host}: ${t.error ?? "unreachable"}`);
  process.exit(1);
}
console.log(`connected: ${resolved.host}`);

const applied = await dbMigrate();
console.log(applied.length ? `schema: applied ${applied.length} migration(s)` : "schema: already up to date");

const sql = dbSql();
const id = `verify-${Date.now().toString(36)}`;
let wrote = false;
try {
  const before = await sql<{ n: number }[]>`select count(*)::int as n from ns_tasks`;
  await sql`insert into ns_tasks (id, created_at, state, data)
    values (${id}, ${Date.now()}, ${"verify"}, ${sql.json({ probe: true, note: "db:verify round-trip" })})`;
  wrote = true;
  const rows = await sql`select id, state from ns_tasks where id = ${id}`;
  if (rows.length !== 1) throw new Error("probe row was not read back");
  const after = await sql<{ n: number }[]>`select count(*)::int as n from ns_tasks`;
  console.log(`ns_tasks: readable (${before[0].n} existing), write + read ok, now ${after[0].n}`);
} finally {
  if (wrote) {
    const removed = await sql`delete from ns_tasks where id = ${id}`;
    console.log(`cleanup: removed ${removed.count} probe row(s)`);
  }
  await dbClose();
}
