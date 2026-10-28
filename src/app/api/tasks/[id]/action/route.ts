import { NextRequest, NextResponse } from "next/server";
import { approveTask, rejectTask, defaultDeps } from "@/lib/engine/engine";
import { getTask } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/:id/action - { action: "approve" | "reject" }
 * Approve resumes execution (the engine enforces that only a task in
 * awaiting_approval can proceed); reject terminates without any spend.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const task =
      body.action === "approve"
        ? await approveTask(id, defaultDeps())
        : body.action === "reject"
          ? await rejectTask(id)
          : null;
    if (!task) return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
    return NextResponse.json({ task });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
