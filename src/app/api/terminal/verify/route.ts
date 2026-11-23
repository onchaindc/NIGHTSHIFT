import { NextResponse } from "next/server";

import { verifySignal } from "@/lib/terminal/ask";

/**
 * POST /api/terminal/verify — verify a purchased call against the network.
 *
 * Takes { signalHash } (the `signal_hash` a confirmed 200 carried) and reports
 * what can actually be checked: the signal record on the node and an
 * independent re-derivation of the hash over its payload (keccak256 of the
 * compact, key-sorted, wallet-lowercased, <>&-escaped serialization — the
 * node's documented recipe). Only a re-derived match is claimed verified.
 */

export async function POST(req: Request) {
  let body: { signalHash?: unknown };
  try {
    body = (await req.json()) as { signalHash?: unknown };
  } catch {
    return NextResponse.json({ error: "Send application/json with { signalHash }." }, { status: 400 });
  }
  if (typeof body?.signalHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.signalHash)) {
    return NextResponse.json({ error: "signalHash must be a 0x-prefixed 64-character hash." }, { status: 400 });
  }

  const outcome = await verifySignal(body.signalHash);
  switch (outcome.kind) {
    case "verified":
      return NextResponse.json({ status: "verified", note: outcome.note, record: outcome.record });
    case "recorded":
      return NextResponse.json({ status: "recorded", note: outcome.note, record: outcome.record });
    case "unverified":
      return NextResponse.json({ status: "unverified", detail: outcome.detail }, { status: 200 });
  }
}
