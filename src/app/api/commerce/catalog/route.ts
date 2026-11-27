import { NextResponse } from "next/server";

import { COMMERCE_OFFERINGS, INTRO_PRICE_USD_CENTS, INTRO_RAIL_NOTE } from "@/lib/commerce/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/commerce/catalog — the four introductory Agent Commerce offerings.
 * These are NIGHTSHIFT-internal offerings on the internal credit rail; the
 * published ACP offerings live at /api/acp/buyer/catalog and are untouched here.
 */
export async function GET() {
  return NextResponse.json({
    offerings: COMMERCE_OFFERINGS,
    intro: {
      priceUsdCents: INTRO_PRICE_USD_CENTS,
      rail: "internal_credit",
      note: INTRO_RAIL_NOTE,
    },
  });
}
