import { describe, expect, it } from "vitest";

import { stallView } from "@/lib/acp/buyer-stages";

/**
 * The stalled-job view — honest waiting, no invented progress. "Stalled"
 * must mean only "this is taking unusually long, and here is what that
 * means", always with the money-truth attached, and the expiry countdown
 * must come from real on-chain/record timestamps only.
 */

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function iso(msBeforeNow: number): string {
  return new Date(NOW - msBeforeNow).toISOString();
}

function view(over: {
  phase: Parameters<typeof stallView>[0]["phase"];
  createdAtMinAgo?: number;
  providerUpdatedMinAgo?: number | null;
  expiresAtSeconds?: number | null;
}) {
  return stallView({
    phase: over.phase,
    createdAt: iso((over.createdAtMinAgo ?? 0) * MIN),
    providerUpdatedAt: over.providerUpdatedMinAgo === undefined || over.providerUpdatedMinAgo === null ? null : iso(over.providerUpdatedMinAgo * MIN),
    expiresAtSeconds: over.expiresAtSeconds ?? null,
    nowMs: NOW,
  });
}

describe("stallView — submitted (provider has not acknowledged)", () => {
  it("flags an unusually long silence and attaches the money-truth", () => {
    const v = view({ phase: "submitted", createdAtMinAgo: 20 });
    expect(v.stalled).toBe(true);
    expect(v.stallTitle).toContain("20 minutes");
    expect(v.stallDetail).toContain("nothing is at risk");
    expect(v.waitingMinutes).toBe(20);
    expect(v.sinceProgressMinutes).toBe(20);
  });

  it("stays quiet inside the normal window", () => {
    expect(view({ phase: "submitted", createdAtMinAgo: 5 }).stalled).toBe(false);
  });
});

describe("stallView — reading", () => {
  it("names the un-priced wait after the threshold", () => {
    const v = view({ phase: "reading", createdAtMinAgo: 30, providerUpdatedMinAgo: 28 });
    expect(v.stalled).toBe(true);
    expect(v.stallTitle).toContain("without being priced");
    expect(v.stallDetail).toContain("Pricing is the provider's on-chain acceptance act");
  });

  it("does not stall when the provider moved recently", () => {
    // Created 30 min ago but the provider touched the job 3 min ago.
    expect(view({ phase: "reading", createdAtMinAgo: 30, providerUpdatedMinAgo: 3 }).stalled).toBe(false);
  });
});

describe("stallView — processing names the approval gate, not a failure", () => {
  it("flags a very long run and explains the human gate", () => {
    const v = view({ phase: "processing", createdAtMinAgo: 200, providerUpdatedMinAgo: 200 });
    expect(v.stalled).toBe(true);
    expect(v.stallTitle).toContain("3 h 20 m");
    expect(v.stallDetail).toContain("human approval gate");
  });

  it("stays quiet for a normal funded run", () => {
    expect(view({ phase: "processing", createdAtMinAgo: 30, providerUpdatedMinAgo: 29 }).stalled).toBe(false);
  });
});

describe("stallView — buyer-action phases never read as stalls", () => {
  it("awaiting_payment is the buyer's own turn, however long it sits", () => {
    expect(view({ phase: "awaiting_payment", createdAtMinAgo: 600, providerUpdatedMinAgo: 590 }).stalled).toBe(false);
  });
});

describe("stallView — on-chain expiry countdown", () => {
  it("counts hours and minutes while open", () => {
    const v = view({ phase: "awaiting_payment", createdAtMinAgo: 10, expiresAtSeconds: Math.floor(NOW / 1000) + 90 * 60 });
    expect(v.expiryNote).toContain("1 h 30 m");
    expect(v.expired).toBe(false);
  });

  it("counts minutes under an hour", () => {
    const v = view({ phase: "awaiting_payment", createdAtMinAgo: 10, expiresAtSeconds: Math.floor(NOW / 1000) + 45 * 60 });
    expect(v.expiryNote).toContain("45 m");
  });

  it("says expired once the deadline passed", () => {
    const v = view({ phase: "submitted", createdAtMinAgo: 30, expiresAtSeconds: Math.floor(NOW / 1000) - 1 });
    expect(v.expired).toBe(true);
    expect(v.expiryNote).toContain("expired on-chain");
    expect(v.expiryNote).toContain("unfunded job simply lapses");
  });

  it("says nothing when the expiry is unknown", () => {
    const v = view({ phase: "submitted", createdAtMinAgo: 2, expiresAtSeconds: null });
    expect(v.expiryNote).toBe(null);
    expect(v.expired).toBe(false);
  });
});
