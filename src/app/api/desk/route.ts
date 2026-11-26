import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { parseCreateDeskBody } from "@/lib/desk/create";
import { listDeskInvestigations, saveDeskInvestigation, summarizeDesk } from "@/lib/desk/store";
import { DESK_TYPE_ORDER, describeDeskWorkflow } from "@/lib/desk/workflows";
import { DESK_TYPE_LABEL } from "@/lib/desk/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desk — Deal Desk investigation summaries, identity-aware.
 *
 * The operator sees every specialised file. A signed-in wallet sees its OWN
 * files. Anonymous callers see an empty list with the workflow catalogue, so
 * the entry point stays browsable without leaking anything.
 */
export async function GET(req: NextRequest) {
  let all;
  try {
    all = await listDeskInvestigations();
  } catch {
    await new Promise((r) => setTimeout(r, 900));
    try {
      all = await listDeskInvestigations();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
    }
  }
  try {
    const identity = callerIdentity(req);
    const visible =
      identity.kind === "operator"
        ? all
        : identity.kind === "user"
          ? all.filter((inv) => inv.owner?.toLowerCase() === identity.address)
          : [];
    return NextResponse.json({
      investigations: visible.map(summarizeDesk),
      scope: identity.kind === "operator" ? "operator" : identity.kind === "user" ? "user" : "anonymous",
      workflows: DESK_TYPE_ORDER.map((type) => {
        const summary = describeDeskWorkflow(type);
        return {
          type,
          name: DESK_TYPE_LABEL[type],
          kicker: summary.kicker,
          summary: summary.summary,
          scope: summary.scope,
          capabilityCount: summary.capabilityCount,
          gapCount: summary.gapCount,
          sections: summary.sections.map((s) => s.title),
        };
      }),
      ...(identity.kind === "anonymous" ? { note: "Sign in with your wallet to open a specialised investigation file." } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "storage unavailable", detail: detail.slice(0, 200) }, { status: 503 });
  }
}

/**
 * POST /api/desk — open a specialised investigation file.
 * Body: { type, subject: { <field answers> }, spendLimitUsdCents? }
 * The deployment operator, or any signed-in wallet: the file is owned by the
 * wallet that opened it, so that wallet can run, approve and read it later.
 */
export async function POST(req: NextRequest) {
  const identity = callerIdentity(req);
  if (identity.kind === "anonymous") {
    return NextResponse.json(
      { error: "sign in with your wallet to open a specialised investigation file" },
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
  const parsed = parseCreateDeskBody(body, actor, owner);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    await saveDeskInvestigation(parsed.investigation);
    return NextResponse.json({ investigation: parsed.investigation }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
