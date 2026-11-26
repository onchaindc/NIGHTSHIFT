import { NextRequest, NextResponse, after } from "next/server";
import { approveTask, rejectTask, defaultDeps } from "@/lib/engine/engine";
import { getTask } from "@/lib/engine/store";
import { callerIdentity } from "@/lib/api/auth";

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
 * Identity: the deployment operator (bearer token or session cookie), or the
 * task's OWNER — the signed-in wallet user who created the task. Ownership IS
 * the human-in-the-loop here: a user approving their own task releases paid
 * steps from THEIR allowance, which is exactly the multi-user production
 * model. Anonymous callers and non-owners are refused.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = callerIdentity(req);
  if (identity.kind === "anonymous") {
    return NextResponse.json(
      { error: "sign in with your wallet to approve or reject runs; the task's owner or the operator can act" },
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

  // A signed-in user may only act on tasks they own; tasks with NO owner were
  // created by the operator or an agent handoff and are operator-only.
  if (identity.kind === "user" && (existing.owner ?? "").toLowerCase() !== identity.address) {
    const reason = existing.owner
      ? "this task belongs to a different wallet — only its owner or the operator can act on it"
      : "this run has no wallet owner (created by the operator or an agent handoff) — only the operator can act on it";
    return NextResponse.json({ error: reason }, { status: 403 });
  }

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
