import { afterEach, describe, expect, it } from "vitest";

import { planForGoal, describeCriteria } from "@/lib/engine/planner";
import { verifyTask, VerificationFailure } from "@/lib/engine/verify";
import { createTask, defaultDeps } from "@/lib/engine/engine";
import { listTasks, resetStore } from "@/lib/engine/store";
import { persistence } from "@/lib/storage";

afterEach(async () => {
  await persistence().clearTasks();
  resetStore();
});

describe("plan-aware success criteria", () => {
  it("a free price plan states source, freshness and plausibility — never payment settlement or purchase ledger", () => {
    const plan = planForGoal("current ETH price in USD", 100, "free");
    expect(plan.criteria.primarySource).toBe("free");
    expect(plan.criteria.ownPaymentSettledOnChain).toBe(false);
    expect(plan.criteria.reconcileLedgerEntries).toBe(false);
    expect(plan.criteria.freeAssetLookup).toBe("ETH");
    expect(plan.criteria.answerMaxAgeSeconds).toBeGreaterThan(0);

    const lines = describeCriteria(plan.criteria).join("; ");
    expect(lines.includes("settlement")).toBe(false);
    expect(lines.includes("ledger")).toBe(false);
    expect(lines.includes("public-source USD lookup for ETH")).toBe(true);
    expect(lines.includes("plausible")).toBe(true);
    expect(lines.includes("fresher than")).toBe(true);
  });

  it("a free gas plan states the chain-read source without invented payment criteria and without a fake freshness window", () => {
    const plan = planForGoal("what is the current gas price on base", 100, "free");
    expect(plan.criteria.primarySource).toBe("free");
    expect(plan.criteria.ownPaymentSettledOnChain).toBe(false);
    expect(plan.criteria.reconcileLedgerEntries).toBe(false);
    const lines = describeCriteria(plan.criteria).join("; ");
    expect(lines.includes("settlement")).toBe(false);
    expect(lines.includes("ledger")).toBe(false);
    expect(lines.includes(`chain read of base`)).toBe(true);
  });

  it("a paid research plan keeps its purchase verification: node signal, settlement, ledger", () => {
    const plan = planForGoal("summarize the latest governance research", 100, "paid");
    expect(plan.criteria.ownPaymentSettledOnChain).toBe(true);
    expect(plan.criteria.reconcileLedgerEntries).toBe(true);
    const lines = describeCriteria(plan.criteria).join("; ");
    expect(lines.includes("settlement tx mined with success status")).toBe(true);
    expect(lines.includes("purchase ledger reconciles")).toBe(true);
  });

  it("the criteria recorded on a free task (the event the bot was showing) contain no payment requirements", async () => {
    await createTask(
      {
        goal: "current ETH price in USD",
        spendLimitUsdCents: 100,
        requiresApproval: false,
        origin: { source: "telegram", actor: "42" },
        mode: "free",
      },
      defaultDeps(),
    );
    const created = (await listTasks())[0];
    expect(created.criteria.primarySource).toBe("free");
    expect(created.criteria.ownPaymentSettledOnChain).toBe(false);
    const criteriaEvent = created.events.find((e) => e.type === "criteria_defined" && e.message.startsWith("Success criteria"));
    expect(criteriaEvent).toBeDefined();
    expect(criteriaEvent!.message.includes("settlement")).toBe(false);
    expect(criteriaEvent!.message.includes("ledger")).toBe(false);
    expect(criteriaEvent!.message.includes("fresher than")).toBe(true);
  });

  it("verification rejects a stale free lookup: freshness is a real check, not display text", async () => {
    const plan = planForGoal("current ETH price in USD", 100, "free");
    const task = {
      id: "stale-check",
      createdAt: 0,
      updatedAt: 0,
      state: "verifying" as const,
      goal: "current ETH price in USD",
      plan: plan.steps,
      events: [],
      spend: { limitUsdCents: 100, spentUsdCents: 0, entries: [] },
      permissions: { allowedActions: [], requiresApproval: false, maxRetries: 0 },
      criteria: plan.criteria,
      result: null,
      error: null,
      origin: { source: "web" as const, actor: "test" },
    };
    const oldFetchedAt = new Date(Date.now() - 60_000).toISOString(); // 60s old, limit is 300? use a short window
    task.criteria = { ...plan.criteria, answerMaxAgeSeconds: 30 };
    await expect(
      verifyTask(task, { freeLookup: { url: "https://public", asset: "eth", priceUsd: 2249.65, fetchedAt: oldFetchedAt } }, defaultDeps()),
    ).rejects.toThrow(/fresher than 30s/);
    // And a fresh read of the same goal still completes:
    task.criteria = { ...plan.criteria, answerMaxAgeSeconds: 30 };
    await expect(
      verifyTask(task, { freeLookup: { url: "https://public", asset: "eth", priceUsd: 2249.65, fetchedAt: new Date().toISOString() } }, defaultDeps()),
    ).resolves.toBeUndefined();
  });

  it("external-action goals stay blocked with execution-evidence requirements intact", () => {
    const plan = planForGoal("swap 1 ETH for USDC", 100, "free");
    expect(plan.criteria.requiresExecutionEvidence).toBe(true);
    expect(plan.executionBlocker).toBeTruthy();
    expect(describeCriteria(plan.criteria).join("; ").includes("settlement")).toBe(false);
  });
});
