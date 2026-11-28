import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { readContinuumEvents, readContinuumRuns } from "@/lib/hunyuan/continuum";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/hunyuan/continuum — the intelligence-event ledger, newest first.
 *
 * Mission #02's inspectable history: every detected development (deterministic
 * detection + Hunyuan assessment when the provider ran), with its entity,
 * linked investigations, evidence ids, fingerprint and limitations. Operator-
 * gated: the events summarise private investigation records.
 */
export async function GET(req: NextRequest) {
  if (!requestAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: the intelligence ledger summarises private investigation records (NIGHTSHIFT_API_TOKEN)" },
      { status: 401 },
    );
  }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  try {
    const [events, runs] = await Promise.all([readContinuumEvents(limit), readContinuumRuns(10)]);
    return NextResponse.json({ events, runs, note: "Deterministic detection deduplicated by content fingerprint; providerAssessment is null when Hunyuan did not assess the event (unconfigured or failed)." });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "ledger read failed" }, { status: 500 });
  }
}
