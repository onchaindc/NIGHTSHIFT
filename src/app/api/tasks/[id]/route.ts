import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/:id - one task with its full event timeline, the record the
 * detail view renders. 404 when the id is unknown (never a fabricated task).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: `task ${id} not found` }, { status: 404 });
  return NextResponse.json({ task });
}
