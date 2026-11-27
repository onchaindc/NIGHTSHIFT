/**
 * Overview resilience — regression tests for the recurring
 * "This view hit an unexpected error" failure AND the production data-
 * availability failure (persistent partial-store banner + empty sections).
 *
 * The rendering failure had TWO proven digests, both reproduced against a
 * production build with real-shaped legacy records before the fix:
 *
 *   1. `TypeError: a.evidence is not iterable` — summarizeDesk →
 *      deskEvidenceCounts on a desk record written before its evidence
 *      ledger existed;
 *   2. `TypeError: Cannot read properties of undefined (reading 'legalName')`
 *      — summarize on an assurance record saved before the transaction and
 *      counterparty steps had filled in.
 *
 * The data-availability failure was the 8s read deadline expiring inside the
 * cold-start database window (probe + migrate run ahead of the first query),
 * which rendered the partial-store banner and empty sections against a
 * HEALTHY database. Its contract is pinned here at the section level:
 *
 *   - a FAILED source (null) never renders as zero — the snapshot reports
 *     "n/a" and the page shows a retry;
 *   - a genuinely EMPTY source renders 0/none, because it is a fact;
 *   - sections are isolated (runSection): one broken builder fails alone.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deskEvidenceCounts } from "@/lib/desk/types";
import { getDeskInvestigation, saveDeskInvestigation, summarizeDesk } from "@/lib/desk/store";
import { audit, getInvestigation, saveInvestigation, summarize } from "@/lib/assurance/store";
import { investigationsForCaller, publicTaskView, tasksForCaller } from "@/lib/api/public";
import { readBounded, readOutcome } from "@/lib/api/bounded-read";
import {
  buildNetworkStatus,
  buildQuickAccess,
  buildRecentActivity,
  buildSnapshot,
  buildWorkInProgress,
  runSection,
  runSectionAsync,
  type OverviewInput,
} from "@/lib/overview/sections";
import { persistence } from "@/lib/storage";
import { listTasks } from "@/lib/engine/store";
import type { DeskInvestigation } from "@/lib/desk/types";
import type { Investigation } from "@/lib/assurance/types";
import type { TaskRecord } from "@/lib/engine/types";
import type { BuyerJobView } from "@/lib/acp/buyer";
import type { CommerceJob } from "@/lib/commerce/types";

const USER = "0x1111111111111111111111111111111111111111";
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/* ------------------------------------------------------------------ */
/* The exact legacy records that killed production                     */
/* ------------------------------------------------------------------ */

/** A desk file recorded before the evidence ledger, run list or audit trail
 *  existed — digest 1: "a.evidence is not iterable". */
const LEGACY_DESK = {
  id: "ov-legacy-desk",
  kind: "desk",
  reference: "NS-CP-OVTEST1",
  type: "counterparty_due_diligence",
  status: "collecting",
  createdAt: iso(-72 * 60 * 60 * 1000),
  subject: { legalName: "Legacy Company Ltd", jurisdiction: "GB" },
  runs: [],
  findings: [],
  unsupported: [],
  owner: USER,
  // evidence, report, operator, audit, updatedAt, spendLimitUsdCents: absent
} as unknown as DeskInvestigation;

/** An assurance file saved before the transaction step and the counterparty
 *  step had filled in — digest 2: "reading 'legalName'". */
const LEGACY_ASSURANCE = {
  id: "ov-legacy-assurance",
  reference: "NS-TX-OVTEST2",
  createdAt: iso(-30 * 60 * 1000),
  status: "draft",
  dataMode: "live",
  owner: USER,
  // transaction, counterparty, evidence, findings, decision, audit: absent
} as unknown as Investigation;

/** A task recorded before the spend ledger existed. */
function legacyTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "ov-legacy-task",
    createdAt: NOW - 10 * 60 * 1000,
    updatedAt: NOW - 5 * 60 * 1000,
    state: "failed",
    goal: "Legacy ask recorded before the spend ledger existed",
    plan: null,
    events: [],
    spend: undefined as unknown as TaskRecord["spend"],
    permissions: { allowedActions: [], requiresApproval: false, maxRetries: 0 },
    criteria: {
      primaryVerifiedAgainstNodeSignal: false,
      answerSane: false,
      answerMaxAgeSeconds: 3600,
      ownPaymentSettledOnChain: false,
      reconcileLedgerEntries: false,
    },
    result: null,
    error: "provider refused",
    origin: { source: "web" },
    ...over,
  } as TaskRecord;
}

/** A complete, healthy desk record the way the create flow writes it. */
function healthyDesk(over: Partial<DeskInvestigation> = {}): DeskInvestigation {
  return {
    id: "ov-desk-healthy",
    kind: "desk",
    reference: "NS-CP-OVTEST3",
    type: "counterparty_due_diligence",
    status: "collecting",
    createdAt: iso(-3 * 60 * 60 * 1000),
    updatedAt: iso(-2 * 60 * 60 * 1000),
    dataMode: "live",
    owner: USER,
    subject: { legalName: "Healthy Corp", jurisdiction: "DE" },
    unsupported: [],
    evidence: [],
    findings: [],
    runs: [],
    report: null,
    spendLimitUsdCents: 100,
    operator: { createdBy: "test", tenant: "test" },
    audit: [],
    ...over,
  };
}

/** A complete, healthy assurance file. */
function healthyAssurance(over: Partial<Investigation> = {}): Investigation {
  return {
    id: "ov-assurance-healthy",
    reference: "NS-TX-OVTEST4",
    createdAt: iso(-6 * 60 * 60 * 1000),
    updatedAt: iso(-4 * 60 * 60 * 1000),
    status: "assessed",
    dataMode: "demonstration",
    owner: null,
    transaction: { payerWallet: "", recipientWallet: "", amountUsdc: 2400000, tokenMint: "", jurisdiction: "GB", approvedBeneficiary: "", contractRef: "", memo: "", documents: [], ownershipRequired: true },
    counterparty: { legalName: "Example Trade Ltd" },
    evidence: [],
    findings: [],
    decision: { outcome: "HOLD", rationale: "verification pending" } as Investigation["decision"],
    intelligenceRuns: [],
    settlement: null,
    spendLimitUsdCents: 100,
    operator: { createdBy: "test", tenant: "test" },
    audit: [],
    limitations: [],
    ...over,
  };
}

const buyerView = (over: Partial<BuyerJobView> = {}): BuyerJobView =>
  ({
    buyer: {
      key: "8453:42",
      chainId: 8453,
      jobId: "42",
      offering: "Counterparty Due Diligence",
      clientAddress: USER,
      txHash: null,
      requirement: {},
      requirementJson: "{}",
      requirementSentAt: null,
      expiresAt: null,
      allowanceTxHash: null,
      fundedTxHash: null,
      completedTxHash: null,
      notes: [],
      createdAt: iso(-60 * 60 * 1000),
      updatedAt: iso(-30 * 60 * 1000),
    },
    provider: null,
    phase: "awaiting_payment",
    phaseLabel: "Waiting for your payment",
    action: "fund",
    ...over,
  }) as BuyerJobView;

const commerceJob = (over: Partial<CommerceJob> = {}): CommerceJob =>
  ({
    id: "ov-commerce-1",
    offeringId: "cap.test",
    section: "service",
    buyerWallet: USER,
    priceUsdCents: 1900,
    rail: "internal_settlement",
    settled: true,
    settlementNote: "intro purchase",
    input: {},
    deliverable: null,
    status: "fulfilled",
    createdAt: iso(-90 * 60 * 1000),
    updatedAt: iso(-80 * 60 * 1000),
    ...over,
  }) as CommerceJob;

const populatedInput = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  desk: [healthyDesk()],
  assurance: [healthyAssurance()],
  tasks: [legacyTask(), legacyTask({ id: "ov-t-await", state: "awaiting_approval", goal: "PAID intelligence plan", updatedAt: NOW - 60 * 1000 })],
  buyerViews: [buyerView()],
  commerceJobs: [commerceJob()],
  buyerScoped: true,
  operator: false,
  signedIn: true,
  ...over,
});

/* ------------------------------------------------------------------ */
/* The exact records that killed the Overview render                   */
/* ------------------------------------------------------------------ */

describe("the exact records that killed the Overview render", () => {
  it("digest 1 — summarizeDesk survives a desk record without its evidence ledger", () => {
    const summary = summarizeDesk(LEGACY_DESK);
    expect(summary.evidenceCount).toBe(0);
    expect(summary.verifiedCount).toBe(0);
    expect(summary.missingCount).toBe(0);
    expect(summary.subject).toContain("Legacy Company Ltd");
  });

  it("digest 1 — deskEvidenceCounts treats an absent ledger as empty, skips junk entries", () => {
    const zeroed = deskEvidenceCounts({ evidence: undefined as unknown as DeskInvestigation["evidence"] });
    expect(zeroed.verified).toBe(0);
    expect(zeroed.missing).toBe(0);
    const junked = deskEvidenceCounts({
      evidence: [
        { id: "e1", provenance: "verified", class: "declared" },
        { id: "e2", provenance: "future_provenance", class: "declared" },
        null as unknown as { id: string; provenance: string },
      ],
    } as unknown as Parameters<typeof deskEvidenceCounts>[0]);
    expect(junked.verified).toBe(1);
    expect(Number.isFinite(junked.missing)).toBe(true);
  });

  it("digest 2 — summarize survives an assurance record without counterparty or transaction", () => {
    const summary = summarize(LEGACY_ASSURANCE);
    expect(summary.counterparty).toBe("");
    expect(summary.amountUsdc).toBe(0);
    expect(summary.evidenceCount).toBe(0);
    expect(summary.findingCount).toBe(0);
    expect(summary.decision).toBeNull();
  });

  it("audit() accepts entries on a record written before the audit trail existed", () => {
    const inv = structuredClone(LEGACY_ASSURANCE);
    expect(() => audit(inv, "test", "ov_test", "append to a legacy file")).not.toThrow();
    expect(inv.audit).toHaveLength(1);
  });
});

describe("the stores normalize shape-drifted records on read", () => {
  it("desk reads return every declared collection field", async () => {
    await saveDeskInvestigation(LEGACY_DESK);
    const read = await getDeskInvestigation("ov-legacy-desk");
    expect(read).not.toBeNull();
    expect(Array.isArray(read!.evidence)).toBe(true);
    expect(Array.isArray(read!.runs)).toBe(true);
    expect(Array.isArray(read!.audit)).toBe(true);
    expect(read!.subject.legalName).toBe("Legacy Company Ltd");
  });

  it("assurance reads return every declared field", async () => {
    await saveInvestigation(LEGACY_ASSURANCE);
    const read = await getInvestigation("ov-legacy-assurance");
    expect(read).not.toBeNull();
    expect(Array.isArray(read!.evidence)).toBe(true);
    expect(Array.isArray(read!.findings)).toBe(true);
    expect(Array.isArray(read!.audit)).toBe(true);
    expect(read!.transaction.amountUsdc).toBe(0);
    expect(read!.counterparty.legalName).toBe("");
    // The persisted document itself is untouched — normalization is a read
    // contract, never a silent rewrite of historical data.
    const raw = await persistence().readNamed<Investigation>("assurance-inv-ov-legacy-assurance");
    expect(raw).not.toBeNull();
    expect((raw as unknown as Record<string, unknown>).transaction).toBeUndefined();
  });
});

describe("sections fail alone — the blast radius of one broken record is one section", () => {
  it("runSection turns a throwing builder into that section's failure", () => {
    const broken = runSection<string>(() => {
      throw new TypeError("simulated malformed record");
    });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("simulated malformed record");

    const healthy = runSection<string>(() => "still rendered");
    expect(healthy.ok).toBe(true);
    if (healthy.ok) expect(healthy.value).toBe("still rendered");
  });

  it("runSectionAsync isolates an async failure the same way", async () => {
    const broken = await runSectionAsync<string>(async () => {
      throw new TypeError("provider read failed");
    });
    expect(broken.ok).toBe(false);
    const healthy = await runSectionAsync<string>(async () => "fine");
    expect(healthy.ok).toBe(true);
  });
});

describe("the availability contract — failed sources never render as zero", () => {
  it("a failed source (null) makes the snapshot stat n/a, never 0", () => {
    const stats = buildSnapshot(populatedInput({ desk: null }));
    expect(stats.find((s) => s.key === "active")!.count).toBeNull();
    expect(stats.find((s) => s.key === "completed")!.count).toBeNull();
    // "Awaiting you" does not draw on the desk store — it still has a real count:
    // the awaiting task, the HOLD decision, and the buyer job waiting on funding.
    expect(stats.find((s) => s.key === "awaiting")!.count).toBe(3);
  });

  it("a genuinely empty workspace renders honest zeros, not n/a", () => {
    const stats = buildSnapshot(
      populatedInput({ desk: [], assurance: [], tasks: [], buyerViews: [], commerceJobs: [] }),
    );
    expect(stats.find((s) => s.key === "active")!.count).toBe(0);
    expect(stats.find((s) => s.key === "completed")!.count).toBe(0);
  });

  it("buyer counts stay n/a for a failed buyer store and 0 for an empty one", () => {
    const failed = buildSnapshot(populatedInput({ buyerViews: null }));
    expect(failed.find((s) => s.key === "buyer")!.count).toBeNull();
    const empty = buildSnapshot(populatedInput({ buyerViews: [], commerceJobs: [] }));
    expect(empty.find((s) => s.key === "buyer")!.count).toBe(0);
    // The operator identity is not wallet-scoped: the column reports the
    // source as absent rather than pretending to have counted.
    const operator = buildSnapshot(populatedInput({ buyerScoped: false, buyerViews: null, commerceJobs: null }));
    expect(operator.find((s) => s.key === "buyer")!.count).toBeNull();
  });
});

describe("section builders on production-shaped records", () => {
  it("work in progress: awaiting, stale, executing and buyer rows with next actions", () => {
    const rows = buildWorkInProgress(
      populatedInput({
        desk: [healthyDesk({ status: "collecting", createdAt: iso(-72 * 60 * 60 * 1000) })],
        tasks: [
          legacyTask({ state: "executing", goal: "Free pre-flight" }),
          legacyTask({ id: "ov-t-await", state: "awaiting_approval", goal: "PAID intelligence plan", updatedAt: NOW - 60 * 1000 }),
        ],
        buyerViews: [buyerView({ action: "fund" })],
      }),
      NOW,
    );
    const awaiting = rows.find((r) => r.stateLabel === "Awaiting approval");
    expect(awaiting?.awaiting).toBe(true);
    expect(awaiting?.nextAction).toContain("approve");
    const stale = rows.find((r) => r.title.includes("NS-CP-OVTEST3"));
    expect(stale?.stateLabel).toContain("longer than usual");
    expect(rows.some((r) => r.kindLabel === "Buyer job" && r.nextAction.includes("fund"))).toBe(true);
    expect(rows.some((r) => r.stateLabel === "Executing")).toBe(true);
    // Sorted newest-first.
    const times = rows.map((r) => r.updatedTs);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("recent activity: decisions, answers, failures, commerce — honest labels, newest first", () => {
    const rows = buildRecentActivity(
      populatedInput({
        desk: [healthyDesk({ status: "reported", report: { confidence: "proceed_on_record" } as unknown as DeskInvestigation["report"] })],
        tasks: [
          legacyTask({ id: "ov-t-done", state: "completed", goal: "Which validator set secures the most stake on Base today?" }),
          legacyTask(),
        ],
      }),
    );
    const decision = rows.find((r) => r.meta === "Decision: HOLD");
    expect(decision?.title).toContain("NS-TX-OVTEST4");
    const answered = rows.find((r) => r.meta === "Answered");
    expect(answered).toBeTruthy(); // the spend-less task — no NaN, no crash
    const failedRow = rows.find((r) => r.meta.startsWith("Failed"));
    expect(failedRow?.failed).toBe(true);
    const commerce = rows.find((r) => r.kindLabel === "Commerce");
    expect(commerce?.meta).toContain("Delivered · $19.00");
    const times = rows.map((r) => r.ts);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("network status reports configuration facts, never invented activity", () => {
    const previous = { acp: process.env.ACP_ENABLED, tg: process.env.TELEGRAM_BOT_TOKEN };
    try {
      delete process.env.ACP_ENABLED;
      process.env.TELEGRAM_BOT_TOKEN = "x";
      const items = buildNetworkStatus();
      expect(items.find((n) => n.label === "Agent commerce (ACP)")!.configured).toBe(false);
      expect(items.find((n) => n.label === "Telegram intake")!.configured).toBe(true);
      expect(items.find((n) => n.label === "Base RPC")!.configured).toBe(true);
    } finally {
      if (previous.acp === undefined) delete process.env.ACP_ENABLED;
      else process.env.ACP_ENABLED = previous.acp;
      if (previous.tg === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previous.tg;
    }
  });

  it("quick access: signed-out callers get nothing; a draft gets its resume link", () => {
    expect(buildQuickAccess({ signedIn: false, operator: false, desk: [] })).toHaveLength(0);
    const actions = buildQuickAccess({
      signedIn: true,
      operator: false,
      desk: [healthyDesk({ status: "draft" })],
    });
    expect(actions.some((a) => a.href === "/desk/new")).toBe(true);
    expect(actions.some((a) => a.href === "/history")).toBe(true);
    expect(actions.some((a) => a.href.startsWith("/desk/") && a.label.includes("Resume"))).toBe(true);
    expect(actions.some((a) => a.href === "/console")).toBe(false);
    const operatorActions = buildQuickAccess({ signedIn: true, operator: true, desk: [] });
    expect(operatorActions.some((a) => a.href === "/console")).toBe(true);
  });
});

describe("bounded reads distinguish failed from genuinely empty", () => {
  it("readBounded resolves null for reject and deadline alike", async () => {
    expect(await readBounded(Promise.reject(new Error("x")), 50)).toBeNull();
    expect(await readBounded(new Promise<never>(() => undefined), 50)).toBeNull();
    expect(await readBounded(Promise.resolve(42), 50)).toBe(42);
  });

  it("readOutcome separates 'the store has no such record' from 'the store did not answer'", async () => {
    const empty = await readOutcome(Promise.resolve(null), 50);
    expect(empty.state).toBe("ok"); // verified-empty: a 404 may follow
    if (empty.state === "ok") expect(empty.value).toBeNull();
    const failed = await readOutcome(new Promise<never>(() => undefined), 50);
    expect(failed.state).toBe("failed"); // must render a retry, not a 404
    const rejected = await readOutcome(Promise.reject(new Error("db down")), 50);
    expect(rejected.state).toBe("failed");
  });
});

describe("the identity projections the page uses survive malformed records", () => {
  it("the full task chain — store read, caller projection, public view — with a spend-less record", async () => {
    await persistence().writeNamed("tasks-json-probe", legacyTask({ id: "ov-task-probe" }));
    const tasks = await listTasks();
    const projected = tasksForCaller(new Request("http://test/"), tasks);
    expect(projected.redacted).toBe(true);
    const view = publicTaskView(legacyTask({ id: "ov-task-view" }));
    expect(view.state).toBe("failed");
  });

  it("investigationsForCaller keeps a live legacy file visible to its owner and hidden from anonymous", () => {
    const reqUser = new Request("http://test/", { headers: { cookie: "irrelevant" } });
    const anon = investigationsForCaller(reqUser, [LEGACY_ASSURANCE]);
    expect(anon.investigations).toHaveLength(0);
  });
});

describe("the resolved database client keeps its one-at-a-time chain", () => {
  // Production root cause (proven by the deployed latency diagnostic): after
  // the first successful resolution, resolveDatabase installed the RAW probe
  // client as the shared client — bypassing the query chain — so Overview's
  // three parallel reads over-subscribed the small pool unbounded and hung
  // until the page's 20s deadlines expired: the persistent partial-store
  // banner against a healthy database. The resolved client must always be
  // wrapped in the bounded facade.
  it("client.ts wraps the resolved probe in makeBoundedFacade — never a raw client", () => {
    const source = readFileSync("src/lib/db/client.ts", "utf8");
    expect(source).toContain("g.__nightshiftSql = makeBoundedFacade(probe);");
    expect(source, "the raw probe must never become the shared client").not.toMatch(/g\.__nightshiftSql = probe;/);
    expect(source).toContain("function makeBoundedFacade");
  });
});
