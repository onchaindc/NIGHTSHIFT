import { fetchSignals, toRows } from "@/lib/daemon/client";

export const dynamic = "force-dynamic";

/**
 * Free Daemon feed relay for the Signals UI. Serves lean rows only and never
 * adds credentials: the Daemon feed is a public, keyless read.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const out = await fetchSignals({
    type: u.searchParams.get("type") ?? undefined,
    category: u.searchParams.get("category") ?? undefined,
    sinceHours: Number(u.searchParams.get("hours")) || undefined,
    limit: Number(u.searchParams.get("limit")) || 40,
    offset: Number(u.searchParams.get("offset")) || 0,
  });
  if (out.status === "ok") {
    return Response.json(
      {
        status: "ok",
        payload: { results: toRows(out.payload), total: out.payload.total, offset: out.payload.offset },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(out, { status: 502, headers: { "Cache-Control": "no-store" } });
}
