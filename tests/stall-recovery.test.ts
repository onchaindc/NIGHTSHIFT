import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/engine/store", () => ({ saveTask: vi.fn(async () => undefined), getTask: vi.fn(), listTasks: vi.fn(async () => []) }));

import { reapIfStalled, reapStalledTasks, runOverBudget, RUN_BUDGET_MS, TASK_STALL_MS } from "@/lib/engine/engine";
import { telegraphFetch } from "@/lib/telegraph/client";
import { probeCapabilitySet, sampleParams, type CapabilityRunnerDeps } from "@/lib/minds/capability-runner";
import { CAPABILITIES } from "@/lib/minds/capabilities";
import type { TaskRecord } from "@/lib/engine/types";
import type { ApprovedOffer, ProbeOutcome } from "@/lib/terminal/ask";
import { saveTask, listTasks } from "@/lib/engine/store";

function taskFor(state: TaskRecord["state"], updatedAt: number): TaskRecord {
  return {
    id: `task-${state}-${updatedAt}`,
    createdAt: updatedAt - 60_000,
    updatedAt,
    state,
    goal: "stall recovery fixture",
    plan: [],
    events: [],
    spend: { limitUsdCents: 10, spentUsdCents: 0, entries: [] },
    permissions: { allowedActions: ["telegraph.ask"], requiresApproval: false, maxRetries: 0 },
    criteria: {
      primaryVerifiedAgainstNodeSignal: true,
      answerSane: true,
      answerMaxAgeSeconds: 300,
      ownPaymentSettledOnChain: true,
      reconcileLedgerEntries: true,
    },
    result: null,
    error: null,
    origin: { source: "web" },
    jobType: "capability_run",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAPH_CALL_TIMEOUT_MS;
  vi.clearAllMocks();
});

describe("run budget", () => {
  it("ends the run honestly before the window can kill it", () => {
    expect(runOverBudget(1_000_000, 1_000_000 + RUN_BUDGET_MS - 1)).toBe(false);
    expect(runOverBudget(1_000_000, 1_000_000 + RUN_BUDGET_MS + 1)).toBe(true);
    // The failure write must fit inside the serverless window: budget < window.
    expect(RUN_BUDGET_MS).toBeLessThan(300_000);
    // A dead run is reaped fast, while a healthy run (silence ≤ one bounded
    // call ≈ 35s) is never falsely reaped.
    expect(TASK_STALL_MS).toBe(90_000);
    expect(TASK_STALL_MS).toBeGreaterThan(60_000);
  });
});

describe("stall recovery", () => {
  const NOW = 1_800_000_000_000;
  const stale = NOW - TASK_STALL_MS - 1_000;

  it("fails a stale executing task honestly instead of letting it hang forever", async () => {
    const task = taskFor("executing", stale);
    const out = await reapIfStalled(task, NOW);
    expect(out.state).toBe("failed");
    expect(out.error).toContain("interrupted");
    expect(out.error).toContain("re-run");
    expect(out.events.at(-1)?.type).toBe("step_failed");
    expect(saveTask).toHaveBeenCalledTimes(1);
  });

  it("reaps stale created/planning/verifying states too", async () => {
    for (const state of ["created", "planning", "verifying"] as const) {
      const out = await reapIfStalled(taskFor(state, stale), NOW);
      expect(out.state).toBe("failed");
    }
  });

  it("never touches fresh runs, human-gated approvals or terminal states", async () => {
    const fresh = await reapIfStalled(taskFor("executing", NOW - 60_000), NOW);
    expect(fresh.state).toBe("executing");
    const gated = await reapIfStalled(taskFor("awaiting_approval", stale), NOW);
    expect(gated.state).toBe("awaiting_approval"); // a human may take days
    const done = await reapIfStalled(taskFor("completed", stale), NOW);
    expect(done.state).toBe("completed");
    const failed = await reapIfStalled(taskFor("failed", stale), NOW);
    expect(failed.state).toBe("failed");
    expect(saveTask).not.toHaveBeenCalled();
  });

  it("reapStalledTasks sweeps the task list and survives storage failure", async () => {
    vi.mocked(listTasks).mockResolvedValueOnce([
      taskFor("executing", stale),
      taskFor("awaiting_approval", stale),
      taskFor("executing", NOW - 10_000),
    ] as never);
    expect(await reapStalledTasks(NOW)).toBe(1);
    vi.mocked(listTasks).mockRejectedValueOnce(new Error("storage down"));
    expect(await reapStalledTasks(NOW)).toBe(0); // reads must not crash
  });
});

describe("bounded node calls", () => {
  it("every telegraphFetch carries an abort signal", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await telegraphFetch("https://node/api/miners", { cache: "no-store" });
    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a silently hanging node fails within the configured window instead of hanging forever", async () => {
    process.env.TELEGRAPH_CALL_TIMEOUT_MS = "80";
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted by test harness")));
        }),
    );
    const started = Date.now();
    await expect(telegraphFetch("https://node/engine/v1/ask")).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("concurrent baseline probes", () => {
  const OFFER: ApprovedOffer = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e",
    amount: "10000",
  };
  const challenge = (cents: number): ProbeOutcome => ({
    kind: "challenge",
    challenge: { accepts: [] },
    approvedOffer: OFFER,
    pricedOffer: { network: OFFER.network, asset: OFFER.asset, payTo: OFFER.payTo, amountCents: cents },
    referencedUrl: "https://node/engine/v1/ask/x",
  });

  it("probes run concurrently and results keep the dimension order", async () => {
    const dims = CAPABILITIES["portsentinel"].dimensions;
    const inputs = Object.fromEntries(
      dims.filter((d) => d.status !== "gap").map((d) => [d.id, sampleParams(d)]),
    );
    // Reverse latency: the first dimension is the slowest. A sequential loop
    // would take the SUM of delays; concurrent probing takes the MAX.
    let call = 0;
    const deps: CapabilityRunnerDeps = {
      probe: vi.fn(async () => {
        const delay = 60 - Math.min(call++, 60) * 10;
        await new Promise((r) => setTimeout(r, Math.max(delay, 5)));
        return challenge(1);
      }),
      execute: vi.fn(async () => {
        throw new Error("no paid ask in this test");
      }),
      verify: vi.fn(async (): Promise<{ kind: "unverified"; detail: string }> => ({ kind: "unverified", detail: "x" })),
      now: () => 1_800_000_000_000,
    };
    const started = Date.now();
    const { coverage, offers } = await probeCapabilitySet("portsentinel", inputs, { deps });
    const elapsed = Date.now() - started;

    const expectedOrder = dims.map((d) => d.id);
    expect(coverage.dimensions.map((d) => d.dimension)).toEqual(expectedOrder);
    expect(offers.map((o) => o.dimension.id)).toEqual(dims.filter((d) => d.status !== "gap").map((d) => d.id));
    expect(coverage.routable).toBe(offers.length);
    // Sequential would be ≥ sum of all delays; concurrency must stay well under.
    expect(elapsed).toBeLessThan(dims.length * 60);
  });
});
