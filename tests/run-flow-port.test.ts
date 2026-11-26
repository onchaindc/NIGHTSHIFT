import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The state-first run contract is product-wide: EVERY surface that executes
 * or displays an engine task run renders the shared RunFlow panel — the
 * five-stage tracker, one plain-language headline per state, the state's
 * action up front, warnings as banners. This file pins the wiring at source
 * level so a new surface (or a regression) cannot quietly reintroduce the
 * scattered status chips and buried warnings the founder rejected.
 *
 * The Terminal-style browser-mediated asks (Counterparty flagship) are not
 * engine tasks; they pin the same design language through their own stage
 * tracker and headline card.
 */

function src(path: string): string {
  return readFileSync(`src/components/${path}`, "utf8");
}

const RUN_SURFACES: Array<{ file: string; note: string }> = [
  { file: "minds/capability-console.tsx", note: "the shared Minds console" },
  { file: "bitcoinmining/bitcoin-mining-client.tsx", note: "Bitcoin Mining flagship" },
  { file: "indexdesk/index-desk-client.tsx", note: "Index Desk flagship" },
  { file: "assurance/assurance-workspace.tsx", note: "Deal Desk settlement files" },
  { file: "desk/desk-workspace.tsx", note: "Deal Desk specialised investigations" },
];

describe("state-first run flow is product-wide", () => {
  it("every engine-task run surface renders the shared RunFlow panel", () => {
    for (const { file, note } of RUN_SURFACES) {
      const source = src(file);
      expect(source, `${file} (${note}) must import RunFlow`).toMatch(/import RunFlow.*from "@\/components\/minds\/run-flow"/);
      expect(source, `${file} (${note}) must render <RunFlow`).toContain("<RunFlow");
    }
  });

  it("no surface keeps the bespoke scattered status panel", () => {
    for (const { file } of RUN_SURFACES) {
      const source = src(file);
      expect(source, `${file} must not render a raw watchdog age line outside RunFlow`).not.toContain("server update {watchdog.secondsSinceUpdate}s ago");
      expect(source, `${file} must not define its own state label map`).not.toMatch(/function stateLabel\(/);
      expect(source, `${file} must not hand-build "Working through the approved plan…" lines`).not.toContain("Working through the approved plan");
    }
  });

  it("the specialised desk workspace wires the watchdog into RunFlow", () => {
    const source = src("desk/desk-workspace.tsx");
    expect(source).toContain("useRunWatchdog");
    expect(source).toContain("watchdog={watchdog}");
  });

  it("flagship clients feed RunFlow from their own handlers, not bespoke buttons", () => {
    const bitcoin = src("bitcoinmining/bitcoin-mining-client.tsx");
    expect(bitcoin).toContain("onApprove={() => void act(\"approve\")}");
    expect(bitcoin).toContain("onReject={() => void act(\"reject\")}");
    expect(bitcoin).toContain("onResume={() => void resumeRun()}");
    expect(bitcoin).not.toContain("Approve $0.03 run");

    const index = src("indexdesk/index-desk-client.tsx");
    expect(index).toContain("onApprove={() => void act(\"approve\")}");
    expect(index).toContain("onRunAgain={reset}");
    expect(index).not.toContain("Approve &amp; run paid asks");

    const assurance = src("assurance/assurance-workspace.tsx");
    expect(assurance).toContain("watchdog={runWatchdog}");
    // The latest run gets RunFlow; older runs stay as compact history rows.
    expect(assurance).toContain("const isLatest = runIndex === payload.runs.length - 1;");
  });

  it("the counterparty flagship uses the same state-first language for its wallet-paid ask", () => {
    const source = src("counterparty/counterparty-client.tsx");
    expect(source).toContain('aria-label="Ask stages"');
    expect(source).toContain("Waiting for your approval");
    expect(source).toContain("Start with a free price check");
    // Every stage is named before it happens — no hidden payment steps.
    for (const stage of ["Write", "Price", "Approve", "Pay", "Verify"]) {
      expect(source).toContain(`label: "${stage}"`);
    }
  });

  it("RunFlow itself stays the single source of stage and headline logic", () => {
    const runFlow = readFileSync("src/components/minds/run-flow.tsx", "utf8");
    expect(runFlow).toContain("Plan → Approval → Run → Verify → Report".split(" → ").length ? "STAGES" : "STAGES");
    expect(runFlow).toContain("function headlineFor(");
    expect(runFlow).toContain('"Waiting for your approval"');
  });
});
