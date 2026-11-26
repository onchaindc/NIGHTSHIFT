import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import RunFlow, { type RunFlowProps } from "@/components/minds/run-flow";
import type { ExecutionEvent, PlanStep, TaskRecord } from "@/lib/engine/types";

/**
 * The RunFlow panel is the execution lifecycle the reader actually sees. Its
 * contract: every task state renders ONE plain-language headline, the five
 * stage tracker always shows where the run is, and no state is a dead end —
 * approval offers approve/reject, failure offers resume (when progress
 * survives) and always "run a new investigation", completion offers the
 * report.
 */

function ev(id: string, type: ExecutionEvent["type"], message = ""): ExecutionEvent {
  return { id, ts: 1_700_000_000_000 + Number(id), type, message };
}

const DEFAULT_PLAN: PlanStep[] = [
  { id: "s1", kind: "free_public_lookup", description: "price lookup", maxCostUsdCents: 60 },
  { id: "s2", kind: "telegraph_ask", description: "paid answer", maxCostUsdCents: 80 },
  { id: "s3", kind: "telegraph_ask", description: "paid answer 2", maxCostUsdCents: 60 },
  { id: "s4", kind: "verify_evidence", description: "verify" },
];

function task(state: TaskRecord["state"], over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    state,
    goal: "probe the subject",
    plan: over.plan ?? DEFAULT_PLAN,
    events: over.events ?? [],
    spend: over.spend ?? { limitUsdCents: 200, spentUsdCents: 0, entries: [] },
    permissions: { allowedActions: [], requiresApproval: true, maxRetries: 1 },
    criteria: {} as TaskRecord["criteria"],
    result: over.result ?? null,
    error: over.error ?? null,
    origin: { source: "web" },
    progress: over.progress,
  };
}

function watch(secondsSinceUpdate = 5, longRun = false, silent = false) {
  return { secondsSinceUpdate, longRun, silent };
}

const BASE: Omit<RunFlowProps, "task"> = {
  mode: "intel",
  routableCount: 3,
  ceilingUsdCents: 200,
  canAct: true,
  signedIn: true,
  acting: null,
  actionError: null,
  onApprove: () => {},
  onReject: () => {},
  onResume: () => {},
  resuming: false,
  onRunAgain: () => {},
  onSignIn: () => {},
  onReadReport: () => {},
  redacted: false,
  watchdog: watch(),
};

function render(t: TaskRecord, extra: Partial<Omit<RunFlowProps, "task">> = {}): string {
  return renderToStaticMarkup(<RunFlow {...BASE} {...extra} task={t} />);
}

describe("RunFlow — one headline per state", () => {
  it("awaiting approval: names the decision, prices it, and marks the stage as the reader's", () => {
    const html = render(task("awaiting_approval", { events: [ev("1", "plan_created", "4 steps planned"), ev("2", "capability_baseline_ready", "prices recorded")] }));
    expect(html).toContain("Waiting for your approval");
    expect(html).toContain("Nothing is bought until you approve.");
    expect(html).toContain("Approve — spend up to $2.00");
    expect(html).toContain("Reject");
    expect(html).toContain("Approval — you");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Plan ready");
    expect(html).toContain("Route prices recorded");
  });

  it("awaiting approval without authority says who can act instead of disabling silently", () => {
    const html = render(task("awaiting_approval"), { canAct: false, signedIn: false });
    expect(html).toContain("Sign in to approve or reject");
    expect(html).toContain("disabled");
  });

  it("planning and executing say what is happening and how far along", () => {
    expect(render(task("planning"))).toContain("Planning your investigation…");
    const html = render(task("executing", { progress: { completedSteps: 1 }, spend: { limitUsdCents: 200, spentUsdCents: 80, entries: [] } }));
    expect(html).toContain("Running the plan");
    expect(html).toContain("Step 2 of 4");
    expect(html).toContain("paid $0.80 of up to $2.00");
  });

  it("verifying says answers are being re-derived", () => {
    expect(render(task("verifying"))).toContain("Verifying the answers");
  });

  it("completed: counts the answers and offers the report", () => {
    const html = render(task("completed", {
      result: { summary: "", capabilityReport: { counts: { verified: 2, recorded: 1, unverified: 0, routable_unverified: 0, gap: 0 }, spendUsdCents: 120 } } as TaskRecord["result"],
    }));
    expect(html).toContain("Report ready");
    expect(html).toContain("3 answers returned, 2 re-verified");
    expect(html).toContain("Read the report");
  });

  it("failed with surviving progress offers resume AND a fresh start — no dead end", () => {
    const html = render(task("failed", { error: "provider rejected the payment", progress: { completedSteps: 2 } }));
    expect(html).toContain("The run failed");
    expect(html).toContain("provider rejected the payment");
    expect(html).toContain("Resume from step 3");
    expect(html).toContain("2 completed steps are kept — already paid for, nothing re-charged.");
    expect(html).toContain("Run a new investigation");
  });

  it("failed with no progress still offers a fresh start", () => {
    const html = render(task("failed", { error: "no routable provider" }));
    expect(html).toContain("The run failed");
    expect(html).not.toContain("Resume from step");
    expect(html).toContain("Run a new investigation");
  });

  it("rejected and blocked are named, with a way forward", () => {
    expect(render(task("rejected"))).toContain("You rejected the plan");
    expect(render(task("rejected"))).toContain("Nothing was spent");
    expect(render(task("blocked", { error: "plan exceeds the budget" })).length).toBeGreaterThan(0);
    expect(render(task("blocked", { error: "plan exceeds the budget" }))).toContain("The run was blocked");
    expect(render(task("blocked", { error: "plan exceeds the budget" }))).toContain("Run a new investigation");
  });

  it("redacted report: says sign in instead of showing a silent hole", () => {
    const html = render(task("completed"), { redacted: true });
    expect(html).toContain("Report ready — sign in to read it");
    expect(html).toContain("Sign in to read the report");
  });
});

describe("RunFlow — tracker and warnings", () => {
  it("free runs mark the approval stage as not needed", () => {
    const html = render(task("executing"), { mode: "free" });
    expect(html).toContain("line-through");
  });

  it("a stalled run warns in plain words instead of spinning forever", () => {
    const html = render(task("executing"), { watchdog: watch(200, false, true) });
    expect(html).toContain("No server update for 3m 20s");
    expect(html).toContain("nothing after the last recorded step is invented");
  });

  it("an unusually long run says it will end shortly", () => {
    const html = render(task("executing"), { watchdog: watch(300, true, false) });
    expect(html).toContain("Unusually long run");
    expect(html).toContain("capped at 4 minutes");
  });

  it("machine event types are spoken in human words", () => {
    const html = render(task("executing", {
      events: [ev("1", "step_started", "Purchasing intelligence"), ev("2", "spend_recorded", "402 settled"), ev("3", "step_failed", "provider timeout")],
    }));
    expect(html).toContain("Provider paid");
    expect(html).toContain("Step failed");
    expect(html).toContain("Purchasing intelligence");
  });

  it("the spend line distinguishes free runs from paid ceilings", () => {
    const free = render(task("executing", { spend: { limitUsdCents: 0, spentUsdCents: 0, entries: [] } }), { mode: "free" });
    expect(free).toContain("free run · no spend");
    const paid = render(task("executing"));
    expect(paid).toContain("paid $0.00 of up to $2.00");
  });
});
