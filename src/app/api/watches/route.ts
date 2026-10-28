import { NextRequest, NextResponse } from "next/server";
import { createWatch, listWatches, WatchValidationError } from "@/lib/watch/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/watches - all configured watches (configs are non-secret).
 * POST /api/watches - create a watch. Never fetches anything and never
 * spends; it only validates and stores configuration.
 */
export async function GET() {
  const watches = await listWatches();
  return NextResponse.json({ watches });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const watch = await createWatch({
      name: typeof body.name === "string" ? body.name : "",
      protocol: typeof body.protocol === "string" ? body.protocol : "",
      sources: Array.isArray(body.sources) ? (body.sources as Array<{ type?: unknown; label?: unknown; target?: unknown }>).map((s) => ({ type: String(s.type ?? ""), label: typeof s.label === "string" ? s.label : undefined, target: String(s.target ?? "") })) : [],
      spendLimitUsdCents: typeof body.spendLimitUsdCents === "number" && body.spendLimitUsdCents > 0 ? body.spendLimitUsdCents : undefined,
      requiresApprovalForPaid: body.requiresApprovalForPaid === true,
      telegramChatId: typeof body.telegramChatId === "string" || typeof body.telegramChatId === "number" ? body.telegramChatId : null,
    });
    return NextResponse.json({ watch }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof WatchValidationError) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
