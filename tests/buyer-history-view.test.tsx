import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { HistoryView } from "@/components/buyer/history-view";
import type { BuyerJobRecord, BuyerJobView } from "@/lib/acp/buyer";

/**
 * Purchase history rendering: empty and FAILED loads are different truths.
 * The regression — loadJobs used to swallow every error, so a failed fetch
 * rendered as "No requests yet", telling a buyer with on-chain purchases
 * that they had none.
 */

function buyerRecord(over: Partial<BuyerJobRecord> = {}): BuyerJobRecord {
  const now = new Date().toISOString();
  return {
    key: "8453:42",
    chainId: 8453,
    jobId: "42",
    offering: "nightshift/counterparty-due-diligence",
    clientAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    txHash: null,
    requirement: {},
    requirementJson: "{}",
    requirementSentAt: now,
    expiresAt: null,
    allowanceTxHash: null,
    fundedTxHash: null,
    completedTxHash: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function view(over: Partial<BuyerJobView> = {}): BuyerJobView {
  return { buyer: buyerRecord(), provider: null, phase: "submitted", phaseLabel: "Job submitted on-chain", action: "none", ...over };
}

describe("HistoryView — empty vs failed vs loaded", () => {
  it("empty with no failure says no requests yet", () => {
    const html = renderToStaticMarkup(<HistoryView jobs={[]} activeKey={null} onOpen={() => undefined} />);
    expect(html).toContain("No requests yet");
    expect(html).not.toContain("could not be loaded");
  });

  it("a FAILED load with nothing cached never claims 'no requests'", () => {
    const html = renderToStaticMarkup(
      <HistoryView jobs={[]} activeKey={null} onOpen={() => undefined} loadFailed={true} onRetry={() => undefined} />,
    );
    expect(html).toContain("could not be loaded");
    expect(html).toContain("Try again");
    expect(html).toContain("Nothing was lost");
    expect(html).not.toContain("No requests yet");
  });

  it("a failed refresh with a loaded list says so and offers a retry", () => {
    const html = renderToStaticMarkup(
      <HistoryView jobs={[view()]} activeKey={null} onOpen={() => undefined} loadFailed={true} onRetry={() => undefined} />,
    );
    expect(html).toContain("The last refresh failed");
    expect(html).toContain("Retry");
    expect(html).toContain("Job submitted on-chain");
  });

  it("renders loaded jobs with their phase and an open action", () => {
    const html = renderToStaticMarkup(<HistoryView jobs={[view()]} activeKey={null} onOpen={() => undefined} />);
    expect(html).toContain("counterparty-due-diligence");
    expect(html).toContain("Open tracking");
    expect(html).toContain("job 42");
  });
});
