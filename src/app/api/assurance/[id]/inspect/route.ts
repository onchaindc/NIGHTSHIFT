import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { inspectInvestigation } from "@/lib/assurance/inspect";
import { applyAssessment } from "@/lib/assurance/reassess";
import { audit, getInvestigation, saveInvestigation } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/assurance/:id/inspect — free, real Solana reads.
 * The file's owner (wallet or operator) only: an inspection mutates the file's
 * evidence ledger, so a read-only demonstration visitor cannot trigger it.
 * Replaces prior Solana evidence; an RPC failure is a failure, not a gap.
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
      { error: identity.kind === "anonymous" ? "sign in with your wallet to inspect this file" : "this file belongs to another wallet" },
      { status: identity.kind === "anonymous" ? 401 : 403 },
    );
  }

  try {
    const result = await inspectInvestigation(inv);
    inv.evidence = [
      ...inv.evidence.filter((e) => !e.capability.startsWith("solana_")),
      ...result.evidence,
    ];
    inv.limitations = inv.limitations.filter(
      (l) => !l.startsWith("No live Solana read") && !l.startsWith("No live Solana reads"),
    );
    for (const note of result.notes) inv.limitations.push(note);
    audit(
      inv,
      identity.kind === "user" ? `wallet ${identity.address.slice(0, 10)}…` : "operator",
      "solana_inspected",
      `${result.evidence.length} live Solana read(s) recorded for payer, recipient and mint; no payment involved.`,
    );
    if (inv.status === "draft") inv.status = "collecting";
    // The recorded decision must reflect this inspection immediately — a HOLD
    // that still lists checks the fresh reads just satisfied reads as broken.
    const { assessment } = await applyAssessment(inv, identity.kind === "user" ? identity.address : "operator");
    await saveInvestigation(inv);
    return NextResponse.json({ investigation: inv, notes: result.notes, outcome: assessment.decision.outcome });
  } catch (err) {
    return NextResponse.json(
      { error: `Solana inspection failed: ${err instanceof Error ? err.message : String(err)}. No evidence was recorded.` },
      { status: 502 },
    );
  }
}
