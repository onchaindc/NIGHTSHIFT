import { describe, expect, it } from "vitest";
import { humanize } from "@/lib/ui/humanize";

/**
 * Copy cleanup regressions: text the engine/adapter writes for operators must
 * never surface raw environment-variable names or implementation nomenclature
 * in user-facing renders (web UI or Telegram).
 */

const CAUSES = [
  "Telegraph paid inference is not configured: the task would require an X402 payment. Set TELEGRAPH_EVM_PRIVATE_KEY (a Base Sepolia wallet funded with test USDC) to enable real purchases.",
  "Cost: PAID intelligence (Telegraph). Requires TELEGRAPH_EVM_PRIVATE_KEY (a Base Sepolia wallet funded with test USDC). Maximum $1.00.",
  "no external trigger is configured (NIGHTSHIFT_EXTERNAL_CRON): scheduled Protocol Watch checks do not run",
  "authorization required: this deployment gates watch management behind a bearer token (NIGHTSHIFT_API_TOKEN)",
];

describe("user-facing copy cleanup", () => {
  it("never exposes environment variable names in operator-facing text", () => {
    for (const cause of CAUSES) {
      const shown = humanize(cause);
      for (const key of [
        "TELEGRAPH_EVM_PRIVATE_KEY",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_WEBHOOK_SECRET",
        "NIGHTSHIFT_API_TOKEN",
        "NIGHTSHIFT_EXTERNAL_CRON",
      ]) {
        expect(shown.includes(key), `expected no raw ${key} in: ${shown}`).toBe(false);
      }
    }
  });

  it("replaces technical references with clear words that keep the meaning", () => {
    expect(humanize(CAUSES[0])).toContain("the paid-research wallet");
    expect(humanize(CAUSES[1])).toContain("Maximum $1.00");
    expect(humanize(CAUSES[2])).toContain("the external scheduler setting");
    expect(humanize(CAUSES[3])).toContain("the operator token");
    // Three-letter acronyms that read fine stay untouched.
    expect(humanize("RPC read failed: HTTP 502")).toBe("RPC read failed: HTTP 502");
  });
});
