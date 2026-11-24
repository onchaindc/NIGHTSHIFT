/**
 * The shared foundation every Mind inherits.
 *
 * These are not aspirations: each pillar maps to infrastructure that already
 * runs in this deployment, except where a pillar is explicitly marked partial.
 * A Mind contributes its domain model (inputs, dimensions, rules); the engine,
 * payment rail, approval gate, evidence trail and history are shared.
 */

export type FoundationState = "ready" | "partial";

export interface FoundationPillar {
  id: string;
  name: string;
  detail: string;
  state: FoundationState;
  /** Where the capability lives in the codebase. */
  source: string;
}

export const MIND_FOUNDATION: FoundationPillar[] = [
  {
    id: "lifecycle",
    name: "Investigation lifecycle",
    detail:
      "Every investigation is a task with a recorded state — created, planning, awaiting approval, executing, verifying, and a terminal completed, rejected, blocked or failed. Refreshing or leaving the page never loses it.",
    state: "ready",
    source: "src/lib/engine/engine.ts",
  },
  {
    id: "planning",
    name: "Specialist planning and execution",
    detail:
      "A Mind declares its plan steps with a cost ceiling; the shared executor runs them in order and records each result, spend entry and failure.",
    state: "ready",
    source: "src/lib/engine/engine.ts",
  },
  {
    id: "routing",
    name: "Miner and intent routing",
    detail:
      "Telegraph intents are discovered at runtime and priced with an unpaid probe. A Mind pins the miner it trusts and refuses to sign if the live offer has drifted.",
    state: "ready",
    source: "src/lib/telegraph/client.ts",
  },
  {
    id: "evidence",
    name: "Evidence and source verification",
    detail:
      "Signal hashes, receipts and committed payloads are recorded and independently re-derived; a claim without evidence is reported as unverified, never smoothed over.",
    state: "ready",
    source: "src/lib/telegraph/verify.ts",
  },
  {
    id: "spending",
    name: "Approval and controlled spending",
    detail:
      "Paid work requires an operator session, a spend ceiling and a human approval of the exact plan. Each ask runs once; a bare refusal after signing is terminal.",
    state: "ready",
    source: "src/lib/api/auth.ts",
  },
  {
    id: "findings",
    name: "Structured findings and gaps",
    detail:
      "Reports carry structured findings, a confidence level and an explicit missing-dimension ledger. What the network cannot answer stays listed as a gap.",
    state: "ready",
    source: "src/lib/indexdesk/report.ts",
  },
  {
    id: "history",
    name: "Persistent investigation history",
    detail:
      "The task store retains every investigation, and Activity lists completed work with its spend and evidence at the caller's clearance.",
    state: "ready",
    source: "src/lib/engine/store.ts",
  },
  {
    id: "monitoring",
    name: "Monitoring and follow-up",
    detail:
      "Protocol Watch already schedules source checks and re-runs within a budget. Per-Mind schedules, alert routing and follow-up investigations are not built yet.",
    state: "partial",
    source: "src/lib/watch/scheduler.ts",
  },
];

/** The run every Mind follows, from scope to follow-up. */
export interface MindPipelineStage {
  id: string;
  name: string;
  detail: string;
  state: FoundationState;
}

export const MIND_PIPELINE: MindPipelineStage[] = [
  { id: "define", name: "Define", detail: "The user declares the scope, universe or subject and any methodology.", state: "ready" },
  { id: "probe", name: "Probe", detail: "Unpaid validation and live pricing for every dimension the Mind can ask.", state: "ready" },
  { id: "approve", name: "Approve", detail: "The exact plan and cost ceiling wait for an operator decision.", state: "ready" },
  { id: "ask", name: "Ask", detail: "One drift-checked paid ask per dimension, bounded by the approved budget.", state: "ready" },
  { id: "verify", name: "Verify", detail: "Signal hashes and receipts are checked against the recorded payload.", state: "ready" },
  { id: "report", name: "Report", detail: "Structured findings, exclusions and the missing-dimension ledger.", state: "ready" },
  { id: "monitor", name: "Monitor", detail: "Scheduled re-checks and follow-up investigations for live work.", state: "partial" },
];
