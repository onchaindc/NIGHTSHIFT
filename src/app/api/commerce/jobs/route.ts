import { NextRequest, NextResponse } from "next/server";

import { userAddressFromRequest } from "@/lib/api/auth";
import { fulfillCommercePurchase } from "@/lib/commerce/fulfill";
import { listCommerceJobs } from "@/lib/commerce/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionAddress(req: NextRequest): string | null {
  const address = userAddressFromRequest(req);
  return address && address.startsWith("0x") ? address.toLowerCase() : null;
}

/**
 * The internal purchase rail for the four introductory Agent Commerce
 * offerings — authenticated by the wallet session cookie, exactly like the
 * ACP buyer jobs route.
 *
 * GET  — the caller's own purchases, newest first, each with its fulfillment
 *        record and its honest settlement note.
 * POST — { offeringId, input } buys one intro offering. The purchase settles
 *        on the internal credit rail (no wallet signature, no escrow, no
 *        on-chain movement — the intro price is recorded, not charged) and is
 *        fulfilled immediately: a live marketplace requirement with matches,
 *        a service listing, an executable workflow whose first desk step
 *        starts its free pre-flight, or a listed reseller package.
 */
export async function GET(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to see your purchases" }, { status: 401 });
  }
  const jobs = await listCommerceJobs(address);
  return NextResponse.json({ jobs, total: jobs.length, address });
}

export async function POST(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to purchase an intro offering" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (typeof body.offeringId !== "string") {
    return NextResponse.json({ error: "offeringId is required — see GET /api/commerce/catalog" }, { status: 400 });
  }
  const result = await fulfillCommercePurchase({
    offeringId: body.offeringId,
    buyerWallet: address,
    input: (body.input as Record<string, unknown>) ?? {},
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ job: result.value }, { status: 201 });
}
