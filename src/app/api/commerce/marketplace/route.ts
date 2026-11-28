import { NextRequest, NextResponse } from "next/server";

import { userAddressFromRequest } from "@/lib/api/auth";
import { acceptOffer, closeRequirement, createRequirement, offerOnRequirement, reviewRequirementDelivery, submitRequirementDelivery } from "@/lib/commerce/fulfill";
import { listPackages, listRequirements } from "@/lib/commerce/store";
import type { MarketplaceRequirement, ResellerPackage } from "@/lib/commerce/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionAddress(req: NextRequest): string | null {
  const address = userAddressFromRequest(req);
  return address && address.startsWith("0x") ? address.toLowerCase() : null;
}

/** The public face of a board entry. Wallets stay full addresses — they are
 *  the board's public identity (the UI truncates for display) and the owner
 *  comparison the buyer's browser makes must not be defeated by truncation. */
function publicRequirement(req: MarketplaceRequirement, caller: string | null) {
  return {
    ...req,
    ownerIsCaller: caller !== null && req.ownerWallet === caller,
  };
}

/**
 * GET /api/commerce/marketplace — the public board: open and matched buyer
 * requirements (with their provider offers) plus listed reseller packages.
 * No session needed to browse.
 *
 * POST — action-based, wallet session required:
 *   { action: "publish", title, category, detail, budgetUsdCents?, deadline? }
 *   { action: "offer", requirementId, serviceId? | offeringRef?, message, priceUsdCents }
 *   { action: "accept", requirementId, offerId }            — owner only
 *   { action: "close", requirementId }                       — owner only
 */
export async function GET(req: NextRequest) {
  const caller = sessionAddress(req);
  const [requirements, packages] = await Promise.all([listRequirements(), listPackages()]);
  const board = requirements
    .filter((r) => r.status !== "closed")
    .map((r) => publicRequirement(r, caller));
  return NextResponse.json({
    requirements: board,
    packages: packages.filter((p) => p.status === "listed").map((p) => ({ ...p, ownerIsCaller: caller !== null && p.ownerWallet === caller })),
    total: board.length,
  });
}

export async function POST(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to publish, offer, accept or close" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const action = body.action;

  if (action === "publish") {
    const result = await createRequirement(address, {
      title: body.title,
      category: body.category,
      detail: body.detail,
      budgetUsdCents: body.budgetUsdCents,
      deadline: body.deadline,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ requirement: publicRequirement(result.value, address) }, { status: 201 });
  }

  if (action === "offer") {
    const result = await offerOnRequirement({
      requirementId: body.requirementId,
      providerWallet: address,
      serviceId: body.serviceId,
      offeringRef: body.offeringRef,
      message: body.message,
      priceUsdCents: body.priceUsdCents,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ requirement: publicRequirement(result.value, address) });
  }

  if (action === "accept") {
    const result = await acceptOffer({ requirementId: body.requirementId, offerId: body.offerId, ownerWallet: address });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      requirement: publicRequirement(result.value.requirement, address),
      workflowId: result.value.workflow?.id ?? null,
    });
  }

  if (action === "submitDelivery") {
    const result = await submitRequirementDelivery({
      requirementId: body.requirementId,
      providerWallet: address,
      note: body.note,
      artifactUrl: body.artifactUrl,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ requirement: publicRequirement(result.value, address) });
  }

  if (action === "reviewDelivery") {
    const result = await reviewRequirementDelivery({
      requirementId: body.requirementId,
      ownerWallet: address,
      decision: body.decision,
      note: body.note,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ requirement: publicRequirement(result.value, address) });
  }

  if (action === "close") {
    const result = await closeRequirement(body.requirementId, address);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ requirement: publicRequirement(result.value, address) });
  }

  return NextResponse.json({ error: 'action must be "publish", "offer", "accept", "submitDelivery", "reviewDelivery" or "close"' }, { status: 400 });
}
