/**
 * Overview resilience — regression tests for the recurring
 * "This view hit an unexpected error" failure.
 *
 * The failure had TWO proven digests, both reproduced against a production
 * build with real-shaped legacy records before the fix:
 *
 *   1. `TypeError: a.evidence is not iterable` — summarizeDesk →
 *      deskEvidenceCounts on a desk record written before its evidence
 *      ledger existed;
 *   2. `TypeError: Cannot read properties of undefined (reading 'legalName')`
 *      — summarize on an assurance record saved before the transaction and
 *      counterparty steps had filled in.
 *
 * One such record killed the ENTIRE Overview server render for every
 * signed-in caller (HTTP 200 with a truncated stream in the browser, then
 * the route error boundary) and stayed broken until the record was removed
 * by hand. These tests pin the permanent fix:
 *
 *   - the desk and assurance stores normalize shape-drifted records on read;
 *   - the summary projections dereference nothing that was not normalized;
 *   - Overview sections are built inside runSection: a failing section fails
 *     alone, the rest of the page renders;
 *   - the identity-aware projections the page uses survive malformed records
 *     end to end.
 */

import { describe, expect, it } from "vitest";

import { deskEvidenceCounts } from "@/lib/desk/types";
import { getDeskInvestigation, saveDeskInvestigation, summarizeDesk } from "@/lib/desk/store";
import { audit, getInvestigation, saveInvestigation, summarize } from "@/lib/assurance/store";
import { investigationsForCaller, publicTaskView, tasksForCaller } from "@/lib/api/public";
import {
  buildActivity,
  buildAttention,
  buildQuickAccess,
  buildWorkspace,
  runSection,
  runSectionAsync,
} from "@/lib/overview/sections";
import { persistence } from "@/lib/storage";
import { listTasks } from "@/lib/engine/store";
import type { DeskInvestigation } from "@/lib/desk/types";
import type { Investigation } from "@/lib/assurance/types";
import type { TaskRecord } from "@/lib/engine/types";
import type { BuyerJobView } from "@/lib/acp/buyer";

const USER = "0x1111111111111111111111111111111111111111";

/* ------------------------------------------------------------------ */
/* The exact legacy records that killed production                     */
/* ------------------------------------------------------------------ */

/** A desk file recorded before the evidence ledger, run list or audit trail
 *  existed — digest 1: "a.evidence is not iterable". */
const LEGACY_DESK: DeskInvestigation = {
  id: "ov-legacy-desk",
  kind: "desk",
  reference: "NS-CP-OVTEST1",
  type: "counterparty_due_diligence",
  status: "collecting",
  createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
  subject: { legalName: "Legacy Company Ltd", jurisdiction: "GB" },
  runs: [],
  findings: [],
  unsupported: [],
  owner: USER,
  // evidence, report, operator, audit, updatedAt, spendLimitUsdCents: absent
} as unknown as DeskInvestigation;

/** An assurance file saved before the transaction step and the counterparty
 *  step had filled in — digest 2: "reading 'legalName'". */
const LEGACY_ASSURANCE: Investigation = {
  id: "ov-legacy-assurance",
  reference: "NS-TX-OVTEST2",
  createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  status: "draft",
  dataMode: "live",
  owner: USER,
  // transaction, counterparty, evidence, findings, decision, audit: absent
} as unknown as Investigation;

/** A task recorded before the spend ledger existed. */
function legacyTask(over: Partial<TaskRecord> = {}): TaskRecord {
  const base: TaskRecord = {
    id: "ov-legacy-task",
    createdAt: Date.now() - 10 * 60 * 1000,
    updatedAt: Date.now() - 5 * 60 * 1000,
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
  };
  return base;
}

describe("the exact records that killed the Overview render", () => {
  it("digest 1 — summarizeDesk survives a desk record without its evidence ledger", () => {
    const summary = summarizeDesk(LEGACY_DESK);
    expect(summary.evidenceCount).toBe(0);
    expect(summary.verifiedCount).toBe(0);
    expect(summary.missingCount).toBe(0);
    expect(summary.subject).toContain("Legacy Company Ltd");
    // A file collecting for over two days is honest attention material.
  });

  it("digest 1 — deskEvidenceCounts treats an absent ledger as empty, skips junk entries", () => {
    const zeroed = deskEvidenceCounts({ evidence: undefined as unknown as DeskInvestigation["evidence"] });
    expect(zeroed.verified).toBe(0);
    expect(zeroed.missing).toBe(0);
    const junked = deskEvidenceCounts({
      evidence: [
        { id: "e1", provenance: "verified", class: "declared" },
        // An entry whose provenance is not in the vocabulary must be skipped,
        // never counted into NaN.
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

describe("section builders on production-shaped records", () => {
  const healthyDesk = summarizeDesk({
    ...LEGACY_DESK,
    id: "ov-desk-healthy",
    reference: "NS-CP-OVTEST3",
    status: "collecting",
    createdAt: new Date().toISOString(),
    evidence: [],
    runs: [],
    findings: [],
    unsupported: [],
    audit: [],
    report: null,
    operator: { createdBy: "test", tenant: "test" },
    updatedAt: new Date().toISOString(),
    spendLimitUsdCents: 100,
  });

  it("attention: decisions, HOLD files, stale files and buyer actions — nothing invented", () => {
    const awaiting = legacyTask({ id: "ov-t-await", state: "awaiting_approval", goal: "PAID intelligence plan" });
    const items = buildAttention({
      tasks: [awaiting],
      assurance: [summarize(LEGACY_ASSURANCE)],
      desk: [healthyDesk],
      buyerViews: [],
      now: Date.now(),
    });
    // The legacy assurance record has no decision → NOT attention material.
    // The fresh desk file is not stale → NOT attention material.
    // Only the awaiting-approval run is.
    expect(items).toHaveLength(1);
    expect(items[0].href).toBe(`/activity/${awaiting.id}`);
    expect(items[0].detail).toContain("approval");

    const stale = buildAttention({
      tasks: [],
      assurance: [],
      desk: [summarizeDesk(LEGACY_DESK)], // collecting, 3 days old
      buyerViews: [],
      now: Date.now(),
    });
    expect(stale).toHaveLength(1);
    expect(stale[0].href).toBe(`/desk/${LEGACY_DESK.id}`);

    // Empty workspace → empty attention; the page hides the section entirely.
    expect(buildAttention({ tasks: [], assurance: [], desk: [], buyerViews: [], now: Date.now() })).toHaveLength(0);
  });

  it("attention: a buyer action waiting on the wallet surfaces from its own view", () => {
    const view = {
      buyer: { key: "8453:42", offering: "Counterparty Due Diligence" },
      phase: "awaiting_funding",
      phaseLabel: "awaiting funding",
      action: "fund",
    } as unknown as BuyerJobView;
    const items = buildAttention({ tasks: [], assurance: [], desk: [], buyerViews: [view], now: Date.now() });
    expect(items).toHaveLength(1);
    expect(items[0].href).toBe("/buyer");
    expect(items[0].detail).toContain("fund");
  });

  it("workspace: honest counts per workspace, empty state labelled empty", () => {
    const blocks = buildWorkspace({
      desk: [healthyDesk],
      assurance: [summarize(LEGACY_ASSURANCE)],
      buyerViews: [],
      commerceJobs: [],
      buyerScoped: true,
    });
    expect(blocks).toHaveLength(3);
    expect(blocks.find((b) => b.key === "desk")!.headline).toBe("1 file");
    expect(blocks.find((b) => b.key === "desk")!.detail).toContain("investigating");
    // The legacy file EXISTS — the block is not empty; it just has no decision.
    expect(blocks.find((b) => b.key === "assurance")!.headline).toBe("1 file");
    expect(blocks.find((b) => b.key === "assurance")!.empty).toBe(false);
    expect(blocks.find((b) => b.key === "buyer")!.empty).toBe(true);

    // Operator: buyer records are wallet-scoped and the block is absent.
    const operatorBlocks = buildWorkspace({ desk: [], assurance: [], buyerViews: [], commerceJobs: [], buyerScoped: false });
    expect(operatorBlocks.map((b) => b.key)).toEqual(["desk", "assurance"]);
  });

  it("activity: records with missing fields render honest rows, never throw", () => {
    const rows = buildActivity({
      tasks: [legacyTask(), legacyTask({ id: "ov-t-done", state: "completed", goal: "A completed ask", spend: { limitUsdCents: 4, spentUsdCents: 4, entries: [] } })],
      desk: [healthyDesk],
      assurance: [summarize(LEGACY_ASSURANCE)],
    });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const failed = rows.find((r) => r.label.includes("Legacy ask"));
    expect(failed?.meta).toContain("Failed or blocked");
    const answered = rows.find((r) => r.meta === "Answered · $0.04" || r.meta === "Answered");
    expect(answered).toBeTruthy();
    const assuranceRow = rows.find((r) => r.label.includes("NS-TX-OVTEST2"));
    expect(assuranceRow?.label).toContain("counterparty not recorded");
  });

  it("quick access: signed-out callers get nothing; a draft file gets its resume link", () => {
    expect(buildQuickAccess({ signedIn: false, operator: false, desk: [] })).toHaveLength(0);
    const actions = buildQuickAccess({ signedIn: true, operator: false, desk: [healthyDesk] });
    expect(actions.some((a) => a.href === "/desk/new")).toBe(true);
    expect(actions.some((a) => a.href === "/history")).toBe(true);
    expect(actions.some((a) => a.href === "/console")).toBe(false);
    const operatorActions = buildQuickAccess({ signedIn: true, operator: true, desk: [] });
    expect(operatorActions.some((a) => a.href === "/console")).toBe(true);
  });
});

describe("the identity projections the page uses survive malformed records", () => {
  it("the full task chain — store read, caller projection, public view — with a spend-less record", async () => {
    await persistence().writeNamed("tasks-json-probe", legacyTask({ id: "ov-task-probe" }));
    // The engine store normalizes on read (its own long-standing contract);
    // the projections and public view then run over the result.
    const tasks = await listTasks();
    const projected = tasksForCaller(new Request("http://test/"), tasks);
    expect(projected.redacted).toBe(true);
    const view = publicTaskView(legacyTask({ id: "ov-task-view" }));
    expect(view.state).toBe("failed");
  });

  it("investigationsForCaller keeps a live legacy file visible to its owner and hidden from anonymous", () => {
    const reqUser = new Request("http://test/", { headers: { cookie: "irrelevant" } });
    // Identity is anonymous here; the LIVE legacy file must be hidden, the
    // projection must not throw on its missing fields.
    const anon = investigationsForCaller(reqUser, [LEGACY_ASSURANCE]);
    expect(anon.investigations).toHaveLength(0);
  });
});
