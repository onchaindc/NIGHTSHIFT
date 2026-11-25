import { NextRequest, NextResponse, after } from "next/server";
import { approveTask, rejectTask, defaultDeps } from "@/lib/engine/engine";
import { getTask } from "@/lib/engine/store";
import { requestAuthorized } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Approving an execution plan may include paid steps and chain reads; run it
// in the background like every execution path (see /api/tasks POST).
export const maxDuration = 300;

/**
 * POST /api/tasks/:id/action - { action: "approve" | "reject" }
 * Approve resumes execution (the engine enforces that only a task in
 * awaiting_approval can proceed); reject terminates without any spend.
 *
 * Operator-only: approval is what releases paid steps, so it must never be
 * reachable by an anonymous caller. Accepted identity: the bearer token, or
 * the operator session cookie established at /api/session (same privilege:
 * both require knowing NIGHTSHIFT_API_TOKEN).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!requestAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: approving or rejecting a plan releases paid execution, so it is gated behind the operator token or session" },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;
  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const existing = await getTask(id);
  if (!existing) return NextResponse.json({ error: `task ${id} not found` }, { status: 404 });

  try {
    if (body.action === "approve") {
      // The state transition happens inside approveTask as the plan starts;
      // respond as soon as it is accepted, then keep running in the
      // background. Clients poll the task record for live progress.
      after(async () => {
        try {
          await approveTask(id, defaultDeps());
        } catch (err) {
          console.error("background approval run failed:", err);
        }
      });
      return NextResponse.json({ task: existing, accepted: true }, { status: 202 });
    }
    const task = body.action === "reject" ? await rejectTask(id) : null;
    if (!task) return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
    return NextResponse.json({ task });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
