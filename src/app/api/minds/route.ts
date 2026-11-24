import { NextResponse } from "next/server";

import { MINDS, MIND_STATUS_LABEL } from "@/lib/minds/registry";
import { CAPABILITIES, READINESS_LABEL, readinessFor } from "@/lib/minds/capabilities";
import { MIND_FOUNDATION } from "@/lib/minds/foundation";

export const dynamic = "force-dynamic";

/**
 * GET /api/minds - the public catalogue descriptor.
 *
 * It exposes what the hub and profiles show: identity, status, the verified
 * capability matrix (intent, pinned provider, live price, verification kind),
 * named gaps and the honest readiness state. A Mind without an investigation
 * endpoint cannot be launched from here.
 */
export async function GET() {
  return NextResponse.json({
    tool: "nightshift.minds",
    note: "Only status=available Minds have a working investigation path. in_development and planned Minds cannot be run. probe_verified means schema, routing and price were verified unpaid; it is not an answer.",
    statuses: MIND_STATUS_LABEL,
    readiness: READINESS_LABEL,
    minds: MINDS.map((mind) => {
      const caps = CAPABILITIES[mind.slug];
      const dimensions = caps?.dimensions ?? [];
      return {
        slug: mind.slug,
        name: mind.name,
        domain: mind.domain,
        status: mind.status,
        summary: mind.summary,
        readiness: readinessFor(mind.slug, mind.status),
        counts: {
          verified: dimensions.filter((d) => d.status === "verified").length,
          partial: dimensions.filter((d) => d.status === "partial").length,
          gaps: dimensions.filter((d) => d.status === "gap").length,
        },
        ...(mind.href ? { investigation: mind.href } : {}),
        dimensions: dimensions.map((d) => ({
          id: d.id,
          label: d.label,
          status: d.status,
          ...(d.intent ? { intent: d.intent } : {}),
          ...(d.provider ? { provider: d.provider } : {}),
          ...(d.priceUsdCents ? { priceUsdCents: d.priceUsdCents } : {}),
          ...(d.verification ? { verification: d.verification } : {}),
          ...(d.limitation ? { limitation: d.limitation } : {}),
          ...(d.missingReason ? { missingReason: d.missingReason } : {}),
        })),
        ...(caps?.plan
          ? {
              plan: {
                order: caps.plan.order,
                budgetCeilingUsdCents: caps.plan.budgetCeilingUsdCents,
                approvalGate: caps.plan.approvalGate,
                verification: caps.plan.verification,
                exclusions: caps.plan.exclusions,
              },
            }
          : {}),
      };
    }),
    foundation: MIND_FOUNDATION.map(({ id, name, state, detail }) => ({ id, name, state, detail })),
  });
}
