import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Pins this session's product contract at source level:
 *
 *   1. A finished run takes the reader straight to the report — the desk
 *      absorbs + rebuilds in the background (no manual sync step), shows a
 *      loading state instead of a button, and scrolls to the report when it
 *      lands.
 *   2. Every report/result surface keeps the ANSWER first: secondary sections
 *      sit in closed, counted ReportDisclosure collapsibles.
 *   3. Every surface that can start a PAID run asks first — the shared
 *      ConfirmPaidRun modal, with a cost line and a real Cancel.
 *   4. The heavy network reads are memoized with the honesty rule intact:
 *      only successful, non-empty reads are cached; failures are never.
 */

function src(path: string): string {
  return readFileSync(path, "utf8");
}

const PAID_RUN_SURFACES = [
  "src/components/desk/desk-workspace.tsx",
  "src/components/assurance/assurance-workspace.tsx",
  "src/components/minds/capability-console.tsx",
  "src/components/bitcoinmining/bitcoin-mining-client.tsx",
  "src/components/indexdesk/index-desk-client.tsx",
];

describe("a finished run goes straight to the report", () => {
  const desk = () => src("src/components/desk/desk-workspace.tsx");

  it("the desk workspace has no manual sync step", () => {
    const source = desk();
    expect(source, 'the "Sync & rebuild report" button is gone').not.toContain("Sync & rebuild report");
    expect(source, 'the old busy key "sync" is gone').not.toContain('busy === "sync"');
    expect(source, 'a completed run is absorbed exactly once, in the background').toContain('void act("sync-report"');
    expect(source, "the absorb fires even when the file is opened with the run already done").toContain(
      'if (body.task.state === "completed" && syncedForRef.current !== body.task.id)',
    );
  });

  it("the desk shows a building state, never a blank gap, while the report assembles", () => {
    const source = desk();
    expect(source).toContain('aria-label="Report building"');
    expect(source).toContain("Building the report…");
  });

  it("the desk scrolls the reader to the report when it lands after a live finish", () => {
    const source = desk();
    expect(source).toContain("justFinishedRef.current = true");
    expect(source).toMatch(/if \(inv\?\.report\) \{\s*\n\s*justFinishedRef\.current = false;/);
  });
});

describe("the answer is the spotlight on every result surface", () => {
  it("the desk report opens with the answer and keeps secondary sections in closed disclosures", () => {
    const source = src("src/components/desk/desk-workspace.tsx");
    expect(source).toContain("The answer · the activity trail sits further down");
    expect(source).toMatch(/<ReportDisclosure\s+title="Discrepancies"/);
    expect(source).toMatch(/<ReportDisclosure\s+title="What the report covers, section by section"/);
    expect(source).toMatch(/<ReportDisclosure\s+title="Confidence limitations"/);
    expect(source).toMatch(/<ReportDisclosure\s+title="Outstanding questions"/);
    expect(source).toMatch(/<ReportDisclosure\s+title="How to read this report"/);
    expect(source).toContain('<ReportDisclosure title="More findings"');
  });

  it("the activity trail stays its own section, grouped into counted disclosures", () => {
    const source = src("src/components/desk/desk-workspace.tsx");
    expect(source).toContain('aria-label="Activity trail"');
    expect(source).toContain("title={`${PROVENANCE_CHIP[key]?.word ?? key} records`}");
  });

  it("the counterparty answer collapses its paper trail, keeps verified facts and disagreements open", () => {
    const source = src("src/components/counterparty/counterparty-client.tsx");
    expect(source).toContain('<ReportDisclosure title="Receipt &amp; signal">');
    expect(source).toContain('title="Supporting evidence"');
    expect(source).toContain("Verified facts");
    expect(source).toContain("Disagreements");
  });

  it("the shared disclosure is native details — no client JS, closed by default", () => {
    const source = src("src/components/report/collapsible.tsx");
    expect(source).toContain("<details");
    expect(source, "no useState — the component must not hydrate").not.toContain("useState");
  });
});

describe("paid runs start directly — the confirmation gate is gone", () => {
  // The confirmation modal was removed by product decision: every paid run
  // already stops at the SERVER-SIDE approval gate, where the exact priced
  // plan is shown before anything is signed. The extra client-side popup was
  // redundant friction with no safety value.
  it("no surface renders ConfirmPaidRun any more", () => {
    for (const file of PAID_RUN_SURFACES) {
      const source = src(file);
      expect(source, `${file} must not import ConfirmPaidRun`).not.toMatch(/from "@\/components\/confirm-paid-run"/);
      expect(source, `${file} must not render <ConfirmPaidRun`).not.toContain("<ConfirmPaidRun");
    }
  });

  it("the desk paid button fires the run directly — the fetch lives on the click", () => {
    const source = src("src/components/desk/desk-workspace.tsx");
    expect(source).toContain('action: "run", mode: "intel"');
    expect(source).not.toContain("setPaidConfirmOpen");
    const click = source.indexOf("onClick={() =>");
    const runFetch = source.indexOf('body: JSON.stringify({ action: "run", mode: "intel" })');
    expect(click).toBeGreaterThan(-1);
    expect(runFetch, "the intel fetch appears after the button's onClick").toBeGreaterThan(click);
  });

  it("the flagship consoles start their intel run straight from the button", () => {
    const capability = src("src/components/minds/capability-console.tsx");
    expect(capability).toContain("onClick={() => void start()}");
    const mining = src("src/components/bitcoinmining/bitcoin-mining-client.tsx");
    expect(mining).toContain("onClick={() => void start()}");
    const index = src("src/components/indexdesk/index-desk-client.tsx");
    expect(index).toContain("onClick={() => void runDesk()}");
    const assurance = src("src/components/assurance/assurance-workspace.tsx");
    expect(assurance).toContain('body: JSON.stringify({ action: "run", mode: "intel" })');
    expect(assurance).not.toContain("setPaidConfirm");
  });

  it("modals render through a portal — fixed positioning cannot be captured", () => {
    // A filled transform animation on a page root made that root the
    // containing block for position:fixed — the withdraw dialog appeared
    // mid-document. Portals to document.body are immune to every ancestor.
    const funds = src("src/app/(explorer)/funds/page.tsx");
    expect(funds).toContain("createPortal");
    const confirm = src("src/components/confirm-paid-run.tsx");
    expect(confirm).toContain("createPortal");
  });
});

describe("the heavy network reads are memoized without caching failures", () => {
  it("the miner catalog memo only ever holds a successful non-empty read", () => {
    const source = src("src/lib/explorer/network.ts");
    expect(source).toContain("MINER_MEMO_TTL_MS");
    expect(source, "a fresh successful read feeds the memo").toContain("minerMemo = { at: Date.now(), payload: miners }");
    expect(source, "an empty catalog is still refused, never cached").toContain('detail = "the node returned an empty miner catalog"');
    expect(source, "the node-down path serves the last good catalog").toContain("if (minerStale) return { status: \"ok\", payload: minerStale };");
  });

  it("the live-offer probe is memoized briefly and falls back to the last good offer", () => {
    const source = src("src/lib/explorer/network.ts");
    expect(source).toContain("OFFER_MEMO_TTL_MS");
    expect(source).toContain("offerStale = payload;");
  });
});
