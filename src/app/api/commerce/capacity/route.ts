import { NextRequest, NextResponse } from "next/server";

import { userAddressFromRequest } from "@/lib/api/auth";
import { createService, retireService, updateService } from "@/lib/commerce/fulfill";
import { listServices } from "@/lib/commerce/store";
import type { CapacityService } from "@/lib/commerce/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionAddress(req: NextRequest): string | null {
  const address = userAddressFromRequest(req);
  return address && address.startsWith("0x") ? address.toLowerCase() : null;
}

function publicService(service: CapacityService, caller: string | null) {
  // Full wallet — the ownership comparison in the buyer's browser needs it;
  // the UI truncates for display. (see marketplace route for the same choice)
  return { ...service, providerIsCaller: caller !== null && service.providerWallet === caller };
}

/**
 * GET /api/commerce/capacity — the provider directory: every listed service
 * with pricing, availability and its matrix-verification verdict. Public read.
 *
 * POST — action-based, wallet session required:
 *   { action: "list", name, category, summary, priceUsdCents, delivery?, slaHours?, capabilities? }
 *   { action: "update", id, priceUsdCents?, availability?, summary? }  — owner only
 *   { action: "retire", id }                                            — owner only
 */
export async function GET(req: NextRequest) {
  const caller = sessionAddress(req);
  const services = await listServices();
  return NextResponse.json({
    services: services.filter((s) => s.status === "listed").map((s) => publicService(s, caller)),
    total: services.filter((s) => s.status === "listed").length,
  });
}

export async function POST(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to list, update or retire a service" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const action = body.action;

  if (action === "list") {
    const result = await createService(address, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ service: publicService(result.value, address) }, { status: 201 });
  }

  if (action === "update") {
    const result = await updateService({ id: body.id, providerWallet: address, priceUsdCents: body.priceUsdCents, availability: body.availability, summary: body.summary });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ service: publicService(result.value, address) });
  }

  if (action === "retire") {
    const result = await retireService(body.id, address);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ service: publicService(result.value, address) });
  }

  return NextResponse.json({ error: 'action must be "list", "update" or "retire"' }, { status: 400 });
}
