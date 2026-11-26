import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { EngineError } from "@/lib/engine/engine";
import { createAssuranceRun, syncIntelligence } from "@/lib/assurance/run";
import { audit, getInvestigation, saveInvestigation } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/assurance/:id/intelligence
 *   { action: "run", mode: "free" | "intel", spendLimitUsdCents? }
 *   { action: "sync" }
 *
 * A paid run is created as an ordinary engine task and stops at the existing
 * approval gate. Sync absorbs only completed, signal-verified dimensions.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!requestAuthorized(req)) return NextResponse.json({ error: "authorization required" }, { status: 401 });
  const { id } = await ctx.params;
  const inv = await getInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });

  let body: { action?: unknown; mode?: unknown; spendLimitUsdCents?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "sync") {
      const result = await syncIntelligence(inv);
      audit(inv, "operator", "intelligence_synced", `${result.added} evidence record(s) absorbed.`);
      await saveInvestigation(inv);
      return NextResponse.json({ investigation: inv, added: result.added, notes: result.notes });
    }

    const mode = body.mode === "free" ? "free" : "intel";
    if (body.mode !== undefined && body.mode !== "free" && body.mode !== "intel") {
      return NextResponse.json({ error: 'mode must be "free" or "intel"' }, { status: 400 });
    }
    const spendLimitUsdCents =
      typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
        ? Math.round(body.spendLimitUsdCents)
        : inv.spendLimitUsdCents;

    const { task } = await createAssuranceRun(inv, mode, { spendLimitUsdCents, actor: "operator" });
    return NextResponse.json(
      {
        task,
        poll: `/api/tasks/${task.id}`,
        note:
          task.state === "awaiting_approval"
            ? "awaiting_approval: approve the exact plan at POST /api/tasks/:id/action {action:'approve'} before any ask is signed"
            : "free run accepted: probes only, nothing is signed",
      },
      { status: 202 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EngineError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
