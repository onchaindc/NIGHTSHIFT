import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the engine's task store per test run so tests never touch real data.
process.env.NIGHTSHIFT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "nightshift-engine-test-"));

// Hermetic tests: the workspace may auto-load a REAL deployed DATABASE_URL
// (Neon) into this process. No suite should accidentally run against the
// durable database by default, so rename it to a test-only variable that
// persistence.test.ts's postgres block opts back in for itself.
const deployedDbUrl =
  process.env.NIGHTSHIFT_DATABASE_URL ?? process.env.NIGHTSHIFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
delete process.env.NIGHTSHIFT_DATABASE_URL;
delete process.env.DATABASE_URL;
if (deployedDbUrl) process.env.NIGHTSHIFT_TEST_DATABASE_URL = deployedDbUrl;
process.env.NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS = "100";
// Test-only bot token: the adapter's config check requires a token name to be
// present; no real Telegram call can use this fake value.
process.env.TELEGRAM_BOT_TOKEN = "unit-test-fake-token";
// Keep the engine away from real paid inference in unit tests.
delete process.env.TELEGRAPH_EVM_PRIVATE_KEY;
