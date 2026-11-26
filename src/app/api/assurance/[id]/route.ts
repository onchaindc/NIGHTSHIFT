import { NextRequest, NextResponse } from "next/server";

import { readAuthorized } from "@/lib/api/public";
import { getTask } from "@/lib/engine/store";
import { spendSummary } from "@/lib/assurance/run";
import { getInvestigation } from "@/lib/assurance/store";
import { mindsBuilderAlias } from "@/lib/mind/builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/assurance/:id — the whole file, its runs and its live spend. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authorized = readAuthorized(req);
  const { id } = await ctx.params;
  const inv = await getInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });
  if (!authorized && inv.dataMode !== "demonstration") {
    return NextResponse.json({ error: "authorization required: live assurance files are operator-only" }, { status: 401 });
  }

  const tasks = (await Promise.all(inv.intelligenceRuns.map((r) => getTask(r.taskId)))).filter(
    (t): t is NonNullable<typeof t> => Boolean(t),
  );
  const spend = spendSummary(inv, tasks);

  return NextResponse.json({
    readOnly: !authorized,
    investigation: inv,
    runs: inv.intelligenceRuns.map((run) => {
      const task = tasks.find((t) => t.id === run.taskId);
      return {
        ...run,
        taskState: task?.state ?? run.taskState,
        taskError: task?.error ?? null,
        canApprove: task?.state === "awaiting_approval",
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
