import { NextRequest, NextResponse, after } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { listTasks } from "@/lib/engine/store";
import { createTask, runTask, EngineError, defaultDeps } from "@/lib/engine/engine";
import { planMindInvestigation } from "@/lib/mind/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Mind's investigation tool — the externally reachable HTTP capability a
 * Minds agent (or any operator) calls with an investigation objective.
 *
 * POST /api/mind/investigations  { objective, mode?, spendLimitUsdCents? }
 *   mode "intel" (default): plan = free baseline → PAID specialist ask
 *   (Telegraph/Counterparty, one attempt, drift-checked) → reasoned report
 *   with the with/without-Telegraph comparison. Human approval is REQUIRED
 *   before anything is signed; the caller polls /api/tasks/:id for the report.
 *   mode "free": no purchase path is planned at all.
 *
 * Free investigations spend nothing and stay public. Intel investigations can
 * spend, so they are gated by the operator token (NIGHTSHIFT_API_TOKEN) and
 * always wait at the human approval gate; reads stay public.
 */
export async function POST(req: NextRequest) {
  let body: { objective?: unknown; mode?: unknown; spendLimitUsdCents?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!objective) return NextResponse.json({ error: "objective is required" }, { status: 400 });
  const mode = body.mode === "free" ? "free" : body.mode === "intel" ? "intel" : "intel";
  if (body.mode !== undefined && body.mode !== "free" && body.mode !== "intel") {
    return NextResponse.json({ error: 'mode must be "free" or "intel"' }, { status: 400 });
  }
  // Only the paid mode is privileged: free investigations never plan a
  // purchase, so they stay usable without the operator token.
  if (mode !== "free" && !requestAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: intel investigations can spend money, so they are gated behind a bearer token (NIGHTSHIFT_API_TOKEN); mode \"free\" stays open" },
      { status: 401 },
    );
  }

  const spendLimitUsdCents =
    typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
      ? Math.round(body.spendLimitUsdCents)
      : undefined;

  const planned = planMindInvestigation(objective, mode);
  if (planned.blocker || planned.steps.length === 0) {
    return NextResponse.json(
      { error: planned.blocker ?? "the objective produced no investigation plan", assumptions: planned.assumptions },
      { status: 422 },
    );
  }

  try {
    const task = await createTask({
      goal: objective,
      spendLimitUsdCents,
      // Human approval for paid actions is the product invariant: an intel
      // investigation always waits at the approval gate and cannot waive it
      // (free mode never spends, so it does not need the gate).
      requiresApproval: mode === "intel",
      origin: { source: "web" },
      jobType: "mind_investigation",
      plan: planned.steps,
      criteria: planned.criteria,
      assumptions: planned.assumptions,
    });
    if (task.state === "executing") {
      after(async () => {
        try {
          await runTask(task.id, defaultDeps());
        } catch (err) {
          console.error("background mind investigation failed:", err);
        }
      });
      return NextResponse.json({ task, accepted: true, poll: `/api/tasks/${task.id}` }, { status: 202 });
    }
    return NextResponse.json(
      { task, poll: `/api/tasks/${task.id}`, note: "awaiting_approval: the paid specialist step starts only after POST /api/tasks/:id/action {action:'approve'}" },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  let tasks;
  try {
    tasks = await listTasks();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
  const investigations = tasks.filter((t) => t.jobType === "mind_investigation");
  return NextResponse.json({ investigations, tool: "nightshift.investigation", modes: ["free", "intel"] });
}
