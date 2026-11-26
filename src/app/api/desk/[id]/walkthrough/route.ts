import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { getDeskInvestigation } from "@/lib/desk/store";
import { getTask } from "@/lib/engine/store";
import { buildDeskWalkthrough } from "@/lib/desk/walkthrough";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desk/:id/walkthrough — the reproducible demonstration narrative of
 * how this file actually ran: inputs, budget approval, the paid Telegraph
 * requests, provider responses and receipts, independent verification
 * (failures named as such), discrepancies and missing evidence, and the final
 * assessment. Everything is read back from the stored investigation and its
 * run tasks — nothing is fabricated, nothing is re-run, no funds are spent.
 * Owner- or operator-readable only, like the file itself.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const inv = await getDeskInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });

  const identity = callerIdentity(req);
  const visible =
    identity.kind === "operator" ||
    (identity.kind === "user" && inv.owner?.toLowerCase() === identity.address);
  if (!visible) {
    return NextResponse.json(
      { error: identity.kind === "anonymous" ? "sign in with your wallet to read this file" : "this file belongs to another wallet" },
      { status: identity.kind === "anonymous" ? 404 : 403 },
    );
  }

  const tasks = (await Promise.all(inv.runs.map((run) => getTask(run.taskId)))).filter((t) => t !== null);
  return NextResponse.json({ walkthrough: buildDeskWalkthrough(inv, tasks) });
}
