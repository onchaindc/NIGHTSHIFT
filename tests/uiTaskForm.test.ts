import { describe, expect, it } from "vitest";
import { buildTaskRequest, cleanLimit, isDuplicateGoal } from "@/lib/ui/taskForm";

/**
 * Regression tests for the composer fixes:
 * entering a goal either by button or Enter key, validation, the budget and
 * approval values reaching the API payload, and the duplicate guard for
 * already-live goals.
 */

const ok = (payload: object) => ({ ok: true, payload: expect.objectContaining(payload) });

describe("cleanLimit", () => {
  it("treats an empty field as the server default (valid, unset)", () => {
    expect(cleanLimit("")).toEqual({ cents: null, valid: true });
  });

  it("parses a plain dollar amount into cents", () => {
    expect(cleanLimit("1.00")).toEqual({ cents: 100, valid: true });
  });

  it("rounds to whole cents", () => {
    expect(cleanLimit("0.015")).toEqual({ cents: 2, valid: true });
  });

  it("rejects zero and non-positive values", () => {
    expect(cleanLimit("0")).toEqual({ cents: null, valid: false });
    expect(cleanLimit("0.00")).toEqual({ cents: null, valid: false });
  });
});

describe("isDuplicateGoal", () => {
  it("matches case-insensitively and trims", () => {
    expect(isDuplicateGoal("  what is the current BTC price in USD? ", ["What is the current BTC price in USD?"])).toBe(true);
  });

  it("does not match a different goal", () => {
    expect(isDuplicateGoal("What is the current ETH price in USD?", ["What is the current BTC price in USD?"])).toBe(false);
  });
});

describe("buildTaskRequest", () => {
  it("builds the payload for a valid, button-or-Enter submission", () => {
    const built = buildTaskRequest({
      goal: "What is the current BTC price in USD?",
      limitRaw: "1.00",
      requiresApproval: false,
      liveGoals: [],
    });
    expect(built.ok).toBe(true);
    const { goal, spendLimitUsdCents, requiresApproval } =
      built.ok ? built.payload : ({} as { goal?: string; spendLimitUsdCents?: number; requiresApproval?: boolean });
    expect({ goal, spendLimitUsdCents, requiresApproval }).toEqual({
      goal: "What is the current BTC price in USD?",
      spendLimitUsdCents: 100,
      requiresApproval: false,
    });
  });

  it("does not send a spend limit when the field is left empty (server default applies)", () => {
    const built = buildTaskRequest({ goal: "g", limitRaw: "", requiresApproval: true, liveGoals: [] });
    if (!built.ok) throw new Error("expected ok");
    expect(built.payload.spendLimitUsdCents).toBeUndefined();
    expect(built.payload.requiresApproval).toBe(true);
  });

  it("rejects an empty goal", () => {
    const built = buildTaskRequest({ goal: "   ", limitRaw: "1.00", requiresApproval: false, liveGoals: [] });
    expect(built.ok).toBe(false);
    // @ts-expect-error error branch
    expect(built.error).toBe("goalEmpty");
  });

  it("rejects an invalid budget without wiping the goal", () => {
    const built = buildTaskRequest({ goal: "_valid goal_", limitRaw: "0.00", requiresApproval: false, liveGoals: [] });
    expect(built.ok).toBe(false);
    // @ts-expect-error error branch
    expect(built.error).toBe("limitInvalid");
  });

  it("blocks a duplicate submission of a goal that is already live", () => {
    const live = ["What is the current BTC price in USD?"];
    for (const variant of [
      "What is the current BTC price in USD?",
      "what is the current btc price in usd?",
      "  What is the current BTC price in USD?  ",
    ]) {
      const built = buildTaskRequest({ goal: variant, limitRaw: "1.00", requiresApproval: false, liveGoals: live });
      expect(built.ok).toBe(false);
      // @ts-expect-error error branch
      expect(built.error).toBe("goalDuplicate");
    }
  });

  it("allows the same goal once the previous task is no longer live", () => {
    const built = buildTaskRequest({
      goal: "What is the current BTC price in USD?",
      limitRaw: "1.00",
      requiresApproval: false,
      liveGoals: [],
    });
    expect(built).toEqual(ok({ goal: "What is the current BTC price in USD?" }));
  });

  it("sends the approval flag the switch controls", () => {
    const built = buildTaskRequest({ goal: "g", limitRaw: "0.50", requiresApproval: true, liveGoals: [] });
    expect(built).toEqual(ok({ spendLimitUsdCents: 50, requiresApproval: true }));
  });

  it("trims surrounding whitespace from the goal", () => {
    const built = buildTaskRequest({ goal: "  g  ", limitRaw: "", requiresApproval: false, liveGoals: [] });
    expect(built).toEqual(ok({ goal: "g" }));
  });
});
