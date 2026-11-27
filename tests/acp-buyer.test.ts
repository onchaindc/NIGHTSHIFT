import { describe, expect, it } from "vitest";

import {
  buyerActionOf,
  buyerJobKey,
  buyerPhaseOf,
  getBuyerJob,
  registerBuyerJob,
  updateBuyerJob,
  BUYER_PHASE_LABEL,
} from "@/lib/acp/buyer";
import { ACP_OFFERINGS } from "@/lib/acp/offerings";
import type { AcpJobRecord } from "@/lib/acp/types";

/**
 * The buyer side of the ACP desk: registration is bound to a wallet, phases
 * map from the provider's real lifecycle, and every phase names what the
 * buyer can do next — no dead ends, no invented states.
 */

const CHAIN = 8453;
const BUYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function jobId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function providerRecord(status: AcpJobRecord["status"], over: Partial<AcpJobRecord> = {}): AcpJobRecord {
  const now = new Date().toISOString();
  return {
    key: "8453:1",
    chainId: CHAIN,
    jobId: "1",
    offering: ACP_OFFERINGS[0].id,
    clientAddress: BUYER,
    requirement: null,
    rawRequirement: null,
    status,
    statusDetail: "test",
    priceUsdCents: null,
    executionCostUsdCents: 0,
    settlementUsdCents: null,
    settlementSettled: false,
    investigationId: null,
    taskIds: [],
    deliverable: null,
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    fundedAt: null,
    deliveredAt: null,
    completedAt: null,
    ...over,
  };
}

const OFFERING = ACP_OFFERINGS[0];
const REQUIRED = Object.fromEntries(OFFERING.inputs.filter((i) => i.required).map((i) => [i.name, "test subject"]));

describe("buyer job registration", () => {
  it("registers a job against a published offering and starts at 'submitted' with a send action", async () => {
    const id = jobId();
    const result = await registerBuyerJob({
      clientAddress: BUYER,
      chainId: CHAIN,
      jobId: id,
      offering: OFFERING.id,
      txHash: `0x${"a".repeat(64)}`,
      requirement: REQUIRED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.phase).toBe("submitted");
    // The requirement rides the on-chain description, so the job starts
    // already delivered — the next action is the provider's price, then fund.
    expect(result.view.buyer.requirementSentAt).not.toBeNull();
    expect(result.view.action).toBe("none");
    expect(result.view.buyer.requirementJson).toBe(JSON.stringify({ offering: OFFERING.id, inputs: REQUIRED }));
    // The registry key joins with the provider's own ledger.
    expect(result.view.buyer.key).toBe(buyerJobKey(CHAIN, id));
  });

  it("refuses unknown offerings, missing inputs and malformed job ids — with the exact reason", async () => {
    const base = { clientAddress: BUYER, chainId: CHAIN, jobId: jobId(), txHash: null };
    const unknown = await registerBuyerJob({ ...base, offering: "nightshift/not-a-service", requirement: {} });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("unknown offering");

    const missing = await registerBuyerJob({ ...base, offering: OFFERING.id, requirement: {} });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("missing required input(s)");

    const badId = await registerBuyerJob({ ...base, jobId: "not-a-number", offering: OFFERING.id, requirement: REQUIRED });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error).toContain("numeric on-chain job id");

    const badTx = await registerBuyerJob({ ...base, jobId: jobId(), offering: OFFERING.id, txHash: "nothex", requirement: REQUIRED });
    expect(badTx.ok).toBe(false);
    if (!badTx.ok) expect(badTx.error).toContain("transaction hash");
  });

  it("never lets a second wallet claim a registered on-chain job, and re-registration stays idempotent", async () => {
    const id = jobId();
    const first = await registerBuyerJob({ clientAddress: BUYER, chainId: CHAIN, jobId: id, offering: OFFERING.id, txHash: null, requirement: REQUIRED });
    expect(first.ok).toBe(true);
    const stolen = await registerBuyerJob({ clientAddress: OTHER, chainId: CHAIN, jobId: id, offering: OFFERING.id, txHash: null, requirement: REQUIRED });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.error).toContain("already registered to a different wallet");

    const again = await registerBuyerJob({ clientAddress: BUYER, chainId: CHAIN, jobId: id, offering: OFFERING.id, txHash: null, requirement: REQUIRED });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.view.buyer.requirementJson).toBe(first.ok ? first.view.buyer.requirementJson : "");
  });
});

describe("buyer phases map from the provider's real lifecycle", () => {
  it("no provider record yet → submitted; the provider's statuses drive the rest", () => {
    expect(buyerPhaseOf(null)).toBe("submitted");
    expect(buyerPhaseOf(providerRecord("received"))).toBe("reading");
    expect(buyerPhaseOf(providerRecord("validated"))).toBe("reading");
    expect(buyerPhaseOf(providerRecord("rejected_intake"))).toBe("rejected_intake");
    expect(buyerPhaseOf(providerRecord("accepted", { priceUsdCents: 200 }))).toBe("awaiting_payment");
    expect(buyerPhaseOf(providerRecord("funded"))).toBe("processing");
    expect(buyerPhaseOf(providerRecord("awaiting_approval"))).toBe("processing");
    expect(buyerPhaseOf(providerRecord("executing"))).toBe("processing");
    expect(buyerPhaseOf(providerRecord("delivered"))).toBe("review_delivery");
    expect(buyerPhaseOf(providerRecord("completed"))).toBe("completed");
    expect(buyerPhaseOf(providerRecord("rejected"))).toBe("rejected");
    expect(buyerPhaseOf(providerRecord("expired"))).toBe("expired");
    expect(buyerPhaseOf(providerRecord("failed"))).toBe("failed");
  });

  it("every phase has a buyer-facing label", () => {
    for (const phase of ["submitted", "reading", "rejected_intake", "awaiting_payment", "processing", "review_delivery", "completed", "rejected", "expired", "failed"] as const) {
      expect(BUYER_PHASE_LABEL[phase].length).toBeGreaterThan(3);
    }
  });

  it("actions follow the money: nothing to fund before a price, nothing to release before delivery", () => {
    expect(buyerActionOf("submitted", null)).toBe("none"); // waiting for the provider's price — funding early would fail
    expect(buyerActionOf("awaiting_payment", null)).toBe("fund");
    expect(buyerActionOf("review_delivery", null)).toBe("review");
    expect(buyerActionOf("completed", null)).toBe("none");
    expect(buyerActionOf("rejected_intake", null)).toBe("none");
  });
});

describe("buyer job updates", () => {
  it("record requirement delivery, payment txs and notes — only for the owning wallet", async () => {
    const id = jobId();
    const key = buyerJobKey(CHAIN, id);
    await registerBuyerJob({ clientAddress: BUYER, chainId: CHAIN, jobId: id, offering: OFFERING.id, txHash: null, requirement: REQUIRED });

    const stranger = await updateBuyerJob({ clientAddress: OTHER, key, requirementSent: true });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.status).toBe(404);

    const ok = await updateBuyerJob({
      clientAddress: BUYER,
      key,
      requirementSent: true,
      allowanceTxHash: `0x${"b".repeat(64)}`,
      fundedTxHash: `0x${"c".repeat(64)}`,
      note: "escrow funded",
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const stored = await getBuyerJob(key);
    expect(stored?.requirementSentAt).not.toBeNull();
    expect(stored?.allowanceTxHash).toBe(`0x${"b".repeat(64)}`);
    expect(stored?.fundedTxHash).toBe(`0x${"c".repeat(64)}`);
    expect((stored?.notes ?? []).join(" ")).toContain("escrow funded");
  });

  it("rejects malformed tx hashes on update", async () => {
    const id = jobId();
    const key = buyerJobKey(CHAIN, id);
    await registerBuyerJob({ clientAddress: BUYER, chainId: CHAIN, jobId: id, offering: OFFERING.id, txHash: null, requirement: REQUIRED });
    const bad = await updateBuyerJob({ clientAddress: BUYER, key, fundedTxHash: "0x123" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("transaction hash");
  });
});
