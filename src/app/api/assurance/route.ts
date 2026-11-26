import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { readAuthorized } from "@/lib/api/public";
import { parseCreateBody } from "@/lib/assurance/create";
import { listInvestigations, saveInvestigation, summarize } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/assurance — investigation summaries.
 *
 * Live files are operator-only. The canned demonstration scenario is a
 * synthetic sample and stays readable so the workflow can be reviewed
 * without credentials; nothing from a live file crosses this gate.
 */
export async function GET(req: NextRequest) {
  const authorized = readAuthorized(req);
  try {
    const all = await listInvestigations();
    const investigations = authorized ? all : all.filter((inv) => inv.dataMode === "demonstration");
    return NextResponse.json({
      investigations: investigations.map(summarize),
      scope: authorized ? "operator" : "demonstration",
      ...(authorized ? {} : { note: "Demonstration files only. Live files require the operator token." }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
}

/** POST /api/assurance — open a live investigation file. */
export async function POST(req: NextRequest) {
  if (!requestAuthorized(req)) {
    return NextResponse.json({ error: "authorization required" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = parseCreateBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    await saveInvestigation(parsed.investigation);
    return NextResponse.json({ investigation: parsed.investigation }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
