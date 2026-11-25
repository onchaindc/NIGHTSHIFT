import { NextRequest, NextResponse, after } from "next/server";
import { createTask, reapIfStalled, runTask, EngineError, defaultSpendLimit } from "@/lib/engine/engine";
import { listTasks } from "@/lib/engine/store";
import { requestAuthorized, userAddressFromRequest } from "@/lib/api/auth";
import { tasksForCaller } from "@/lib/api/public";
import { requestedSpendCeilingCents, userPaidSpend24h } from "@/lib/api/userSpend";
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
  // "paid" can plan paid steps: the operator, or ANY signed-in wallet user —
  // multi-user production runs on per-user identity, not a shared secret.
  // User sessions carry a daily spend cap protecting the shared payer wallet;
  // the operator (who funds it) is uncapped.
  const isFree = mode === "free";
  const isOperator = requestAuthorized(req);
  const userAddress = userAddressFromRequest(req);
  if (!isFree && !isOperator && !userAddress) {
    return NextResponse.json(
      {
        error:
          'sign in with your wallet (Settings or the console sign-in) to run goals that can spend; mode "free" stays open to everyone',
      },
      { status: 401 },
    );
  }
  if (!isFree && userAddress && !isOperator) {
    const standing = await userPaidSpend24h(userAddress);
    const ceiling = requestedSpendCeilingCents(spendLimitUsdCents ?? defaultSpendLimit());
    if (!standing.allowsAdditional(ceiling)) {
      return NextResponse.json(
        {
          error: `daily spend cap reached: this wallet has already spent ${(standing.spentCents / 100).toFixed(2)} USD of the ${(standing.capCents / 100).toFixed(2)} USD per-day allowance for payer-funded runs (resets on a rolling 24h window). Free runs stay open.`,
        },
        { status: 403 },
      );
    }
  }

  try {
    const task = await createTask({
      goal,
      spendLimitUsdCents,
      requiresApproval: !isFree,
      origin: { source: "web" },
      mode,
      ...(userAddress && !isOperator ? { owner: userAddress } : {}),
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
