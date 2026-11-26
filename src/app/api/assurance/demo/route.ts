import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { createDemoInvestigation } from "@/lib/assurance/demo";
import { saveInvestigation } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/assurance/demo — seed the labelled demonstration scenario. */
export async function POST(req: NextRequest) {
  if (!requestAuthorized(req)) return NextResponse.json({ error: "authorization required" }, { status: 401 });
  try {
    const inv = createDemoInvestigation("operator");
    await saveInvestigation(inv);
    return NextResponse.json({ investigation: inv }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
