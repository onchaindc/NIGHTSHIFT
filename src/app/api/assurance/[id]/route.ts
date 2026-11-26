import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { investigationForCaller } from "@/lib/api/public";
import { getTask } from "@/lib/engine/store";
import { spendSummary } from "@/lib/assurance/run";
import { getInvestigation } from "@/lib/assurance/store";
import { mindsBuilderAlias } from "@/lib/mind/builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/assurance/:id — the whole file, its runs and its live spend. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const inv = await getInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });

  const visible = investigationForCaller(req, inv);
  if (!visible) {
    return NextResponse.json(
      { error: "not found" },
      // Live files belonging to another wallet are indistinguishable from
      // absent ones: no confirmation that the id exists leaks through.
      { status: 404 },
    );
  }

  const identity = callerIdentity(req);
  const tasks = (await Promise.all(inv.intelligenceRuns.map((r) => getTask(r.taskId)))).filter(
    (t): t is NonNullable<typeof t> => Boolean(t),
  );
  const spend = spendSummary(inv, tasks);

  // The wallet that owns this file can act on it; the operator can act on
  // everything; anonymous demonstration readers are read-only.
  const canAct =
    identity.kind === "operator" ||
    (identity.kind === "user" && inv.owner?.toLowerCase() === identity.address);

  return NextResponse.json({
    readOnly: !canAct,
    investigation: visible.inv,
    runs: inv.intelligenceRuns.map((run) => {
      const task = tasks.find((t) => t.id === run.taskId);
      const ownedRun = canAct || (identity.kind === "user" && task?.owner?.toLowerCase() === identity.address);
      return {
        ...run,
        taskState: task?.state ?? run.taskState,
        taskError: identity.kind === "anonymous" ? null : task?.error ?? null,
        canApprove: Boolean(ownedRun && task?.state === "awaiting_approval"),
        spendUsdCents: task?.spend.spentUsdCents ?? 0,
      };
    }),
    spend,
    orchestration: {
      planner: "deterministic",
      mindConnected: Boolean(process.env.MINDS_BUILDER_API_KEY && mindsBuilderAlias()),
      note: "Investigation planning and execution are deterministic. A connected Minds alias receives the completed report when configured; it does not plan, price or execute this investigation.",
    },
  });
}
