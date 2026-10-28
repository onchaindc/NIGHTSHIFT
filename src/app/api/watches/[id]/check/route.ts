import { NextRequest, NextResponse } from "next/server";
import { createTask, runTask, EngineError } from "@/lib/engine/engine";
import { getWatch } from "@/lib/watch/store";
import { planWatchSteps } from "@/lib/watch/execute";
import { WATCH_CRITERIA } from "@/lib/watch/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/watches/:id/check - run ONE real check now.
 * Body: { investigate?: boolean }
 *  - investigate=false (default): free source read + fingerprint diff; never
 *    spends, delivers nothing paid, records a completed run.
 *  - investigate=true: the plan adds a Telegraph insight step bounded by the
 *    watch's per-run ceiling. If the watch requires approval for paid steps,
 *    the task is returned in awaiting_approval and NOT executed until the
 *    user approves through the existing approval flow.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const watch = await getWatch(id);
  if (!watch) return NextResponse.json({ error: "watch not found" }, { status: 404 });

  let investigate = false;
  try {
    const body = (await req.json()) as { investigate?: unknown } | null;
    investigate = body?.investigate === true;
  } catch {
    investigate = false;
  }

  try {
    const task = await createTask({
      goal: `Protocol Watch check: ${watch.name} (${watch.protocol})`,
      spendLimitUsdCents: watch.spendLimitUsdCents,
      requiresApproval: investigate && watch.requiresApprovalForPaid,
      origin: { source: "web" },
      jobType: "protocol_watch",
      watch: {
        watchId: watch.id,
        watchName: watch.name,
        triggeredBy: "manual",
        telegramChatId: watch.telegramChatId ?? null,
      },
      plan: planWatchSteps(watch, investigate),
      criteria: WATCH_CRITERIA,
    });
    if (task.state === "executing") {
      const done = await runTask(task.id);
      return NextResponse.json({ task: done }, { status: 201 });
    }
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
