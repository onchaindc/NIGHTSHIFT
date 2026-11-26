import { NextRequest, NextResponse } from "next/server";

import { callerIdentity } from "@/lib/api/auth";
import { getInvestigation, saveInvestigation } from "@/lib/assurance/store";
import { prepareSettlement, SettlementError, verifySettlementSignature } from "@/lib/assurance/settlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/assurance/:id/settlement
 *   { action: "prepare" }              — build the UNSIGNED instruction bundle
 *   { action: "verify", signature }    — independently check a signature
 *
 * NIGHTSHIFT never signs or broadcasts. A prepared bundle is only a set of
 * real instructions built from live chain state, handed to an authorized
 * institutional signer.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = callerIdentity(req);
  const { id } = await ctx.params;
  const inv = await getInvestigation(id);
  if (!inv) return NextResponse.json({ error: `investigation ${id} not found` }, { status: 404 });

  const isOwner =
    identity.kind === "operator" ||
    (identity.kind === "user" && inv.owner?.toLowerCase() === identity.address);
  if (!isOwner) {
    return NextResponse.json(
      { error: identity.kind === "anonymous" ? "sign in with your wallet to act on this file" : "this file belongs to another wallet" },
      { status: identity.kind === "anonymous" ? 401 : 403 },
    );
  }
  const actor = identity.kind === "user" ? identity.address : "operator";

  let body: { action?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "prepare") {
      const settlement = await prepareSettlement(inv, actor);
      return NextResponse.json({ settlement, note: "Unsigned, not broadcast. An authorized signer must sign and submit it." });
    }
    if (body.action === "verify") {
      if (typeof body.signature !== "string" || !body.signature.trim()) {
        return NextResponse.json({ error: "signature is required" }, { status: 400 });
      }
      const settlement = await verifySettlementSignature(inv, body.signature, actor);
      await saveInvestigation(inv);
      return NextResponse.json({
        settlement,
        note:
          settlement.status === "confirmed_on_chain"
            ? "Confirmed on chain by a live Solana read."
            : "Not verified as settled. Nothing is claimed beyond what the chain read returned.",
      });
    }
    return NextResponse.json({ error: 'action must be "prepare" or "verify"' }, { status: 400 });
  } catch (err) {
    if (err instanceof SettlementError) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
