import { describe, expect, it } from "vitest";

import type { TaskRecord } from "@/lib/engine/types";
import { spendLabelForTask } from "@/lib/minds/spend-label";

/**
 * The spend breakdown labels ("where the money went") must always be human
 * names. The budget strip once printed a capability step's whole machine
 * target — a JSON blob with slug, mode and every input object — as the
 * line-item name. These tests pin the repair.
 */

function taskWith(kind: string, target: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t",
    createdAt: 1,
    updatedAt: 1,
    state: "completed",
    goal: "g",
    jobType: "capability_run",
    plan: [{ id: "s", kind, description: "d", target }],
    spend: { limitUsdCents: 100, spentUsdCents: 6, entries: [] },
    ...overrides,
  } as unknown as TaskRecord;
}

describe("spendLabelForTask", () => {
  it("resolves a Minds capability run's JSON target to the Mind's display name", () => {
    const target = JSON.stringify({
      slug: "chainforensics",
      mode: "intel",
      inputs: { tx_lookup: { tx_hash: "0xabc" } },
    });
    expect(spendLabelForTask(taskWith("capability_ask", target))).toBe("ChainForensics");
  });

  it("falls back to the raw slug when the registry does not know it", () => {
    const target = JSON.stringify({ slug: "some-unknown-slug", mode: "free", inputs: {} });
    expect(spendLabelForTask(taskWith("capability_free", target))).toBe("some-unknown-slug");
  });

  it("names Deal Desk runs after the desk, never the investigation config", () => {
    const target = JSON.stringify({
      investigationId: "id",
      reference: "NS-CP-1",
      type: "counterparty_due_diligence",
      mode: "free",
      capabilities: [{ key: "counterparty-intelligence:registry" }],
      inputs: {},
    });
    expect(spendLabelForTask(taskWith("desk_baseline", target))).toBe("Deal Desk");
    expect(spendLabelForTask(taskWith("desk_intel", target))).toBe("Deal Desk");
    expect(spendLabelForTask(taskWith("desk_report", target))).toBe("Deal Desk");
  });

  it("truncates a long non-JSON target to one short line", () => {
    const target = "a".repeat(120);
    const label = spendLabelForTask(taskWith("counterparty_ask", target));
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label.endsWith("…")).toBe(true);
  });

  it("degrades gracefully for jobs without a plan step", () => {
    expect(spendLabelForTask(taskWith("noop", "{}", { plan: [], jobType: "protocol_watch" }))).toBe("Protocol Watch");
    expect(spendLabelForTask(taskWith("noop", "{}", { plan: [], jobType: "terminal_request" }))).toBe("Terminal");
    expect(spendLabelForTask(taskWith("noop", "{}", { plan: [], jobType: "capability_run" }))).toBe("Other");
  });
});
