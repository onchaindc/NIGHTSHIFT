import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { getDeskInvestigation } from "@/lib/desk/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desk/:id — one specialised investigation file, identity-aware.
 * The operator and the owning wallet read the file in full; everyone else
 * gets 404 so ids do not leak (the same model as settlement files).
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
  return NextResponse.json({ investigation: inv });
}
