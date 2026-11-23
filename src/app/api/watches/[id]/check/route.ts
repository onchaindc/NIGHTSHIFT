import { NextRequest, NextResponse, after } from "next/server";
import { createTask, runTask, EngineError } from "@/lib/engine/engine";
import { getWatch } from "@/lib/watch/store";
import { planWatchSteps } from "@/lib/watch/execute";
import { WATCH_CRITERIA } from "@/lib/watch/types";
import { requestAuthorized } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A check fetches up to 5 real sources; the run continues in the background
// (after()) so the trigger response is never cut off mid-execution.
export const maxDuration = 60;

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
  // A triggered check can escalate to a paid investigation, so triggering a
  // check is mutating, not reading: it is gated like every watch-management call.
  if (!requestAuthorized(req)) {
    return NextResponse.json({ error: "authorization required: this deployment gates check runs behind a bearer token (NIGHTSHIFT_API_TOKEN)" }, { status: 401 });
  }
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
      after(async () => {
        try {
          await runTask(task.id);
        } catch (err) {
          console.error("background watch check failed:", err);
        }
      });
      return NextResponse.json({ task, accepted: true }, { status: 202 });
    }
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
