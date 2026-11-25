import { NextRequest, NextResponse, after } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { tasksForCaller } from "@/lib/api/public";
import { listTasks } from "@/lib/engine/store";
import { createTask, defaultDeps, runTask } from "@/lib/engine/engine";
import type { TaskRecord } from "@/lib/engine/types";
import { mindBySlug } from "@/lib/minds/registry";
import { CAPABILITIES, readinessFor } from "@/lib/minds/capabilities";
import {
  BitcoinInputError,
  BITCOIN_MINING_SLUG,
  fetchLatestBlockHeight,
  planBitcoinMining,
  validateBitcoinObjective,
  type BitcoinMiningObjective,
} from "@/lib/bitcoinmining/intel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function objectiveOf(task: TaskRecord): BitcoinMiningObjective | null {
  const target = task.plan?.find((s) => s.kind === "capability_baseline")?.target;
  if (!target) return null;
  try {
    const parsed = JSON.parse(target) as { inputs?: Record<string, Record<string, unknown>> };
    const height = parsed.inputs?.hashprice_network?.block_height;
    const zone = parsed.inputs?.energy_price?.node_or_zone;
    const intervalStart = parsed.inputs?.energy_price?.interval_start;
    if (typeof height !== "number" || typeof zone !== "string" || typeof intervalStart !== "string") return null;
    return { blockHeight: height, zone, intervalStart };
  } catch {
    return null;
  }
}

/**
 * POST /api/mind/bitcoin-mining
 *
 * The product entry point for NIGHTSHIFT's first operational specialist Mind.
 * It accepts an objective (block, ERCOT zone, settlement interval), resolves a
 * current block when none is supplied, and creates the same capability_run the
 * shared engine already knows:
 *
 *   free  — three unpaid probes, plan/price evidence, no findings;
 *   intel — same probes, then one paid ask per dimension after operator
 *           approval, a $0.03 hard ceiling, signal verification and a
 *           deterministic mining-economics report.
 *
 * Pool concentration and fleet uptime are not inputs and never become asks.
 */
export async function POST(req: NextRequest) {
  let body: {
    blockHeight?: unknown;
    zone?: unknown;
    intervalStart?: unknown;
    mode?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const mode = body.mode === "free" ? "free" : body.mode === "intel" || body.mode === undefined ? "intel" : null;
  if (!mode) return NextResponse.json({ error: 'mode must be "free" or "intel"' }, { status: 400 });
  if (mode === "intel" && !requestAuthorized(req)) {
    return NextResponse.json(
      {
        error:
          'authorization required: a paid mining run can spend money, so it needs the operator session or bearer token; mode "free" stays open',
      },
      { status: 401 },
    );
  }

  let blockHeight = body.blockHeight;
  if (blockHeight === undefined || blockHeight === null || blockHeight === "") {
    try {
      blockHeight = await fetchLatestBlockHeight();
    } catch (err) {
      return NextResponse.json(
        {
          error: `${err instanceof Error ? err.message : "latest block lookup failed"}; supply blockHeight explicitly`,
        },
        { status: 503 },
      );
    }
  }

  let objective: BitcoinMiningObjective;
  let planned;
  try {
    objective = validateBitcoinObjective({
      blockHeight,
      zone: body.zone,
      intervalStart: body.intervalStart,
    });
    planned = planBitcoinMining(objective, mode);
  } catch (err) {
    if (err instanceof BitcoinInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  try {
    const task = await createTask({
      goal: `Bitcoin mining intelligence · block ${objective.blockHeight} · ${objective.zone} · ${objective.intervalStart} · ${mode}`,
      spendLimitUsdCents: planned.budgetCeilingUsdCents,
      requiresApproval: mode === "intel",
      origin: { source: "web" },
      jobType: "capability_run",
      plan: planned.steps,
      criteria: planned.criteria,
      assumptions: [
        `the objective is block ${objective.blockHeight}, ${objective.zone}, settlement interval ${objective.intervalStart}`,
        "exactly three verified dimensions are planned: hashprice/hashrate, BTC spot price and ERCOT LMP; pool concentration and fleet uptime are excluded gaps",
        "the hashprice provider returns sats but no USD rate; the report derives USD from the separately committed BTC price and labels the derivation",
        mode === "intel"
          ? "no ask is signed before the operator approves this exact plan; one attempt per dimension under a $0.03 ceiling"
          : "free mode plans no purchase and can spend nothing by construction",
      ],
    });

    if (task.state === "executing") {
      after(async () => {
        try {
          await runTask(task.id, defaultDeps());
        } catch (err) {
          console.error("background bitcoin mining run failed:", err);
        }
      });
      return NextResponse.json({ task, objective, accepted: true, poll: `/api/tasks/${task.id}` }, { status: 202 });
    }
    return NextResponse.json(
      {
        task,
        objective,
        poll: `/api/tasks/${task.id}`,
        note: "awaiting_approval: paid mining asks start only after POST /api/tasks/:id/action {action:'approve'}",
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const mind = mindBySlug(BITCOIN_MINING_SLUG);
  if (!mind) return NextResponse.json({ error: "Mind is not registered" }, { status: 404 });
  const caps = CAPABILITIES[BITCOIN_MINING_SLUG];

  let tasks;
  try {
    tasks = await listTasks();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
  const runs = tasks.filter(
    (t) => t.jobType === "capability_run" && objectiveOf(t) !== null && t.goal.startsWith("Bitcoin mining intelligence"),
  );
  const view = tasksForCaller(req, runs);

  return NextResponse.json({
    tool: "nightshift.bitcoin-mining",
    mind: { slug: mind.slug, name: mind.name, status: mind.status, readiness: readinessFor(mind.slug, mind.status) },
    modes: ["free", "intel"],
    objective: {
      blockHeight: "integer; omit for the current mempool.space tip",
      zone: "ERCOT hub or load zone, e.g. HB_WEST",
      intervalStart: "RFC 3339 timestamp with timezone",
    },
    dimensions: caps?.dimensions ?? [],
    budgetCeilingUsdCents: caps?.plan.budgetCeilingUsdCents ?? 3,
    approvalGate: caps?.plan.approvalGate,
    investigations: view.tasks,
    redacted: view.redacted,
    note: "Free runs are open and never sign. Paid runs require the operator session and the engine approval gate. Gaps are never asked.",
  });
}
