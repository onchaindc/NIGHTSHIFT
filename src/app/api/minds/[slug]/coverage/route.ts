import { NextResponse } from "next/server";

import { mindBySlug } from "@/lib/minds/registry";
import { CAPABILITIES, readinessFor } from "@/lib/minds/capabilities";
import { probeMindCoverage, type MindCoverageProbe } from "@/lib/minds/capability-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Five-minute free-probe cache, per Mind. Nothing paid is ever cached here. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: MindCoverageProbe }>();

/**
 * GET /api/minds/:slug/coverage
 *
 * Default: the committed capability matrix for this Mind (no network call).
 * ?live=1: re-probe every supported dimension against the live node with its
 * canonical request body. Probes are UNPAID — a valid request returns the
 * x402 challenge and price, and nothing is ever signed. This is the reusable
 * coverage adapter, not an investigation and not a purchase.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const mind = mindBySlug(slug);
  if (!mind) return NextResponse.json({ error: "unknown Mind" }, { status: 404 });

  const profile = CAPABILITIES[slug];
  const url = new URL(req.url);
  const live = url.searchParams.get("live") === "1";

  if (!live) {
    return NextResponse.json({
      mind: { slug, name: mind.name, status: mind.status, readiness: readinessFor(slug, mind.status) },
      mode: "matrix",
      probedAt: "2026-11-24T00:00:00Z",
      dimensions: profile?.dimensions ?? [],
      note: "Committed matrix. Add ?live=1 to re-probe supported dimensions for free; no payment is ever signed by this endpoint.",
    });
  }

  const fresh = cache.get(slug);
  if (fresh && Date.now() - fresh.at < CACHE_TTL_MS) {
    return NextResponse.json({
      mind: { slug, name: mind.name, status: mind.status, readiness: readinessFor(slug, mind.status) },
      mode: "live",
      cached: true,
      probe: fresh.value,
      spendUsdCents: 0,
      note: "Cached free-probe result (5 minutes). No payment was signed.",
    });
  }

  try {
    const probe = await probeMindCoverage(slug);
    cache.set(slug, { at: Date.now(), value: probe });
    return NextResponse.json({
      mind: { slug, name: mind.name, status: mind.status, readiness: readinessFor(slug, mind.status) },
      mode: "live",
      cached: false,
      probe,
      spendUsdCents: 0,
      note: "Free probes only. A routable dimension means the node accepted the canonical schema, pinned provider and live price; it is not a purchased answer.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "coverage probe failed", detail: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      { status: 503 },
    );
  }
}
