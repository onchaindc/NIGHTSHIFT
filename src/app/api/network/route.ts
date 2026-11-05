import { NextResponse } from "next/server";

import { telegraphNodeUrl } from "@/lib/telegraph/client";
import { fetchIntents, fetchLiveOffer, fetchMiners, fetchValidators } from "@/lib/explorer/network";

/**
 * Public, read-only network summary for the Explorer. Only aggregates and
 * fields from the node's public discovery responses — no private
 * node-operator data and no key material of any kind.
 */
export async function GET() {
  const [miners, validators, intents, offer] = await Promise.all([
    fetchMiners(),
    fetchValidators(),
    fetchIntents(),
    fetchLiveOffer(),
  ]);

  const served = miners.status === "ok" ? miners.payload.reduce((n, m) => n + (m.total_requests_served ?? 0), 0) : null;

  return NextResponse.json(
    {
      node: telegraphNodeUrl(),
      miners:
        miners.status === "ok"
          ? {
              status: "ok",
              count: miners.payload.length,
              active: miners.payload.filter((m) => m.activation_status === "active").length,
              requests_served_reported: served,
            }
          : { status: "unavailable", detail: miners.detail },
      validators:
        validators.status === "ok"
          ? { status: "ok", count: validators.payload.length, validators: validators.payload }
          : { status: "unavailable", detail: validators.detail },
      intents:
        intents.status === "ok"
          ? {
              status: "ok",
              count: intents.payload.length,
              canonical_on_chain: intents.payload.filter((i) => i.canonical).length,
              total_miner_slots: intents.payload.reduce((n, i) => n + i.miner_count, 0),
            }
          : { status: "unavailable", detail: intents.detail },
      payment_offer:
        offer.status === "ok" ? { status: "ok", ...offer.payload } : { status: "unavailable", detail: offer.detail },
      generated_at: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
  );
}
