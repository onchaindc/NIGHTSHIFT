import { NextResponse } from "next/server";

import { MINDS, MIND_STATUS_LABEL } from "@/lib/minds/registry";
import { MIND_FOUNDATION } from "@/lib/minds/foundation";

export const dynamic = "force-dynamic";

/**
 * GET /api/minds - the public catalogue descriptor.
 *
 * It exposes exactly what the hub and profiles show: identity, domain,
 * status, the verified coverage an available Mind actually has, and the
 * shared foundation. It deliberately omits the internal product notes that
 * are not capability claims. A Mind without an investigation endpoint cannot
 * be launched from here.
 */
export async function GET() {
  return NextResponse.json({
    tool: "nightshift.minds",
    note: "Only status=available Minds have a working investigation path. in_development and planned Minds cannot be run.",
    statuses: MIND_STATUS_LABEL,
    minds: MINDS.map((mind) => ({
      slug: mind.slug,
      name: mind.name,
      domain: mind.domain,
      status: mind.status,
      summary: mind.summary,
      ...(mind.href ? { investigation: mind.href } : {}),
      ...(mind.coverage ? { coverage: mind.coverage } : {}),
    })),
    foundation: MIND_FOUNDATION.map(({ id, name, state, detail }) => ({ id, name, state, detail })),
  });
}
