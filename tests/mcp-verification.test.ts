import { describe, expect, it } from "vitest";

import { independentlyVerifyTask, defaultVerifyTaskDeps, type VerifyTaskDeps } from "@/lib/mcp/verify-task";
import type { TaskRecord, Evidence } from "@/lib/engine/types";

/**
 * Independent task verification (mission #20): success, failure, missing
 * evidence and honest unverified outcomes. The deps bundle is always
 * injected — no network access in these tests.
 */

const NOW = 1_800_000_000_000;

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-verify-1",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 30_000,
    state: "completed",
    goal: "Find the registered address of MARA HOLDINGS, INC.",
    plan: null,
    events: [
      { id: "e1", ts: NOW - 40_000, type: "telegraph_challenge", message: "priced" },
      { id: "e2", ts: NOW - 35_000, type: "spend_recorded", message: "delivered" },
    ],
    spend: {
      limitUsdCents: 100,
      spentUsdCents: 1,
      entries: [
        {
          ts: NOW - 35_000,
          description: "paid ask",
          amountUsdCents: 1,
          source: "telegraph",
          receiptHash: "receipt-hash-1",
          txHash: "0x" + "1".repeat(64),
          signalHash: "signal-hash-1",
        },
      ],
    },
    permissions: { allowedActions: ["telegraph.ask"], requiresApproval: false, maxRetries: 0 },
    criteria: {
      primaryVerifiedAgainstNodeSignal: true,
      answerSane: true,
      answerMaxAgeSeconds: 0,
      ownPaymentSettledOnChain: true,
      reconcileLedgerEntries: true,
    },
    result: null,
    error: null,
    origin: { source: "mcp" },
    ...overrides,
  };
}

function depsOver(overrides: Partial<VerifyTaskDeps> = {}): VerifyTaskDeps {
  return { ...defaultVerifyTaskDeps(), now: () => NOW, ...overrides };
}

const ACCEPTED_ANSWER = { amount: 77648.845, currency: "USD" };

function withAnswer(task: TaskRecord): TaskRecord {
  const evidence: Evidence[] = [
    { kind: "telegraph_signal", signalHash: "signal-hash-1", minerId: "miner-1" },
    { kind: "telegraph_receipt", receiptHash: "receipt-hash-1", txHash: "0x" + "1".repeat(64), amountUsdCents: 1 },
    { kind: "on_chain_settlement", txHash: "0x" + "1".repeat(64), status: "success", blockNumber: 42, rpcUrl: "https://rpc" },
  ];
  return {
    ...task,
    result: {
      summary: `miner-1\n\n${JSON.stringify(ACCEPTED_ANSWER)}`,
      evidence,
      completedAt: NOW - 20_000,
    },
  };
}

const nodeRecord = {
  signal_hash: "signal-hash-1",
  result: { execution: { result: ACCEPTED_ANSWER } },
};

describe("independentlyVerifyTask", () => {
  it("verifies a completed task whose evidence matches the node and the chain", async () => {
    const report = await independentlyVerifyTask(
      withAnswer(baseTask()),
      depsOver({
        lookupSignal: async (hash) => {
          expect(hash).toBe("signal-hash-1");
          return nodeRecord;
        },
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.verdict).toBe("verified");
    expect(report.claimedComplete).toBe(true);
    expect(report.failures).toEqual([]);
    const statuses = report.checks.map((c) => c.status);
    expect(statuses).toContain("verified");
    expect(statuses).not.toContain("verification_failed");
    // Ledger reconciliation ran through the existing implementation.
    expect(report.ledger.consistent).toBe(true);
    expect(report.ledger.accountedCents).toBe(1);
  });

  it("fails verification when the node's record does not match the accepted answer", async () => {
    const report = await independentlyVerifyTask(
      withAnswer(baseTask()),
      depsOver({
        lookupSignal: async () => ({ signal_hash: "signal-hash-1", result: { execution: { result: { amount: 999999.999, currency: "USD" } } } }),
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.verdict).toBe("failed");
    expect(report.failures.join(" ")).toContain("does not match the node's record");
    const match = report.checks.find((c) => c.id.startsWith("signal_answer"));
    expect(match?.status).toBe("verification_failed");
  });

  it("fails verification when the recorded settlement no longer reads as recorded", async () => {
    const report = await independentlyVerifyTask(
      withAnswer(baseTask()),
      depsOver({
        lookupSignal: async () => nodeRecord,
        getTransactionReceipt: async () => ({ found: true, status: "reverted", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.verdict).toBe("failed");
    const chain = report.checks.find((c) => c.id.startsWith("chain_"));
    expect(chain?.status).toBe("verification_failed");
    expect(report.failures.join(" ")).toContain("0x1111");
  });

  it("reports missing node records as missing and never as success", async () => {
    const report = await independentlyVerifyTask(
      withAnswer(baseTask()),
      depsOver({
        lookupSignal: async () => { throw new Error("signal lookup failed: HTTP 404"); },
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.verdict).toBe("failed");
    const missing = report.checks.find((c) => c.status === "missing");
    expect(missing).toBeTruthy();
    expect(missing?.signalHash).toBe("signal-hash-1");
    expect(report.failures.join(" ")).toContain("no node record");
  });

  it("keeps a task unverified (not failed, not verified) when the answer is not reconstructible", async () => {
    const task = baseTask({
      result: {
        summary: "miner-1\n\n{\"amount\": 77648.845, \"currency\": \"USD\", \"trunc", // truncated JSON
        evidence: [{ kind: "telegraph_signal", signalHash: "signal-hash-1", minerId: "miner-1" }],
        completedAt: NOW - 20_000,
      },
    });
    const report = await independentlyVerifyTask(
      task,
      depsOver({
        lookupSignal: async () => nodeRecord,
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.verdict).toBe("unverified");
    expect(report.failures).toEqual([]);
    expect(report.unresolvedGaps.join(" ")).toContain("not reconstructible");
    const check = report.checks.find((c) => c.id.startsWith("signal_answer"));
    expect(check?.status).toBe("unverified");
  });

  it("verifies mind investigation facts against the node record per fact value", async () => {
    const task = baseTask({
      criteria: {
        primaryVerifiedAgainstNodeSignal: true,
        answerSane: true,
        answerMaxAgeSeconds: 0,
        ownPaymentSettledOnChain: false,
        reconcileLedgerEntries: true,
        primarySource: "telegraph",
      },
      result: {
        summary: "report",
        evidence: [],
        completedAt: NOW - 20_000,
        mindReport: {
          objective: "x",
          entity: null,
          intelUsed: true,
          baseline: null,
          intel: {
            purchased: true,
            signalHash: "signal-hash-1",
            verificationStatus: "verified",
            miner: "corp-brreg",
            costUsdCents: 1,
            receiptHash: "receipt-hash-1",
            committed: true,
            facts: [
              { field: "legal_name", value: "MARA HOLDINGS, INC." },
              { field: "active", value: true },
            ],
            missing: [],
            disagreements: [],
            meta: { sources: [] },
          },
          confidence: "signal-verified",
          reasoning: ["the node record was re-read and every fact value was matched against it"],
          generatedAt: NOW - 10_000,
        },
      },
    });
    const good = await independentlyVerifyTask(
      task,
      depsOver({ lookupSignal: async () => ({ signal_hash: "s", payload: { response: { legal_name: "MARA HOLDINGS, INC.", active: true } } }) }),
    );
    expect(good.checks.find((c) => c.id.startsWith("signal_facts"))?.status).toBe("verified");

    const bad = await independentlyVerifyTask(
      task,
      depsOver({ lookupSignal: async () => ({ signal_hash: "s", payload: { response: { legal_name: "SOMEONE ELSE LLC" } } }) }),
    );
    expect(bad.checks.find((c) => c.id.startsWith("signal_facts"))?.status).toBe("verification_failed");
    expect(bad.verdict).toBe("failed");
  });

  it("re-checks capability committed responses per dimension", async () => {
    const task = baseTask({
      events: [],
      spend: { limitUsdCents: 100, spentUsdCents: 0, entries: [] },
      criteria: {
        primaryVerifiedAgainstNodeSignal: true,
        answerSane: true,
        answerMaxAgeSeconds: 0,
        ownPaymentSettledOnChain: false,
        reconcileLedgerEntries: false,
      },
      result: {
        summary: "capability report",
        evidence: [],
        completedAt: NOW - 20_000,
        capabilityReport: {
          slug: "counterparty-intelligence",
          preparedAt: new Date(NOW).toISOString(),
          dimensions: [
            {
              dimension: "registry",
              label: "Registry identity",
              status: "verified",
              detail: "ok",
              intent: "CORPORATE_REGISTRY_LOOKUP",
              provider: "corp-brreg",
              signalHash: "signal-hash-1",
              committed: { legal_name: "MARA HOLDINGS, INC." },
            },
          ],
          missing: [],
          spendUsdCents: 0,
          counts: { verified: 1, recorded: 0, unverified: 0, routable_unverified: 0, gap: 0 },
          note: "n/a",
        },
      },
    });
    const report = await independentlyVerifyTask(
      task,
      depsOver({ lookupSignal: async () => ({ signal_hash: "s", result: { execution: { result: { legal_name: "MARA HOLDINGS, INC." } } } }) }),
    );
    const check = report.checks.find((c) => c.id.startsWith("signal_committed"));
    expect(check?.status).toBe("verified");
    expect(report.verdict).toBe("verified");
  });

  it("records the node's own verified assertion without accepting it as proof", async () => {
    const report = await independentlyVerifyTask(
      withAnswer(baseTask()),
      depsOver({
        lookupSignal: async () => ({ ...nodeRecord, verification: { verified: true, algorithm: "sha256", commitment: "0xdeadbeef" } }),
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.verdict).toBe("verified");
    expect(report.nodeAssertedLabels.join(" ")).toContain("node asserts signal");
    expect(report.nodeAssertedLabels.join(" ")).toContain("not accepted as independent proof");
  });

  it("flags unaccounted signal hashes and receipt/ledger mismatches", async () => {
    const task = withAnswer(baseTask());
    task.spend.entries[0].amountUsdCents = 5; // evidence claims 1 cent
    task.spend.spentUsdCents = 5;
    const report = await independentlyVerifyTask(
      task,
      depsOver({
        lookupSignal: async () => nodeRecord,
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.verdict).toBe("failed");
    expect(report.checks.find((c) => c.id.startsWith("receipt_"))?.status).toBe("verification_failed");
    expect(report.failures.join(" ")).toContain("not correctly accounted");
  });

  it("treats free/public-read evidence as analysis with an explicit gap, never as network proof", async () => {
    const task = baseTask({
      events: [],
      spend: { limitUsdCents: 100, spentUsdCents: 0, entries: [] },
      criteria: {
        primaryVerifiedAgainstNodeSignal: false,
        answerSane: false,
        answerMaxAgeSeconds: 0,
        ownPaymentSettledOnChain: false,
        reconcileLedgerEntries: false,
        primarySource: "free",
        freeChainRead: "base",
      },
      result: {
        summary: "free reads only",
        evidence: [{ kind: "chain_read", chain: "base", gasPriceWei: 1, gasPriceGwei: 0.001, rpcUrl: "https://rpc" }],
        completedAt: NOW - 20_000,
      },
    });
    const report = await independentlyVerifyTask(task, depsOver());
    expect(report.verdict).toBe("unverified");
    expect(report.checks.find((c) => c.id.startsWith("recorded_read"))?.status).toBe("analysis");
    expect(report.unresolvedGaps.join(" ")).toContain("chain_read");
  });

  // -------------------------------------------------------------------------
  // Audit fix: the verdict gate. "verified" requires EVERY applicable piece of
  // evidence to check out — a mix of verified and unresolved evidence must be
  // "unverified", a mix with a missing record must be "failed".
  // -------------------------------------------------------------------------

  function mixedCapabilityTask(secondEvidence: Evidence[]): TaskRecord {
    return baseTask({
      events: [],
      spend: { limitUsdCents: 100, spentUsdCents: 0, entries: [] },
      criteria: {
        primaryVerifiedAgainstNodeSignal: true,
        answerSane: true,
        answerMaxAgeSeconds: 0,
        ownPaymentSettledOnChain: false,
        reconcileLedgerEntries: false,
      },
      result: {
        // Non-JSON summary: no reconstructible accepted answer for plain
        // signal evidence — that signal's content check is honestly unverified.
        summary: "capability report",
        evidence: secondEvidence,
        completedAt: NOW - 20_000,
        capabilityReport: {
          slug: "counterparty-intelligence",
          preparedAt: new Date(NOW).toISOString(),
          dimensions: [
            {
              dimension: "registry",
              label: "Registry identity",
              status: "verified",
              detail: "ok",
              intent: "CORPORATE_REGISTRY_LOOKUP",
              provider: "corp-brreg",
              signalHash: "signal-hash-a",
              committed: { legal_name: "MARA HOLDINGS, INC." },
            },
          ],
          missing: [],
          spendUsdCents: 0,
          counts: { verified: 1, recorded: 0, unverified: 0, routable_unverified: 0, gap: 0 },
          note: "n/a",
        },
      },
    });
  }

  it("does NOT verify a task mixing a proven signal with an unresolved one (audit fix)", async () => {
    const task = mixedCapabilityTask([{ kind: "telegraph_signal", signalHash: "signal-hash-b", minerId: "miner-2" }]);
    const report = await independentlyVerifyTask(
      task,
      depsOver({
        lookupSignal: async (hash) => {
          if (hash === "signal-hash-a") return { signal_hash: "s", result: { execution: { result: { legal_name: "MARA HOLDINGS, INC." } } } };
          return { signal_hash: "s", payload: { response: { anything: "record exists" } } };
        },
      }),
    );
    const committed = report.checks.find((c) => c.id.startsWith("signal_committed"));
    const unresolved = report.checks.find((c) => c.id.startsWith("signal_answer_"));
    expect(committed?.status).toBe("verified");
    expect(unresolved?.status).toBe("unverified");
    expect(report.failures).toEqual([]);
    // Old behaviour would have returned "verified" on the strength of the one
    // proven signal; the tightened gate reports the honest mixed verdict.
    expect(report.verdict).toBe("unverified");
    expect(report.unresolvedGaps.join(" ")).toContain("not reconstructible");
  });

  it("does NOT verify a task whose chain settlement re-read fails, even with a proven signal (audit fix)", async () => {
    const report = await independentlyVerifyTask(
      withAnswer(baseTask()),
      depsOver({
        lookupSignal: async () => nodeRecord,
        getTransactionReceipt: async () => { throw new Error("RPC connection reset"); },
      }),
    );
    const chain = report.checks.find((c) => c.id.startsWith("chain_"));
    expect(chain?.status).toBe("unverified");
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe("unverified");
    expect(report.unresolvedGaps.join(" ")).toContain("could not be re-read");
  });

  it("does NOT verify a task mixing a proven signal with execution-time analysis evidence (audit fix)", async () => {
    const task = withAnswer(baseTask());
    task.result?.evidence.push({ kind: "chain_read", chain: "base", gasPriceWei: 1, gasPriceGwei: 0.001, rpcUrl: "https://rpc" });
    const report = await independentlyVerifyTask(
      task,
      depsOver({
        lookupSignal: async () => nodeRecord,
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    expect(report.checks.find((c) => c.id.startsWith("signal_answer"))?.status).toBe("verified");
    expect(report.checks.find((c) => c.id.startsWith("recorded_read"))?.status).toBe("analysis");
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe("unverified");
  });

  it("fails a task with one proven and one missing signal record (audit fix)", async () => {
    const task = mixedCapabilityTask([{ kind: "telegraph_signal", signalHash: "signal-hash-b", minerId: "miner-2" }]);
    const report = await independentlyVerifyTask(
      task,
      depsOver({
        lookupSignal: async (hash) => {
          if (hash === "signal-hash-a") return { signal_hash: "s", result: { execution: { result: { legal_name: "MARA HOLDINGS, INC." } } } };
          throw new Error("signal lookup failed: HTTP 404");
        },
      }),
    );
    const missing = report.checks.find((c) => c.status === "missing");
    expect(missing?.signalHash).toBe("signal-hash-b");
    expect(report.failures.join(" ")).toContain("no node record");
    expect(report.verdict).toBe("failed");
  });

  it("still verifies when every applicable evidence check passes (audit fix, positive control)", async () => {
    const report = await independentlyVerifyTask(
      withAnswer(baseTask()),
      depsOver({
        lookupSignal: async () => nodeRecord,
        getTransactionReceipt: async () => ({ found: true, status: "success", blockNumber: 42, to: null, rpcUrl: "https://rpc" }),
      }),
    );
    const evidenceChecks = report.checks.filter((c) => /^(signal_|chain_|receipt_)/.test(c.id));
    expect(evidenceChecks.length).toBeGreaterThan(0);
    expect(evidenceChecks.every((c) => c.status === "verified")).toBe(true);
    expect(report.verdict).toBe("verified");
  });
});
