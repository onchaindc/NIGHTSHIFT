import { NextResponse } from "next/server";

import { telegraphNodeUrl } from "@/lib/telegraph/client";

/**
 * GET /api/terminal/intents/[intent]
 * The one intent's canonical INPUT params and RESPONSE fields, plus its
 * supporting miners, straight from the node's free intent registry
 * (GET /engine/v1/intents/{intent}). Read-only: no payment, no key material.
 */

export interface IntentParam {
  name: string;
  type: string;
  required?: boolean;
  enum?: unknown[];
  description?: string;
  min?: number;
  max?: number;
  pattern?: string;
}

interface NodeIntentDetail {
  intent_id?: string;
  intent_name?: string;
  miner_count?: number;
  request?: { params?: IntentParam[]; schema_version?: number };
  response?: { fields?: Array<Record<string, unknown>>; format_version?: number };
  miners?: Array<{ id: string | number; slug?: string; name?: string; description?: string; base_url?: string }>;
}

interface SupportedMiner {
  minerId: string;
  slug: string;
  name: string;
  description?: string;
}

function shapeMiners(list: NodeIntentDetail["miners"]): SupportedMiner[] {
  return (list ?? [])
    .filter((m): m is NonNullable<NodeIntentDetail["miners"]>[number] => Boolean(m && m.id != null))
    .map((m) => ({
      minerId: String(m.id),
      slug: typeof m.slug === "string" ? m.slug : String(m.id),
      name: typeof m.name === "string" ? m.name : String(m.id),
      description: typeof m.description === "string" ? m.description.slice(0, 400) : undefined,
    }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ intent: string }> }) {
  const { intent } = await ctx.params;
  const name = decodeURIComponent(intent).toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(name)) {
    return NextResponse.json({ error: "invalid intent name" }, { status: 400 });
  }

  try {
    const res = await fetch(`${telegraphNodeUrl()}/engine/v1/intents/${encodeURIComponent(name)}`, {
      next: { revalidate: 900 },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      return NextResponse.json({ error: "intent_not_found", detail: `No intent named ${name} in the live registry (HTTP 404 from the node).` }, { status: 404 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: `intent registry answered HTTP ${res.status}` }, { status: 502 });
    }
    const detail = (await res.json()) as NodeIntentDetail;
    return NextResponse.json(
      {
        intent: detail.intent_name ?? name,
        minerCount: detail.miner_count ?? (detail.miners?.length ?? 0),
        params: detail.request?.params ?? [],
        schemaVersion: detail.request?.schema_version,
        responseFields: detail.response?.fields ?? null,
        responseFormatVersion: detail.response?.format_version,
        miners: shapeMiners(detail.miners),
      },
      { headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `the intent registry could not be read: ${msg.slice(0, 160)}` }, { status: 502 });
  }
}
