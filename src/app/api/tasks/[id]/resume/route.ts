/**
 * Resume/checkpoint wiring for interrupted runs.
 *
 * A run interrupted mid-plan (dead execution window, node outage) is failed
 * honestly by the stall reaper, but "re-run" used to mean starting over —
 * re-paying for steps that had already settled. The engine checkpoints each
 * completed step (progress.completedSteps + a serialized outputs snapshot);
 * this route builds a continuation task from that checkpoint: the completed
 * prefix is skipped, the remaining budget carries forward, and the run
 * proceeds through the exact same engine path as any other run.
 *
 * Identity: the deployment operator or the task's OWNER (the wallet that
 * created it). Anonymous callers and non-owners are refused.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { buildResumedTask, runTask, defaultDeps, EngineError } from "@/lib/engine/engine";
import { getTask } from "@/lib/engine/store";
import { callerIdentity } from "@/lib/api/auth";
import { taskForCaller } from "@/lib/api/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const identity = callerIdentity(req);
  if (identity.kind === "anonymous") {
    return NextResponse.json(
      { error: "sign in with your wallet to resume runs; the task's owner or the operator can resume" },
      { status: 401 },
    );
  }
  const prior = await getTask(id);
  if (!prior) return NextResponse.json({ error: `task ${id} not found` }, { status: 404 });
  if (identity.kind === "user" && (prior.owner ?? "").toLowerCase() !== identity.address) {
    return NextResponse.json({ error: "only the task's owner or the operator can resume this run" }, { status: 403 });
  }
  try {
    const cont = await buildResumedTask(id);
    after(async () => {
      try {
        await runTask(cont.id, defaultDeps());
      } catch (err) {
        console.error(`resumed run ${cont.id} failed:`, err);
      }
    });
    const view = taskForCaller(req, cont);
    return NextResponse.json({ task: view.task, redacted: view.redacted, resumedFrom: id });
  } catch (err) {
    if (err instanceof EngineError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
