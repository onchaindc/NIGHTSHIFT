/**
 * db:migrate — applies NIGHTSHIFT's versioned Postgres migrations.
 *
 * Usage: bun scripts/db-migrate.ts
 * Requires NIGHTSHIFT_DATABASE_URL (or DATABASE_URL) in the environment.
 * Idempotent: every pending version is applied exactly once and recorded in
 * ns_migrations; re-running on an up-to-date database is a no-op.
 */
import { dbClose, dbMigrate, isDatabaseConfigured } from "../src/lib/db/client";

if (!isDatabaseConfigured()) {
  console.error("No database configured. Set NIGHTSHIFT_DATABASE_URL (or DATABASE_URL).");
  process.exit(1);
}

try {
  const applied = await dbMigrate();
  if (applied.length === 0) {
    console.log("Database schema is up to date (no pending migrations).");
  } else {
    for (const migration of applied) {
      console.log(`Applied migration ${migration.version}: ${migration.name}`);
    }
  }
} finally {
  await dbClose();
}
