import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { paidRunGate } from "@/lib/api/userSpend";
import { EngineError } from "@/lib/engine/engine";
import { createAssuranceRun, syncIntelligence } from "@/lib/assurance/run";
import { applyAssessment } from "@/lib/assurance/reassess";
import { getInvestigation, saveInvestigation } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/assurance/:id/intelligence
 *   { action: "run", mode: "free" | "intel", spendLimitUsdCents? }
 *   { action: "sync" }
 *
 * Runs belong to the wallet that owns the file. A paid run passes the same
 * shared gate as every Mind (operator, or wallet user under the daily cap)
 * and then stops at the existing approval gate. Sync absorbs only completed,
 * signal-verified dimensions.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = callerIdentity(req);
  const { id } = await ctx.params;
  const inv = await getInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });

  const isOwner =
    identity.kind === "operator" ||
    (identity.kind === "user" && inv.owner?.toLowerCase() === identity.address);
  if (!isOwner) {
    return NextResponse.json(
      { error: identity.kind === "anonymous" ? "sign in with your wallet to run this file's intelligence" : "this file belongs to another wallet" },
      { status: identity.kind === "anonymous" ? 401 : 403 },
    );
  }

  let body: { action?: unknown; mode?: unknown; spendLimitUsdCents?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const actor = identity.kind === "user" ? identity.address : "operator";

  try {
    if (body.action === "sync") {
      const result = await syncIntelligence(inv);
      // Absorbing evidence is only half the job — the recorded decision must
      // follow the ledger in the same request, or the file keeps showing
      // MISSING checks the absorbed answers already satisfied.
      const { assessment } = await applyAssessment(inv, actor);
      await saveInvestigation(inv);
      return NextResponse.json({ investigation: inv, added: result.added, notes: result.notes, outcome: assessment.decision.outcome });
    }

    const mode = body.mode === "free" ? "free" : "intel";
    if (body.mode !== undefined && body.mode !== "free" && body.mode !== "intel") {
      return NextResponse.json({ error: 'mode must be "free" or "intel"' }, { status: 400 });
    }

    if (inv.dataMode === "demonstration") {
      return NextResponse.json(
        { error: "demonstration files cannot spend; open a live file to run intelligence" },
        { status: 400 },
      );
    }

    // Paid runs draw on the shared payer wallet, so they pass the same
    // per-user daily cap as every Mind; free runs cost nothing and skip it.
    let owner: string | null = null;
    if (mode === "intel") {
      const ceilingCents =
        typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
          ? Math.round(body.spendLimitUsdCents)
          : inv.spendLimitUsdCents;
      const gate = await paidRunGate(req, "settlement assurance intelligence", ceilingCents);
      if (gate.kind === "deny") return NextResponse.json({ error: gate.error }, { status: gate.status });
      owner = gate.userAddress ?? inv.owner;
    } else {
      owner = inv.owner;
    }

    const spendLimitUsdCents =
      typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
        ? Math.round(body.spendLimitUsdCents)
        : inv.spendLimitUsdCents;

    const { task } = await createAssuranceRun(inv, mode, { spendLimitUsdCents, actor, owner });
    return NextResponse.json(
      {
        task,
        poll: `/api/tasks/${task.id}`,
        note:
          task.state === "awaiting_approval"
            ? "awaiting_approval: approve the exact plan below (or on Approvals) before any ask is signed"
            : "free run accepted: probes only, nothing is signed",
      },
      { status: 202 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: err instanceof EngineError ? 400 : 400 });
  }
}
