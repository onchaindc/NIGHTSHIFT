import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { listAcpJobs } from "@/lib/acp/store";
import { runAcpTick } from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/acp/jobs — the ACP job ledger. Operator (or, via the bearer token,
 * any authorized caller) reads the full records; anonymous callers get the
 * status counts only, so buyer requirement content never leaks.
 *
 * POST /api/acp/jobs { action: "tick" } — advance every open job: follow the
 * linked investigations and submit deliverables whose reports exist. The tick
 * NEVER approves a paid run and NEVER spends; it only observes and delivers.
 */
export async function GET(req: NextRequest) {
  const identity = callerIdentity(req);
  const jobs = await listAcpJobs();
  if (identity.kind === "anonymous") {
    const counts: Record<string, number> = {};
    for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
    return NextResponse.json({ counts, total: jobs.length });
  }
  return NextResponse.json({ jobs, total: jobs.length });
}

export async function POST(req: NextRequest) {
  const identity = callerIdentity(req);
  if (identity.kind === "anonymous") {
    return NextResponse.json({ error: "sign in to operate the ACP provider" }, { status: 401 });
  }
  let body: { action?: unknown } = {};
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    /* empty body means tick */
  }
  if (body.action !== undefined && body.action !== "tick") {
    return NextResponse.json({ error: 'action must be "tick"' }, { status: 400 });
  }
  const result = await runAcpTick();
  return NextResponse.json(result);
}
