import { NextRequest, NextResponse, after } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { tasksForCaller } from "@/lib/api/public";
import { listTasks } from "@/lib/engine/store";
import { createTask, runTask, EngineError, defaultDeps } from "@/lib/engine/engine";
import { planIndexDesk, MAX_ASKS_PER_ASSET, INDEX_ASK_PRICE_USD_CENTS } from "@/lib/indexdesk/plan";
import { validateIndexDefinition } from "@/lib/indexdesk/intel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Index Reconstitution Desk — the first specialist Mind over the
 * network's market-data intents.
 *
 * POST /api/mind/index-desk  { index: {...}, mode?, spendLimitUsdCents? }
 *   The user declares the index universe and its methodology (verbatim, never
 *   second-guessed); the desk probes every askable dimension of every asset
 *   for free (live pricing), then — only after the human approval gate — pays
 *   one drift-checked ask per asset per challenged dimension, and closes with
 *   a deterministic constituent/weighting proposal, per-asset evidence and
 *   the missing-dimension ledger.
 *
 *   mode "intel" (default) plans the paid step and requires the operator
 *   token (NIGHTSHIFT_API_TOKEN) plus the engine's approval gate.
 *   mode "free" plans no purchase at all and stays open.
 *
 * Reads return the tool descriptor (verified coverage) to everyone; the
 * investigation records are full for the operator and discovery-level public
 * projections for anonymous callers — objectives, proposals, evidence and
 * spend-ledger entries never cross that gate anonymously.
 */
export async function POST(req: NextRequest) {
  let body: { index?: unknown; mode?: unknown; spendLimitUsdCents?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const valid = validateIndexDefinition(body.index);
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });
  const definition = valid.definition;

  const mode = body.mode === "free" ? "free" : "intel";
  if (body.mode !== undefined && body.mode !== "free" && body.mode !== "intel") {
    return NextResponse.json({ error: 'mode must be "free" or "intel"' }, { status: 400 });
  }
  // Only the paid mode is privileged: free investigations never plan a
  // purchase, so they stay usable without the operator token.
  if (mode !== "free" && !requestAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: intel index desks can spend money, so they are gated behind a bearer token (NIGHTSHIFT_API_TOKEN); mode \"free\" stays open" },
      { status: 401 },
    );
  }

  const spendLimitUsdCents =
    typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
      ? Math.round(body.spendLimitUsdCents)
      : undefined;

  const planned = planIndexDesk(definition, mode);
  const goal = `Reconstitute index "${definition.name}" (${definition.methodology.scheme}) over ${definition.assets.length} assets: ${definition.assets.map((a) => a.symbol).join(", ")}`;

  try {
    const task = await createTask({
      goal,
      spendLimitUsdCents,
      // Human approval for paid actions is the product invariant: an intel
      // desk always waits at the approval gate and cannot waive it.
      requiresApproval: mode === "intel",
      origin: { source: "web" },
      jobType: "index_desk",
      plan: planned.steps,
      criteria: planned.criteria,
      assumptions: [
        "the index universe and methodology are taken verbatim from the caller; the desk never adds, drops or re-weights an asset outside its stated rules",
        "declared supply/price/volume figures are user inputs, provenance-labelled in the proposal and never presented as network-verified",
      ],
    });
    if (task.state === "executing") {
      after(async () => {
        try {
          await runTask(task.id, defaultDeps());
        } catch (err) {
          console.error("background index desk failed:", err);
        }
      });
      return NextResponse.json({ task, accepted: true, poll: `/api/tasks/${task.id}` }, { status: 202 });
    }
    return NextResponse.json(
      { task, poll: `/api/tasks/${task.id}`, note: "awaiting_approval: the paid data asks start only after POST /api/tasks/:id/action {action:'approve'}" },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  let tasks;
  try {
    tasks = await listTasks();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
  const desks = tasks.filter((t) => t.jobType === "index_desk");
  const view = tasksForCaller(req, desks);
  return NextResponse.json({
    investigations: view.tasks,
    redacted: view.redacted,
    tool: "nightshift.index-desk",
    modes: ["free", "intel"],
    maxAsksPerAsset: MAX_ASKS_PER_ASSET,
    verifiedCoverage: {
      note: "every intent/miner below was probed live (unpaid) and its schema read from the node before integration; see telegraph_audit_data/index_desk_probes",
      askPriceUsdCents: INDEX_ASK_PRICE_USD_CENTS,
      dimensions: {
        registry: { intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL", miner: "zk-corp-atlas", params: { company: "issuer legal name", jurisdiction: "ISO code (required by the schema)" } },
        price: { intent: "CRYPTO_PRICE_USD", miner: "cp-coinbase", params: { symbol: "asset symbol" } },
        supply: { intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", miner: "verifywire-token-total-supply", params: { token: "symbol or contract address" } },
        liquidity: { intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL", miner: "verifywire-liquidity-depth", params: { pool: "DEX pool address or name", chain: "chain" }, requires: "declared pool" },
        holders: { intent: "TOKEN_HOLDER_COUNT_GENERAL", miner: "router (no pin)", params: { token: "symbol or contract address", chain: "chain" } },
        filings: { intent: "REGULATORY_FILING_MONITOR_GENERAL", miner: "verireceipt", params: { entity: "issuer legal name", period: "last 12 months" } },
      },
      notCovered: [
        "circulating float / locked supply (no network intent; declared-only input)",
        "trading volumes / execution quality (no network intent; declared-only input)",
      ],
    },
  });
}
