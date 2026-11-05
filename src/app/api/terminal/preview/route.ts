import { NextResponse } from "next/server";

import {
  assembleAskBody,
  payerAddress,
  probeAsk,
  type ApprovedOffer,
  type AskRequestSpec,
} from "@/lib/terminal/ask";
import { paidCredentialsConfigured } from "@/lib/telegraph/client";

/**
 * POST /api/terminal/preview — the UNPAID pre-flight of the terminal.
 *
 * Posts the assembled request to the node exactly as execution would, but
 * with no payment: the node validates input/routing BEFORE charging, so
 * invalid params, unknown miners and unroutable intents are detected here for
 * free. A valid request returns the live x402 challenge for approval.
 * Screens nothing: the node's own verdict is the displayed result.
 */

export interface PreviewBody {
  intent?: string;
  params?: Record<string, unknown>;
  query?: string;
  miner?: string;
  rawBody?: unknown;
}

function isApprovedOfferShape(v: unknown): v is ApprovedOffer {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.scheme === "string" &&
    typeof o.network === "string" &&
    typeof o.asset === "string" &&
    typeof o.payTo === "string" &&
    typeof o.amount === "string" &&
    /^\d+$/.test(o.amount)
  );
}

export function specFromBody(b: PreviewBody): AskRequestSpec {
  const spec: AskRequestSpec = {};
  if (typeof b.intent === "string" && b.intent.trim().length > 0) spec.intent = b.intent.trim();
  if (b.params !== undefined) spec.params = b.params;
  if (typeof b.query === "string" && b.query.trim().length > 0) spec.query = b.query;
  if (typeof b.miner === "string" && b.miner.trim().length > 0) spec.minerId = b.miner.trim();
  if (b.rawBody !== undefined) spec.rawBody = b.rawBody;
  return spec;
}

export async function POST(req: Request) {
  let parsedBody: PreviewBody;
  try {
    const parsed = (await req.json()) as PreviewBody;
    parsedBody = parsed ?? {};
  } catch {
    return NextResponse.json({ status: "invalid", detail: "Send application/json." }, { status: 400 });
  }
  // Only used by /api/terminal/execute; a preview request that carries an
  // offer (a stale approval) must not pay: strip it and answer as a fresh probe.
  const spec = specFromBody(parsedBody);

  const assembled = assembleAskBody(spec);
  let requestPreview: { path: string; body: unknown } | { error: string };
  if ("error" in assembled) {
    requestPreview = { error: assembled.error };
  } else {
    requestPreview = { path: assembled.urlPath, body: assembled.body };
  }

  const probe = await probeAsk(spec);

  switch (probe.kind) {
    case "challenge": {
      const extra = (probe.challenge.accepts ?? []).find((a) => a.scheme === "exact" && a.network?.startsWith("eip155:"))?.extra as
        | { name?: string; version?: string }
        | undefined;
      const timeoutEntry = (probe.challenge.accepts ?? []).find((a) => a.scheme === "exact" && a.network?.startsWith("eip155:"));
      return NextResponse.json({
        status: "challenge",
        request: requestPreview,
        offer: probe.approvedOffer,
        payment: {
          x402Version: probe.challenge.x402Version ?? null,
          scheme: probe.approvedOffer.scheme,
          network: probe.approvedOffer.network,
          asset: probe.approvedOffer.asset,
          assetName: extra?.name ?? null,
          assetVersion: extra?.version ?? null,
          amount: probe.approvedOffer.amount,
          amountUsdCents: Math.round((Number(probe.approvedOffer.amount) / 10000) * 100) / 100,
          payTo: probe.approvedOffer.payTo,
          maxTimeoutSeconds: timeoutEntry?.maxTimeoutSeconds ?? null,
          resource: probe.challenge.resource ?? null,
        },
        payer: {
          configured: paidCredentialsConfigured(),
          address: payerAddress(),
        },
      });
    }
    case "rejected":
      return NextResponse.json(
        { status: "refused", httpStatus: probe.status, request: requestPreview, node: probe.body ?? probe.text },
        {},
      );
    case "unavailable":
      return NextResponse.json({ status: "unavailable", detail: probe.detail, request: requestPreview });
  }
}
