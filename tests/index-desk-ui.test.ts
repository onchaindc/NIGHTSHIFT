import { describe, expect, it } from "vitest";

import {
  deskActivityRows,
  deskHrefWithTask,
  deskSessionView,
  deskSessionMode,
  deskSnapshot,
  deskTaskParam,
  displayMissingDimensions,
  friendlyDeskError,
  parseCustomWeights,
  parseSpendLimitUsd,
  restrictedViewVisible,
  sanitizeDeskMessage,
} from "@/lib/indexdesk/desk-ui";
import type { TaskRecord } from "@/lib/engine/types";

describe("custom weight parsing", () => {
  const symbols = ["WBTC", "ETH", "SOL"];

  it("accepts comma, newline and equals syntax", () => {
    expect(parseCustomWeights("WBTC: 40, ETH: 35, SOL: 25", symbols)).toEqual({
      ok: true,
      weights: { WBTC: 40, ETH: 35, SOL: 25 },
    });
    expect(parseCustomWeights("wbtc=50\neth=30\nsol=20", symbols)).toEqual({
      ok: true,
      weights: { WBTC: 50, ETH: 30, SOL: 20 },
    });
  });

  it("rejects non-numeric input instead of coercing it to zero", () => {
    const out = parseCustomWeights("WBTC: forty, ETH: 35, SOL: 25", symbols);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("WBTC");
    expect(parseCustomWeights("WBTC: 40, ETH: NaN, SOL: 25", symbols).ok).toBe(false);
  });

  it("rejects zero, negative, out-of-range and duplicate weights", () => {
    for (const raw of ["WBTC: 0, ETH: 50, SOL: 50", "WBTC: -5, ETH: 50, SOL: 50", "WBTC: 101, ETH: 50, SOL: 50"]) {
      expect(parseCustomWeights(raw, symbols).ok).toBe(false);
    }
    expect(parseCustomWeights("WBTC: 40, WBTC: 40, ETH: 20, SOL: 40", symbols).ok).toBe(false);
  });

  it("rejects unknown symbols and missing assets", () => {
    expect(parseCustomWeights("WBTC: 50, ETH: 50", symbols).ok).toBe(false);
    const unknown = parseCustomWeights("WBTC: 40, ETH: 30, SOL: 20, DOGE: 10", symbols);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("DOGE");
  });
});

describe("spend limit parsing", () => {
  it("converts dollars to cents and rejects invalid input", () => {
    expect(parseSpendLimitUsd("")).toEqual({ ok: true });
    expect(parseSpendLimitUsd("0.30")).toEqual({ ok: true, cents: 30 });
    expect(parseSpendLimitUsd("2")).toEqual({ ok: true, cents: 200 });
    expect(parseSpendLimitUsd("abc").ok).toBe(false);
    expect(parseSpendLimitUsd("0").ok).toBe(false);
    expect(parseSpendLimitUsd("-1").ok).toBe(false);
  });
});

describe("task snapshot: spend, terminal states and polling", () => {
  it("reads spend from the task record, not just the legacy top-level field", () => {
    const a = deskSnapshot({ task: { state: "executing", spend: { spentUsdCents: 3 } } });
    expect(a.spendUsdCents).toBe(3);
    const legacy = deskSnapshot({ task: { state: "executing" }, spend: { spentUsdCents: 7 } });
    expect(legacy.spendUsdCents).toBe(7);
    expect(deskSnapshot({ task: { state: "executing" } }).spendUsdCents).toBeNull();
  });

  it("stops polling on a redacted completion (previously polled forever)", () => {
    const snap = deskSnapshot({
      redacted: true,
      task: { state: "completed", spend: { spentUsdCents: 0 }, result: null },
    });
    expect(snap.terminal).toBe("completed");
    expect(snap.stopPolling).toBe(true);
    expect(snap.report).toBeNull();
    expect(snap.progress).toEqual([]);
  });

  it("stops polling on completed without a report, and on every terminal state", () => {
    expect(deskSnapshot({ task: { state: "completed" } }).stopPolling).toBe(true);
    for (const state of ["rejected", "blocked", "failed", "awaiting_approval"]) {
      const snap = deskSnapshot({ task: { state } });
      expect(snap.stopPolling).toBe(true);
      expect(snap.terminal).toBe(state);
    }
  });

  it("keeps polling while the task is running and stops when the task is gone", () => {
    expect(deskSnapshot({ task: { state: "executing" } }).stopPolling).toBe(false);
    expect(deskSnapshot({ task: { state: "planning" } }).stopPolling).toBe(false);
    expect(deskSnapshot({ task: null }).stopPolling).toBe(true);
  });

  it("surfaces the latest events as progress, without consecutive duplicates", () => {
    const snap = deskSnapshot({
      task: {
        state: "executing",
        events: [
          { message: "one" },
          { message: "one" },
          { message: "two" },
          { message: "three" },
          { message: "four" },
          { message: "five" },
        ],
      },
    });
    expect(snap.progress).toEqual(["two", "three", "four", "five"]);
  });

  it("strips private evidence and plan from a redacted task", () => {
    const snap = deskSnapshot({
      redacted: true,
      task: {
        state: "awaiting_approval",
        plan: [{ id: "x", kind: "index_baseline", description: "private", target: "" }],
        result: { evidence: [{ kind: "index_asset_finding", symbol: "ETH", totalCostUsdCents: 1, dimensions: [] }] },
      },
    });
    expect(snap.plan).toBeNull();
    expect(snap.evidence).toEqual([]);
  });
});

describe("session view", () => {
  it("maps GET /api/session modes and treats unknown shapes as unreadable", () => {
    expect(deskSessionMode({ mode: "operator" })).toBe("authenticated");
    expect(deskSessionMode({ mode: "anonymous" })).toBe("anonymous");
    expect(deskSessionMode({ mode: "unavailable" })).toBe("unavailable");
    expect(deskSessionMode(null)).toBe("unavailable");
  });
});

describe("URL persistence", () => {
  it("round-trips a task id and rejects unsafe values", () => {
    expect(deskTaskParam("?task=50508752-8867-4343-814d-d53b1e11e85d")).toBe(
      "50508752-8867-4343-814d-d53b1e11e85d",
    );
    expect(deskTaskParam("")).toBeNull();
    expect(deskTaskParam("?task=<script>")).toBeNull();
    expect(deskHrefWithTask("abc-123")).toBe("/minds/index-desk?task=abc-123");
    expect(deskHrefWithTask(null)).toBe("/minds/index-desk");
  });
});

describe("user-facing errors", () => {
  it("turns a 401 into a sign-in instruction and never leaks the credential name", () => {
    const message = friendlyDeskError(401, "authorization required: bearer token (NIGHTSHIFT_API_TOKEN)");
    expect(message).toContain("Operator sign-in");
    expect(message).not.toContain("NIGHTSHIFT");
    expect(message).not.toContain("bearer");
  });

  it("does not expose raw HTTP statuses or bearer values", () => {
    const message = friendlyDeskError(500, "The node answered HTTP 500: miner error 404");
    expect(message).not.toContain("HTTP 500");
    expect(sanitizeDeskMessage("Bearer abc123 was refused")).not.toContain("abc123");
  });

  it("passes validation messages through and handles transport/storage failures", () => {
    expect(friendlyDeskError(400, "Give the index a name of 2–120 characters.")).toContain("Give the index");
    expect(friendlyDeskError(0)).toContain("could not be reached");
    expect(friendlyDeskError(503)).toContain("storage is unavailable");
    expect(friendlyDeskError(404)).toContain("could not be found");
  });
});

describe("activity rows", () => {
  const base = {
    createdAt: 1,
    updatedAt: 1,
    state: "completed",
    plan: null,
    events: [],
    spend: { limitUsdCents: 0, spentUsdCents: 2, entries: [] },
    permissions: { allowedActions: [], requiresApproval: false, maxRetries: 0 },
    criteria: {},
    result: null,
    error: null,
    origin: { source: "web" },
  };

  it("lists readable desk tasks and skips redacted ones", () => {
    const rows = deskActivityRows([
      { ...base, id: "a", jobType: "index_desk", goal: 'Reconstitute index "Large Cap" (equal) over 2 assets: A, B' },
      { ...base, id: "b", jobType: "index_desk", goal: "" },
      { ...base, id: "c", jobType: "terminal_request", goal: "a terminal ask" },
    ] as unknown as TaskRecord[]);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(rows[0].title).toBe("Large Cap");
    expect(rows[0].href).toBe("/minds/index-desk?task=a");
  });
});

describe("session and restricted-view messaging", () => {
  it("distinguishes authenticated, anonymous and unreadable sessions", () => {
    expect(deskSessionView({ operatorSession: true })).toBe("authenticated");
    expect(deskSessionView({ operatorSession: false })).toBe("anonymous");
    expect(deskSessionView({})).toBe("anonymous");
    expect(deskSessionView(null)).toBe("unavailable");
  });

  it("shows restricted messaging only for a completed withheld report", () => {
    const running = deskSnapshot({ redacted: true, task: { state: "executing" } });
    expect(restrictedViewVisible(running)).toBe(false);

    const completed = deskSnapshot({ redacted: true, task: { state: "completed" } });
    expect(restrictedViewVisible(completed)).toBe(true);

    const rejected = deskSnapshot({ redacted: true, task: { state: "rejected" } });
    expect(restrictedViewVisible(rejected)).toBe(false);

    const full = deskSnapshot({ task: { state: "completed" } });
    expect(restrictedViewVisible(full)).toBe(false);
    expect(restrictedViewVisible(null)).toBe(false);
  });
});

describe("missing-dimension display", () => {
  it("deduplicates identical entries but keeps distinct reasons", () => {
    const rows = displayMissingDimensions([
      { scope: "portfolio", dimension: "Unpurchased dimensions", reason: "x" },
      { scope: "portfolio", dimension: "Unpurchased dimensions", reason: "x" },
      { scope: "asset", symbol: "ETH", dimension: "DEX liquidity", reason: "no pool" },
    ]);
    expect(rows).toHaveLength(2);
  });
});
