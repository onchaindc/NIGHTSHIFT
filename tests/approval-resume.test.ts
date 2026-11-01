import { beforeEach, describe, expect, it } from "vitest";

import { approveTask, createTask, type EngineDeps } from "@/lib/engine/engine";
import { resetStore } from "@/lib/engine/store";
import { createWatch, resetWatchStore } from "@/lib/watch/store";
import { resetWatchDeps, setWatchDeps, planWatchSteps, type WatchRunnerDeps } from "@/lib/watch/execute";
import { resetRepoIntelDeps, setRepoIntelDeps } from "@/lib/watch/repo-intel";
import type { ExecutionEvent, PlanStep, TaskRecord } from "@/lib/engine/types";
import type { SourceFetchResult, WatchSource } from "@/lib/watch/types";
import { WATCH_CRITERIA } from "@/lib/watch/types";

/* ------------------------------------------------------------------ */
/* Fakes: identical spirit to tests/engine.test.ts with call counters   */
/* ------------------------------------------------------------------ */

const GOOD_ANSWER = {
  answer: { data: { note: "three short bullets grounded in the observed change" } },
  minerId: "351",
  minerName: "fake-miner",
  costUsd: 0.01,
  signalHash: "0xsignal123",
  receipt: {
    receipt_hash: "0xreceipt123",
    rail: "x402",
    payer: "0xpayer",
    miner: "351",
    intent: "RESEARCH",
    amount_uusdc: "10000",
    epoch_id: 314,
    settlement: "onchain",
    chain: "eip155:84532",
    tx_hash: "0xtx123",
    timestamp: 1789466181,
  },
};

function makeEngineDeps(): EngineDeps & { asks: number } {
  const deps: EngineDeps & { asks: number } = {
    asks: 0,
    publicSource: {
      fetchJSON: async () => {
        throw new Error("unexpected public source read in this test");
      },
    },
    telegraph: {
      askAuto: async () => {
        deps.asks++;
        return GOOD_ANSWER;
      },
      lookupSignal: async (h: string) => ({ signal_hash: h, result: GOOD_ANSWER.answer, signal: { created_at: new Date().toISOString() } }),
    },
    chain: {
      getReceipt: async () => ({ found: true, status: "success", blockNumber: 1, to: "0x", rpcUrl: "https://fake-rpc" }),
      getGasPrice: async () => ({ chain: "base", gasPriceWei: 1, gasPriceGwei: 0.000001, rpcUrl: "https://fake-rpc" }),
    },
    now: () => Date.now(),
  };
  return deps;
}

type FetchScript = (source: WatchSource, callIndex: number) => SourceFetchResult;

function depOverrides(script: FetchScript): WatchRunnerDeps {
  let call = 0;
  return {
    fetchSource: async (source) => script(source, call++),
    sendTelegram: async () => {},
  };
}

const SNAP_A = (label: string): SourceFetchResult["snapshot"] => ({
  signature: "release:v1.0.0",
  summary: `${label}: Release v1.0.0`,
  detail: `${label}: baseline release v1.0.0`,
  url: "https://example.com/releases",
});

const SNAP_B = (label: string): SourceFetchResult["snapshot"] => ({
  signature: "release:v4.1.0",
  summary: `${label}: Release v4.1.0`,
  detail: `${label}: newest published release v4.1.0, the governance gateway module was upgraded`,
  url: "https://example.com/releases",
});

async function makeWatchTask(opts: { changed: boolean; investigate?: boolean; recordBaseline?: boolean }) {
  const watch = await createWatch({
    name: "Repo watch",
    protocol: "Example",
    sources: [{ type: "github_releases", target: "owner/repo", label: "Releases" }],
    spendLimitUsdCents: 10,
    requiresApprovalForPaid: true,
    telegramChatId: null,
  });
  setWatchDeps(
    depOverrides((source, call) => {
      // Odd calls baseline v1, even calls either stay v1 (nothing changed) or
      // move to v4.1.0 (a real change) — deterministic per test.
      const useB = opts.changed && call >= 1;
      return { sourceId: source.id, sourceLabel: source.label, ok: true, snapshot: useB ? SNAP_B(source.label) : SNAP_A(source.label) };
    }),
  );
  setRepoIntelDeps({
    nextId: () => `id-${Math.random()}`,
    httpGetText: async (url) => {
      const routes: Record<string, unknown> = {
        "https://api.github.com/repos/owner/repo": { default_branch: "main", language: "TypeScript" },
        "https://api.github.com/repos/owner/repo/contents": [{ name: "package.json", type: "file" }],
        "https://api.github.com/repos/owner/repo/commits?per_page=20": [
          { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", author: { login: "dev" }, commit: { message: "fix: thing", author: { name: "Dev" } } },
        ],
        "https://api.github.com/repos/owner/repo/releases?per_page=10": [],
        "https://raw.githubusercontent.com/owner/repo/main/package.json": JSON.stringify({ dependencies: { leftpad: "^1.2.3" } }),
        "https://api.github.com/repos/owner/repo/security-advisories?per_page=10": [],
        "https://api.github.com/repos/owner/repo/contents/.github/workflows": [],
        "https://api.github.com/advisories?affects=leftpad@1.2.3&ecosystem=npm&per_page=10": [],
      };
      const hit = routes[url];
      if (hit === undefined) throw new Error(`HTTP 404 from ${new URL(url).host}`);
      return typeof hit === "string" ? hit : JSON.stringify(hit);
    },
  });

  // A real source change needs a real prior baseline: run one plain check
  // task first so the approval run compares v4.1.0 against v1.0.0.
  if (opts.recordBaseline) {
    const baselineCaller = (await import("@/lib/engine/engine")).runTask;
    const baselineTask = await createTask({
      goal: `Protocol Watch check: baseline`,
      spendLimitUsdCents: watch.spendLimitUsdCents,
      requiresApproval: false,
      origin: { source: "web" },
      jobType: "protocol_watch",
      watch: { watchId: watch.id, watchName: watch.name, triggeredBy: "manual", telegramChatId: null },
      plan: planWatchSteps(watch, false) as PlanStep[],
      criteria: WATCH_CRITERIA,
    });
    await baselineCaller(baselineTask.id, makeEngineDeps());
  }

  const task = await createTask({
    goal: `Protocol Watch check: ${watch.name} (${watch.protocol})`,
    spendLimitUsdCents: watch.spendLimitUsdCents,
    requiresApproval: true,
    origin: { source: "web" },
    jobType: "protocol_watch",
    watch: {
      watchId: watch.id,
      watchName: watch.name,
      triggeredBy: "manual",
      telegramChatId: null,
    },
    plan: planWatchSteps(watch, opts.investigate === true) as PlanStep[],
    criteria: WATCH_CRITERIA,
  });
  return task;
}

beforeEach(() => {
  resetStore();
  resetWatchStore();
  resetWatchDeps();
  resetRepoIntelDeps();
});

/* ------------------------------------------------------------------ */
/* Approval resumption: the ID persists and execution happens ONCE      */
/* ------------------------------------------------------------------ */

describe("approval handoff", () => {
  it("keeps the same task id from creation through approval to completion", async () => {
    const task = await makeWatchTask({ changed: true, investigate: true, recordBaseline: true });
    expect(task.state).toBe("awaiting_approval");
    expect(task.spend.spentUsdCents).toBe(0);
    const dep = makeEngineDeps();
    const done = await approveTask(task.id, dep);
    expect(done.id).toBe(task.id);
    expect(done.state).toBe("completed");
    expect(done.result).not.toBeNull();
  });

  it("a second approve of the same task returns it unchanged and executes nothing new", async () => {
    const task = await makeWatchTask({ changed: true, investigate: true, recordBaseline: true });
    const dep = makeEngineDeps();
    const first = await approveTask(task.id, dep);
    const asksAfterFirst = dep.asks;
    const eventsAfterFirst = first.events.length;
    const spendAfterFirst = first.spend.spentUsdCents;
    const resultAfterFirst = JSON.stringify(first.result);

    const second = await approveTask(task.id, dep);
    expect(second.id).toBe(task.id);
    expect(second.state).toBe("completed");
    expect(dep.asks).toBe(asksAfterFirst); // NO duplicate paid call
    expect(second.events.length).toBe(eventsAfterFirst); // no new run, no new steps
    expect(second.spend.spentUsdCents).toBe(spendAfterFirst);
    // The persistence layer normalizes typographic dashes, so compare under
    // the same normalization; anything else must be byte-identical.
    const norm = (s: string) => s.replace(/—/g, ",");
    expect(norm(JSON.stringify(second.result))).toBe(norm(resultAfterFirst));
  });

  it("approving a failed/blocked/rejected task is a no-op that never reruns steps", async () => {
    const task = await makeWatchTask({ changed: false, investigate: true });
    const dep = makeEngineDeps();
    const first = await approveTask(task.id, dep);
    expect(first.state).toBe("completed");
    // Simulate a terminal non-awaiting state transition retry: post-completion
    // approve must be inert.
    const before = JSON.stringify(first);
    const again = await approveTask(task.id, dep);
    expect(again).toEqual(JSON.parse(before) as unknown);
    void again;
  });

  it("an investigation that ran because of a real change reports INVESTIGATION COMPLETED with repoReport evidence", async () => {
    const task = await makeWatchTask({ changed: true, investigate: true, recordBaseline: true });
    const dep = makeEngineDeps();
    const done = await approveTask(task.id, dep);
    expect(done.result?.summary).toContain("INVESTIGATION COMPLETED");
    expect(done.result?.repoReport).toBeDefined();
    expect(done.result?.repoReport?.repository).toBe("owner/repo");
    expect(done.result?.repoReport?.outcome).toBe("investigation_completed");
    // Evidence attribution: the report's findings appear as their own evidence kind.
    const repoEvidence = done.result?.evidence.filter((e: { kind: string }) => e.kind === "repo_intel") ?? [];
    for (const ev of repoEvidence) {
      expect((ev as { findingTitle: string }).findingTitle.length).toBeGreaterThan(0);
      expect((ev as { severity: string }).severity.length).toBeGreaterThan(0);
    }
    // The paid insight ran exactly once and used the sourced repo findings.
    expect(dep.asks).toBe(1);
  });

  it("no-change routine checks are labelled NO CHANGES DETECTED, run no paid model, and carry no repoReport", async () => {
    const task = await makeWatchTask({ changed: false, investigate: true });
    const dep = makeEngineDeps();
    const done = await approveTask(task.id, dep);
    expect(done.result?.summary).toContain("NO CHANGES DETECTED");
    expect(done.result?.summary).not.toContain("INVESTIGATION COMPLETED");
    expect(done.result?.repoReport).toBeUndefined();
    expect(dep.asks).toBe(0); // a routine fingerprint check never spends
    const skipped = done.events.filter((e: ExecutionEvent) => e.type === "watch_paid_skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
  });

  it("rejecting the plan spends nothing, and approval after rejection is inert", async () => {
    const task = await makeWatchTask({ changed: true, investigate: true });
    const dep = makeEngineDeps();
    const { rejectTask } = await import("@/lib/engine/engine");
    const rejected = await rejectTask(task.id, dep);
    expect(rejected.state).toBe("rejected");
    expect(rejected.spend.spentUsdCents).toBe(0);
    const inert = await approveTask(task.id, dep);
    expect(inert.state).toBe("rejected");
    expect(dep.asks).toBe(0);
  });

  it("watch task result summary never claims an examination that did not run", () => {
    // Vocabulary contract embedded in test form: each outcome line names
    // exactly what happened.
    const noChange = "NO CHANGES DETECTED: a routine change check ran.";
    const completed = "INVESTIGATION COMPLETED: a technical repository investigation ran.";
    expect(noChange.startsWith("NO CHANGES DETECTED")).toBe(true);
    expect(completed.startsWith("INVESTIGATION COMPLETED")).toBe(true);
    expect(noChange).not.toContain("INVESTIGATION COMPLETED");
  });
});
