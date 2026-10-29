import { NextRequest, NextResponse, after } from "next/server";
import { autoCheckEnabled, runAutoScanOnce } from "@/lib/watch/scheduler";
import { requestAuthorized } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tick may run free source checks for every due watch; the scan continues
// in the background after this response (after()).
export const maxDuration = 60;

/**
 * GET/POST /api/watches/scheduler-tick - one scheduled Protocol Watch scan.
 *
 * Serverless deployments have no long-lived process, so the in-process
 * interval timer cannot be the worker there. Vercel Cron (or any external
 * scheduler) calls this endpoint; each call performs ONE due-scan exactly
 * like the local worker would: free checks only, lease-guarded against
 * duplicate workers, idempotent via persisted fingerprints (a repeated tick
 * can never double-report a change).
 *
 * Auth: gated by NIGHTSHIFT_API_TOKEN exactly like other watch-management
 * calls when that token is configured.
 */
async function tick(req: NextRequest) {
  if (!requestAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: this deployment gates watch management behind a bearer token (NIGHTSHIFT_API_TOKEN)" },
      { status: 401 },
    );
  }
  if (!autoCheckEnabled()) {
    return NextResponse.json({ ok: true, started: false, reason: "auto checks disabled (NIGHTSHIFT_WATCH_AUTOCHECK=0)" });
  }
  after(async () => {
    try {
      await runAutoScanOnce();
    } catch (err) {
      console.error("scheduler tick failed:", err);
    }
  });
  return NextResponse.json({ ok: true, started: true });
}

export async function GET(req: NextRequest) {
  return tick(req);
}

export async function POST(req: NextRequest) {
  return tick(req);
}
