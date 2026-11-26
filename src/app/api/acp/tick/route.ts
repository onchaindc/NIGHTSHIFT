import { NextRequest, NextResponse, after } from "next/server";

import { cronAuthorized, requestAuthorized } from "@/lib/api/auth";
import { ensureAcpRuntime, runAcpTick } from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET/POST /api/acp/tick — the scheduled ACP sweep: (1) reconnect the live
 * transport if a recycled serverless instance left it down (ensureAcpRuntime
 * retries after a failed or absent boot attempt), (2) advance every open job
 * and submit deliverables whose reports exist. Never approves a paid run and
 * never spends.
 *
 * Auth: the operator token, or the CRON_SECRET Vercel Cron presents as its
 * bearer token — the same gate as the watches scheduler tick. Fails closed.
 */
async function tick(req: NextRequest) {
  if (!requestAuthorized(req) && !cronAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: this endpoint is gated behind the operator token or the cron secret" },
      { status: 401 },
    );
  }
  after(async () => {
    try {
      const transport = await ensureAcpRuntime();
      const result = await runAcpTick();
      console.log(`ACP tick: transport ${transport ? transport.mode : "down"} · advanced ${result.advanced} · submitted ${result.submitted.length}${result.notes.length ? ` · ${result.notes.join("; ")}` : ""}`);
    } catch (err) {
      console.error("ACP tick failed:", err instanceof Error ? err.message : err);
    }
  });
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  return tick(req);
}

export async function POST(req: NextRequest) {
  return tick(req);
}
