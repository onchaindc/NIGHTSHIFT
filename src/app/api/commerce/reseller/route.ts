import { NextRequest, NextResponse } from "next/server";

import { userAddressFromRequest } from "@/lib/api/auth";
import { createPackage, retirePackage, updatePackage } from "@/lib/commerce/fulfill";
import { listPackages } from "@/lib/commerce/store";
import type { ResellerPackage } from "@/lib/commerce/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionAddress(req: NextRequest): string | null {
  const address = userAddressFromRequest(req);
  return address && address.startsWith("0x") ? address.toLowerCase() : null;
}

function publicPackage(pkg: ResellerPackage, caller: string | null) {
  return { ...pkg, ownerIsCaller: caller !== null && pkg.ownerWallet === caller };
}

/**
 * GET /api/commerce/reseller — the caller's own packages (wallet session).
 * Component prices are resolved from live Capacity listings. The positive
 * spread is indicative only: this rail does not purchase services, move funds
 * or provide escrow, so it is not settled profit.
 */
export async function GET(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to see your packages" }, { status: 401 });
  }
  const mine = (await listPackages()).filter((p) => p.ownerWallet === address);
  return NextResponse.json({ packages: mine.map((p) => publicPackage(p, address)), total: mine.length });
}

export async function POST(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to build a package" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const action = body.action;

  if (action === "create") {
    const result = await createPackage({
      ownerWallet: address,
      name: body.name,
      summary: body.summary,
      components: body.components,
      packagePriceUsdCents: body.packagePriceUsdCents,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ package: publicPackage(result.value, address) }, { status: 201 });
  }

  if (action === "update") {
    const result = await updatePackage({ id: body.id, ownerWallet: address, packagePriceUsdCents: body.packagePriceUsdCents, summary: body.summary });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ package: publicPackage(result.value, address) });
  }

  if (action === "retire") {
    const result = await retirePackage(body.id, address);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ package: publicPackage(result.value, address) });
  }

  return NextResponse.json({ error: 'action must be "create", "update" or "retire"' }, { status: 400 });
}
