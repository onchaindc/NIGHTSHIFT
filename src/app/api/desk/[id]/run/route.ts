import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { paidRunGate } from "@/lib/api/userSpend";
import { EngineError } from "@/lib/engine/engine";
import { auditDesk, getDeskInvestigation, saveDeskInvestigation } from "@/lib/desk/store";
import { createDeskRun, planDeskCapabilities, reportDeskInvestigation, syncDeskInvestigation } from "@/lib/desk/orchestrate";
import { DESK_TYPE_LABEL } from "@/lib/desk/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/desk/:id/run
 *   { action: "run", mode: "free" | "intel", spendLimitUsdCents? }
 *   { action: "sync" }
 *   { action: "report", mode? }
 *
 * Runs belong to the wallet that owns the file. A paid run passes the same
 * shared gate as every Mind (operator, or wallet user under the daily cap)
 * and then stops at the existing approval gate. Sync absorbs only completed
 * runs into the evidence ledger; report also rebuilds the structured report.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = callerIdentity(req);
  const { id } = await ctx.params;
  const inv = await getDeskInvestigation(id);
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
      const result = await syncDeskInvestigation(inv);
      auditDesk(inv, actor, "desk_synced", `${result.added} evidence record(s) absorbed.`);
      await saveDeskInvestigation(inv);
      return NextResponse.json({ investigation: inv, added: result.added, notes: result.notes });
    }

    if (body.action === "report") {
      const mode = body.mode === "intel" ? "intel" : "free";
      const result = await reportDeskInvestigation(inv, mode);
      return NextResponse.json({ investigation: inv, added: result.added, notes: result.notes, report: result.report });
    }

    const mode = body.mode === "free" ? "free" : "intel";
    if (body.mode !== undefined && body.mode !== "free" && body.mode !== "intel") {
      return NextResponse.json({ error: 'mode must be "free" or "intel"' }, { status: 400 });
    }

    // A plan with zero askable capabilities is refused before a task exists.
    const plan = planDeskCapabilities(inv);
    if (plan.capabilities.length === 0) {
      return NextResponse.json(
        { error: "no capability has complete inputs yet — supply the missing form answers first", inputGaps: plan.inputGaps },
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
      const gate = await paidRunGate(req, `${DESK_TYPE_LABEL[inv.type].toLowerCase()} intelligence`, ceilingCents);
      if (gate.kind === "deny") return NextResponse.json({ error: gate.error }, { status: gate.status });
      owner = gate.userAddress ?? inv.owner;
    } else {
      owner = inv.owner;
    }

    const spendLimitUsdCents =
      typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0
        ? Math.round(body.spendLimitUsdCents)
        : inv.spendLimitUsdCents;

    const { task } = await createDeskRun(inv, mode, { spendLimitUsdCents, actor, owner });
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
