import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { investigationsForCaller } from "@/lib/api/public";
import { parseCreateBody } from "@/lib/assurance/create";
import { listInvestigations, saveInvestigation, summarize } from "@/lib/assurance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/assurance — investigation summaries, identity-aware.
 *
 * The operator sees every file. A signed-in wallet sees its OWN live files in
 * full plus the demonstration fixture; anonymous callers see the demonstration
 * fixture only, so the workflow stays reviewable without credentials and
 * nothing from a live file crosses that gate.
 */
export async function GET(req: NextRequest) {
  try {
    const all = await listInvestigations();
    const { investigations } = investigationsForCaller(req, all);
    const identity = callerIdentity(req);
    return NextResponse.json({
      investigations: investigations.map(summarize),
      scope: identity.kind === "operator" ? "operator" : identity.kind === "user" ? "user" : "demonstration",
      ...(identity.kind === "anonymous"
        ? { note: "Sign in with your wallet to open live files; the demonstration file is open to everyone." }
        : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
}

/**
 * POST /api/assurance — open a live investigation file.
 * The deployment operator, or any signed-in wallet: the file is owned by the
 * wallet that opened it, so that wallet can run, approve and read it later.
 */
export async function POST(req: NextRequest) {
  const identity = callerIdentity(req);
  if (identity.kind === "anonymous") {
    return NextResponse.json(
      { error: "sign in with your wallet to open a live investigation file" },
      { status: 401 },
    );
  }
  const owner = identity.kind === "user" ? identity.address : null;
  const actor = owner ?? "operator";

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = parseCreateBody(body, actor, owner);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    await saveInvestigation(parsed.investigation);
    return NextResponse.json({ investigation: parsed.investigation }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
