import { NextRequest, NextResponse } from "next/server";

import { cronAuthorized, requestAuthorized } from "@/lib/api/auth";
import { autoContinuumEnabled, runContinuumTick } from "@/lib/hunyuan/continuum";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tick scans every tracked entity and may run one Hunyuan assessment per
// entity with detected changes; the window covers a full pass.
export const maxDuration = 300;

/**
 * POST /api/hunyuan/continuum/tick — one continuous-intelligence pass.
 *
 * The RECURRING driver is the existing scheduler: /api/watches/scheduler-tick
 * (Vercel Cron daily) runs this pass alongside the watch scan. This route
 * allows an operator (or the cron secret) to run a pass on demand and see the
 * result. Duplicate workers are guarded by the same ttl lease the watch
 * scheduler uses; a second concurrent tick reports skippedByOtherWorker
 * instead of double-reporting, and content fingerprints make reruns
 * idempotent.
 *
 * Auth: operator token or CRON_SECRET (what Vercel Cron presents). Fails
 * closed when neither is configured.
 */
export async function POST(req: NextRequest) {
  if (!requestAuthorized(req) && !cronAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: the continuum tick is operator-gated (NIGHTSHIFT_API_TOKEN)" },
      { status: 401 },
    );
  }
  if (!autoContinuumEnabled()) {
    return NextResponse.json({ ok: true, started: false, reason: "continuum disabled (NIGHTSHIFT_CONTINUUM_AUTOCHECK=0)" });
  }
  try {
    const result = await runContinuumTick({ trigger: "manual" });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "continuum tick failed" }, { status: 502 });
  }
}
