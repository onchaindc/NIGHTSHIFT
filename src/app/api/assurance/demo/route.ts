import { NextRequest, NextResponse } from "next/server";

import { createDemoInvestigation } from "@/lib/assurance/demo";
import { listInvestigations, saveInvestigation } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/assurance/demo — seed the labelled demonstration scenario.
 *
 * Open to every caller and IDEMPOTENT: the fixture is synthetic, carries no
 * private data, can never be CLEARED or settled, and is deliberately readable
 * without credentials so the whole workflow can be reviewed. Seeding reuses
 * the existing fixture when one is on record, so this endpoint can never be
 * used to grow the store anonymously.
 */
export async function POST(_req: NextRequest) {
  try {
    const all = await listInvestigations();
    const existing = all.find((inv) => inv.dataMode === "demonstration");
    if (existing) return NextResponse.json({ investigation: existing, note: "Existing demonstration file returned." });
    const inv = createDemoInvestigation("demonstration");
    await saveInvestigation(inv);
    return NextResponse.json({ investigation: inv }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
