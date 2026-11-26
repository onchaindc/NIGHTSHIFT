import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { assessInvestigation } from "@/lib/assurance/assess";
import { syncIntelligence } from "@/lib/assurance/run";
import { audit, getInvestigation, saveInvestigation } from "@/lib/assurance/store";
import { notifyMindReport } from "@/lib/mind/builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/assurance/:id/assess
 * Absorbs any completed intelligence runs, then records the deterministic
 * findings and CLEARED/HOLD/ESCALATE decision. A connected Minds alias, when
 * configured, receives the completed report afterwards; delivery never
 * changes the decision.
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
      { error: identity.kind === "anonymous" ? "sign in with your wallet to assess this file" : "this file belongs to another wallet" },
      { status: identity.kind === "anonymous" ? 401 : 403 },
    );
  }
  const actor = identity.kind === "user" ? identity.address : "operator";

  try {
    const synced = await syncIntelligence(inv);
    const assessment = assessInvestigation(inv);
    inv.findings = assessment.findings;
    inv.decision = assessment.decision;
    inv.limitations = [...new Set([...inv.limitations, ...assessment.limitations])];
    inv.status = "assessed";
    audit(
      inv,
      actor,
      "assessment_recorded",
      `${assessment.decision.outcome}: ${assessment.findings.length} finding(s), ${assessment.decision.criteria.filter((c) => c.status === "missing").length} missing check(s).`,
    );
    audit(inv, actor, "intelligence_synced", `${synced.added} evidence record(s) absorbed before assessment.`);

    let delivery: { attempted: boolean; ok?: boolean; detail: string } = {
      attempted: false,
      detail: "Minds delivery not attempted.",
    };
    try {
      const result = await notifyMindReport({
        task: {
          id: inv.id,
          goal: `Settlement assurance · ${inv.reference} · ${inv.counterparty.legalName}`,
          state: assessment.decision.outcome,
          summary: assessment.decision.rationale,
        },
        report: {
          objective: `Pre-settlement assurance for ${inv.transaction.amountUsdc.toLocaleString("en-US")} USDC to ${inv.counterparty.legalName}`,
          confidence: inv.dataMode === "demonstration" ? "demonstration" : "deterministic",
          intelUsed: inv.evidence.some((e) => e.class === "node_verified"),
          reasoning: [
            assessment.decision.rationale,
            ...assessment.findings.map((f) => `[${f.severity}] ${f.title}: ${f.explanation}`),
          ],
        },
      });
      delivery = { attempted: true, ok: result.ok, detail: result.detail };
    } catch (err) {
      delivery = { attempted: true, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    audit(inv, "system", "minds_delivery", `${delivery.attempted ? (delivery.ok ? "delivered" : "skipped/failed") : "not attempted"}: ${delivery.detail}`);

    await saveInvestigation(inv);
    return NextResponse.json({ investigation: inv, synced: synced.notes, delivery });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
