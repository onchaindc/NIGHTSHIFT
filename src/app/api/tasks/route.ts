import { NextRequest, NextResponse, after } from "next/server";
import { createTask, reapIfStalled, runTask, EngineError } from "@/lib/engine/engine";
import { listTasks } from "@/lib/engine/store";
import { requestAuthorized } from "@/lib/api/auth";
import { tasksForCaller } from "@/lib/api/public";
import { BUILD_MARKER } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Operations run to completion in the background (see after() below); on
// Vercel the function keeps executing up to this duration limit.
export const maxDuration = 300;

/**
 * GET /api/tasks - task records for the caller's clearance. The operator
 * (bearer token or /api/session cookie) gets full records with events; an
 * anonymous caller gets the discovery-level public projection only: no
 * objectives, plans, timelines, reports, evidence or spend-ledger entries.
 * POST /api/tasks - submit a goal. Free goals stay public; any mode that can
 * plan a purchase requires the operator (bearer token or session cookie) and
 * ALWAYS stops at the human approval gate (the caller cannot waive it).
 */
export async function GET(req: Request) {
  let tasks;
  try {
    tasks = await listTasks();
    // Interrupted runs are failed on read instead of showing "executing" forever.
    tasks = await Promise.all(tasks.map((t) => reapIfStalled(t, Date.now())));
  } catch (err) {
    // Storage unreachable (e.g. the configured database is down): report the
    // unavailable state explicitly instead of an opaque server error, so the
    // UI can say "could not be read" rather than presenting anything as history.
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
  return NextResponse.json({ build: BUILD_MARKER, ...tasksForCaller(req, tasks) });
}

export async function POST(req: NextRequest) {
  let body: { goal?: unknown; spendLimitUsdCents?: unknown; mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) return NextResponse.json({ error: "goal is required" }, { status: 400 });

  // How this operation may answer. A free request can NEVER become a paid
  // operation (the planner refuses instead), and a paid request is always
  // labeled with its ceiling before anything runs.
  const mode = body.mode === "free" || body.mode === "paid" || body.mode === "auto" ? body.mode : "auto";

  const spendLimitUsdCents =
    typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
      ? Math.round(body.spendLimitUsdCents)
      : undefined;

  // A free goal can never become a purchase, so it stays open. "auto" and
  // "paid" can plan paid steps and are operator-gated. Approval is never the
  // caller's decision: anything that can spend waits for a human.
  const isFree = mode === "free";
  if (!isFree && !requestAuthorized(req)) {
    return NextResponse.json(
      {
        error:
          'authorization required: goals that can spend are gated behind a bearer token (NIGHTSHIFT_API_TOKEN); mode "free" stays open',
      },
      { status: 401 },
    );
  }

  try {
    const task = await createTask({
      goal,
      spendLimitUsdCents,
      requiresApproval: !isFree,
      origin: { source: "web" },
      mode,
    });
    if (task.state === "executing") {
      // Execution (possibly paid steps with retries and chain reads) must not
      // bind the HTTP request: serverless runtimes cut request-bound work at
      // the function duration limit, which aborted operations mid-flight. The
      // task record persists state as it goes; clients poll /api/tasks for it.
      after(async () => {
        try {
          await runTask(task.id);
        } catch (err) {
          console.error("background task run failed:", err);
        }
      });
      return NextResponse.json({ task, accepted: true }, { status: 202 });
    }
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
