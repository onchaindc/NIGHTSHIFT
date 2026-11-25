import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/engine/store";
import { reapIfStalled } from "@/lib/engine/engine";
import { taskForCaller } from "@/lib/api/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/:id - one task record at the caller's clearance: full (with
 * the event timeline) for the operator (bearer token or /api/session cookie),
 * the discovery-level public projection for anonymous callers. 404 when the
 * id is unknown (never a fabricated task). A task whose run was interrupted
 * (no progress past the stall window) is failed here rather than shown as
 * forever "executing".
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const stored = await getTask(id);
  if (!stored) return NextResponse.json({ error: `task ${id} not found` }, { status: 404 });
  const task = await reapIfStalled(stored, Date.now());
  const view = taskForCaller(req, task);
  return NextResponse.json({ task: view.task, redacted: view.redacted });
}
