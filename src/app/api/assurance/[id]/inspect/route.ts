import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { inspectInvestigation } from "@/lib/assurance/inspect";
import { audit, getInvestigation, saveInvestigation } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/assurance/:id/inspect — free, real Solana reads.
 * Replaces prior Solana evidence; an RPC failure is a failure, not a gap.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!requestAuthorized(req)) return NextResponse.json({ error: "authorization required" }, { status: 401 });
  const { id } = await ctx.params;
  const inv = await getInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });

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
      "operator",
      "solana_inspected",
      `${result.evidence.length} live Solana read(s) recorded for payer, recipient and mint; no payment involved.`,
    );
    if (inv.status === "draft") inv.status = "collecting";
    await saveInvestigation(inv);
    return NextResponse.json({ investigation: inv, notes: result.notes });
  } catch (err) {
    return NextResponse.json(
      { error: `Solana inspection failed: ${err instanceof Error ? err.message : String(err)}. No evidence was recorded.` },
      { status: 502 },
    );
  }
}
