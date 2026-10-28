import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the engine's task store per test run so tests never touch real data.
process.env.NIGHTSHIFT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "nightshift-engine-test-"));
process.env.NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS = "100";
// Test-only bot token: the adapter's config check requires a token name to be
// present; no real Telegram call can use this fake value.
process.env.TELEGRAM_BOT_TOKEN = "unit-test-fake-token";
// Keep the engine away from real paid inference in unit tests.
delete process.env.TELEGRAPH_EVM_PRIVATE_KEY;
