import { NextResponse } from "next/server";

import { probeCounterparty } from "@/lib/counterparty/intel";

/**
 * POST /api/counterparty/probe
 *
 * The UNPAID pre-flight for the Counterparty Intel flow. Takes
 * { company, jurisdiction? }, assembles the canonical
 * CORPORATE_REGISTRY_LOOKUP_GENERAL body pinned to zk-corp-atlas, and returns
 * what the node answers before any payment exists: either its validation
 * verdict or the live x402 challenge (the offer the user would approve).
 *
 * Nothing is signed here, ever. Paying continues through the Terminal's
 * existing rail: /api/terminal/challenge → wallet signature →
 * /api/terminal/proxy.
 */
export const maxDuration = 45;

export async function POST(req: Request) {
  let body: { company?: unknown; jurisdiction?: unknown };
  try {
    body = (await req.json()) as { company?: unknown; jurisdiction?: unknown };
  } catch {
    return NextResponse.json({ error: "Send application/json with { company, jurisdiction? }." }, { status: 400 });
  }

  const company = typeof body.company === "string" ? body.company : "";
  const jurisdiction = typeof body.jurisdiction === "string" && body.jurisdiction.trim() ? body.jurisdiction : undefined;

  const outcome = await probeCounterparty({ company, jurisdiction });
  return NextResponse.json({ status: outcome.kind, outcome });
}
