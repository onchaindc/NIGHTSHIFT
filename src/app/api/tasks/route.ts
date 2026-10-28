import { NextRequest, NextResponse } from "next/server";
import { createTask, runTask, EngineError } from "@/lib/engine/engine";
import { listTasks } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks - all tasks with their events (the UI renders these directly).
 * POST /api/tasks - submit a goal. Runs to completion synchronously in the
 * request; purchases are bounded by the task's spending limit.
 */
export async function GET() {
  const tasks = await listTasks();
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  let body: { goal?: unknown; spendLimitUsdCents?: unknown; requiresApproval?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) return NextResponse.json({ error: "goal is required" }, { status: 400 });

  const spendLimitUsdCents =
    typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
      ? Math.round(body.spendLimitUsdCents)
      : undefined;

  const requiresApproval = body.requiresApproval === true;

  try {
    let task = await createTask({
      goal,
      spendLimitUsdCents,
      requiresApproval,
      origin: { source: "web" },
    });
    if (task.state === "executing") {
      task = await runTask(task.id);
    }
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
