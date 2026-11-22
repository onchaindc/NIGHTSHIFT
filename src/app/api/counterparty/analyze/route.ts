import { NextResponse } from "next/server";

import { analyzeCounterparty } from "@/lib/counterparty/intel";

/**
 * POST /api/counterparty/analyze
 *
 * Post-purchase analysis for one Counterparty Intel purchase. Takes
 * { signalHash, bodyResult?, request? } and reports exactly what is checkable:
 *
 *   - the Terminal's signal verification (keccak re-derivation over the
 *     recorded payload — only a re-derived match counts as verified), and
 *   - the classification of THE HASH-COMMITTED ANSWER
 *     (record.payload.response): verified facts, missing fields, and
 *     disagreements against the paid body's summary `result` and the request.
 *
 * A bare `result` field on the paid body is deliberately NOT the basis of the
 * answer: on some providers it drops data the committed payload carries.
 */
export const maxDuration = 45;

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export async function POST(req: Request) {
  let body: { signalHash?: unknown; bodyResult?: unknown; request?: unknown };
  try {
    body = (await req.json()) as { signalHash?: unknown; bodyResult?: unknown; request?: unknown };
  } catch {
    return NextResponse.json({ error: "Send application/json with { signalHash, bodyResult?, request? }." }, { status: 400 });
  }

  if (typeof body.signalHash !== "string" || !HASH_RE.test(body.signalHash)) {
    return NextResponse.json({ error: "signalHash must be a 0x-prefixed 64-character hash." }, { status: 400 });
  }

  const bodyResult =
    body.bodyResult && typeof body.bodyResult === "object" && !Array.isArray(body.bodyResult)
      ? (body.bodyResult as Record<string, unknown>)
      : null;
  const requestRaw = body.request as { company?: unknown; jurisdiction?: unknown } | undefined;
  const request =
    requestRaw && typeof requestRaw.company === "string"
      ? { company: requestRaw.company, jurisdiction: typeof requestRaw.jurisdiction === "string" ? requestRaw.jurisdiction : undefined }
      : null;

  const analysis = await analyzeCounterparty(body.signalHash, bodyResult, request);
  return NextResponse.json({ status: analysis.kind, analysis });
}
