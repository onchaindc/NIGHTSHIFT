import { NextRequest, NextResponse, after } from "next/server";

import { paidRunGate, type PaidRunGate, requestedSpendCeilingCents } from "@/lib/api/userSpend";
import { tasksForCaller } from "@/lib/api/public";
import { listTasks } from "@/lib/engine/store";
import { createTask, defaultDeps, reapIfStalled, runTask, EngineError } from "@/lib/engine/engine";
import type { TaskRecord } from "@/lib/engine/types";
import { mindBySlug } from "@/lib/minds/registry";
import { CAPABILITIES, READINESS_LABEL, readinessFor } from "@/lib/minds/capabilities";
import { CapabilityPlanError, capabilityRunInputs, planCapabilityRun } from "@/lib/minds/capability-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/minds/:slug/investigate
 *
 * A generic capability run over the verified matrix. Every supported
 * dimension needs its real inputs; unsupported dimensions are never planned.
 *
 *   mode "free"  — probes each dimension (canonical schema + live price),
 *                  records the gap ledger and returns a readiness report.
 *                  No payment path exists and nothing is signed.
 *   mode "intel" — the same baseline, then paid asks per routable dimension
 *                  after the human approval gate: each ask runs its pinned
 *                  route first and a failed route is re-routed once through
 *                  the node's router, always inside the approved ceiling.
 *                  Requires the operator bearer token and waits for approval.
 *
 * This is an API path, not a launch button: Minds without an executor remain
 * "in development" in the catalogue and no profile claims otherwise.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const mind = mindBySlug(slug);
  if (!mind) return NextResponse.json({ error: "unknown Mind" }, { status: 404 });
  if (!CAPABILITIES[slug]) return NextResponse.json({ error: "no capability matrix for this Mind" }, { status: 404 });

  let body: { inputs?: unknown; mode?: unknown; spendLimitUsdCents?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const mode = body.mode === "free" ? "free" : "intel";
  if (body.mode !== undefined && body.mode !== "free" && body.mode !== "intel") {
    return NextResponse.json({ error: 'mode must be "free" or "intel"' }, { status: 400 });
  }
  // Wallet authority for the paid path, hoisted so the create call can stamp
  // ownership; free mode never spends and gets a synthetic allow.
  const gate =
    mode === "intel"
      ? await paidRunGate(req, "intel runs on this Mind")
      : ({ kind: "allow", operator: true, userAddress: null } as PaidRunGate);
  if (gate.kind === "deny") return NextResponse.json({ error: gate.error }, { status: gate.status });

  const inputs = (body.inputs ?? {}) as Record<string, Record<string, unknown>>;
  const spendLimitUsdCents =
    typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
      ? Math.round(body.spendLimitUsdCents)
      : undefined;

  let planned;
  try {
    planned = planCapabilityRun(slug, inputs, mode, spendLimitUsdCents);
  } catch (err) {
    if (err instanceof CapabilityPlanError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  try {
    const task = await createTask({
      goal: `Capability run · ${mind.name} · ${planned.requiredInputs.length} supported dimensions · ${mode}`,
      spendLimitUsdCents: spendLimitUsdCents ?? planned.budgetCeilingUsdCents,
      requiresApproval: mode === "intel",
      origin: { source: "web" },
      ...(gate.operator ? {} : gate.userAddress ? { owner: gate.userAddress } : {}),
      jobType: "capability_run",
      plan: planned.steps,
      criteria: planned.criteria,
      assumptions: [
        "the capability matrix is the plan: unsupported dimensions are excluded and reported as gaps, never asked through a loosely related intent",
        "a verified route means the canonical schema, pinned provider and price were accepted by the node; it is not a purchased answer",
        mode === "intel"
          ? "no ask is signed before the operator approves this exact plan; each ask runs its pinned route first and a failed route is re-routed once through the node's router, always inside the approved ceiling"
          : "free mode plans no purchase and can spend nothing by construction",
      ],
    });

    if (task.state === "executing") {
      after(async () => {
        try {
          await runTask(task.id, defaultDeps());
        } catch (err) {
          console.error("background capability run failed:", err);
        }
      });
      return NextResponse.json({ task, accepted: true, poll: `/api/tasks/${task.id}` }, { status: 202 });
    }
    return NextResponse.json(
      {
        task,
        poll: `/api/tasks/${task.id}`,
        note: "awaiting_approval: paid capability asks start only after POST /api/tasks/:id/action {action:'approve'}",
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function runMindOf(task: TaskRecord): string | null {
  const target = task.plan?.find((s) => s.kind === "capability_baseline")?.target;
  if (!target) return null;
  try {
    const parsed = JSON.parse(target) as { slug?: unknown };
    return typeof parsed.slug === "string" ? parsed.slug : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const mind = mindBySlug(slug);
  if (!mind) return NextResponse.json({ error: "unknown Mind" }, { status: 404 });

  let tasks;
  try {
    tasks = await listTasks();
    // Interrupted runs are failed on read instead of showing "executing" forever.
    tasks = await Promise.all(tasks.map((t) => reapIfStalled(t, Date.now())));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
  const runs = tasks.filter((t) => t.jobType === "capability_run" && runMindOf(t) === slug);
  const view = tasksForCaller(req, runs);

  return NextResponse.json({
    tool: `nightshift.${slug}.capability-run`,
    mind: { slug, name: mind.name, status: mind.status, readiness: readinessFor(slug, mind.status) },
    readiness: READINESS_LABEL[readinessFor(slug, mind.status)],
    modes: ["free", "intel"],
    inputs: capabilityRunInputs(slug),
    investigations: view.tasks,
    redacted: view.redacted,
    note: "Free runs are open. Intel runs require the operator token and the engine approval gate. A profile is not marked operational just because its routes are verified.",
  });
}
