import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { getDeskInvestigation } from "@/lib/desk/store";
import { healDeskVerification } from "@/lib/desk/orchestrate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desk/:id — one specialised investigation file, identity-aware.
 * The operator and the owning wallet read the file in full; everyone else
 * gets 404 so ids do not leak (the same model as settlement files).
 *
 * On a visible read, evidence recorded by an older pipeline is repaired if it
 * needs it (a record whose own verification note says it never independently
 * re-derived is reclassified, the report rebuilt, the file persisted). On an
 * already-clean file this writes nothing. A repair failure never blocks the
 * read — the caller still gets the stored file.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const inv = await getDeskInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });

  const identity = callerIdentity(req);
  const visible =
    identity.kind === "operator" ||
    (identity.kind === "user" && inv.owner?.toLowerCase() === identity.address);
  if (!visible) {
    return NextResponse.json(
      { error: identity.kind === "anonymous" ? "sign in with your wallet to read this file" : "this file belongs to another wallet" },
      { status: identity.kind === "anonymous" ? 404 : 403 },
    );
  }
  try {
    await healDeskVerification(inv);
  } catch {
    /* the stored file is still served; the next sync or report retries the repair */
  }
  return NextResponse.json({ investigation: inv });
}
