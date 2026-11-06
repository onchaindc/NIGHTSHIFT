import { NextResponse } from "next/server";

import { executeAsk, payerAddress, type ApprovedOffer } from "@/lib/terminal/ask";
import { recordTerminalOutcome, type RecordedActivity } from "@/lib/terminal/store";
import { paidCredentialsConfigured } from "@/lib/telegraph/client";
import { specFromBody, type PreviewBody } from "@/app/api/terminal/preview/route";

/**
 * POST /api/terminal/execute — the approved, PAID step of the terminal.
 *
 * Hard requirements (refusals, never silent):
 *   • `approved` must be literally true — a terminal execute call without an
 *     explicit approval flag refuses before anything is signed.
 *   • `offer` must name the exact challenge the user saw: scheme, network,
 *     asset, payTo and the atomic amount. Before signing, the live challenge
 *     is re-read; any drift refuses with the fresh challenge and pays nothing.
 *
 * A successful response carries the answer, the signal hash, the settlement
 * proof (PAYMENT-RESPONSE) and the Telegraph receipt (receipt_hash). A bare
 * 402, a failed pre-flight, or an unaccountable 200 are all reported as such —
 * never dressed up as success.
 */

interface ExecuteBody extends PreviewBody {
  approved?: boolean;
  offer?: unknown;
}

export function approvedOfferShape(v: unknown): v is ApprovedOffer {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.scheme === "exact" &&
    typeof o.network === "string" &&
    o.network.startsWith("eip155:") &&
    typeof o.asset === "string" &&
    o.asset.startsWith("0x") &&
    typeof o.payTo === "string" &&
    o.payTo.startsWith("0x") &&
    typeof o.amount === "string" &&
    /^\d+$/.test(o.amount)
  );
}

export async function POST(req: Request) {
  let body: ExecuteBody;
  try {
    body = (await req.json()) as ExecuteBody;
  } catch {
    return NextResponse.json({ status: "invalid", detail: "Send application/json." }, { status: 400 });
  }

  if (body.approved !== true) {
    return NextResponse.json(
      { status: "not_approved", detail: "No explicit approval was given: nothing was signed and nothing was paid." },
      { status: 403 },
    );
  }
  if (!approvedOfferShape(body.offer)) {
    return NextResponse.json(
      { status: "missing_approval", detail: "The approval must pin the exact offer shown (scheme exact, network eip155:…, asset, payTo and atomic amount)." },
      { status: 400 },
    );
  }
  if (!paidCredentialsConfigured()) {
    return NextResponse.json(
      { status: "not_configured", detail: "No payer wallet is configured on this deployment; the terminal can preview but never sign. Set TELEGRAPH_EVM_PRIVATE_KEY to enable real execution." },
      { status: 403 },
    );
  }

  const spec = specFromBody(body);
  const outcome = await executeAsk({
    spec,
    approved: true,
    approvedOffer: body.offer,
  });

  /**
   * Phase 5b: durably record the attempt into the SAME store the Activity
   * centre reads, AFTER the existing approval-pinned execution. Recording is
   * best-effort: a persistence failure never changes the paid outcome, but
   * the \'saved\' flag is reported truthfully either way.
   */
  const activity: RecordedActivity = await recordTerminalOutcome(outcome, spec, payerAddress() ?? undefined);

  switch (outcome.kind) {
    case "answered":
      return NextResponse.json({
        status: "answered",
        request: { path: outcome.urlPath, body: outcome.requestSent },
        offer: outcome.offer,
        answer: {
          result: outcome.result,
          resultShape: outcome.resultShape,
          shapeError: outcome.shapeError,
          fieldStatus: outcome.fieldStatus,
          minerId: outcome.minerId ?? outcome.receipt.miner,
          minerName: outcome.minerName,
          endpoint: outcome.endpoint,
          intent: outcome.intent ?? outcome.receipt.intent,
          input: outcome.input,
          costUsd: outcome.costUsd,
          durationMs: outcome.durationMs,
          timestamp: outcome.timestamp,
          warnings: outcome.warnings,
        },
        signalHash: outcome.signalHash,
        receipt: outcome.receipt,
        settlement: outcome.settlementHeader ?? null,
        payerAddress: payerAddress(),
        activity: activity.saved ? { id: activity.id, saved: true } : { saved: false, detail: activity.detail },
      });
    case "refused":
      return NextResponse.json(
        {
          status: "refused",
          detail: outcome.reason,
          fresh: outcome.fresh && outcome.fresh.kind === "challenge" ? { offer: outcome.fresh.approvedOffer } : undefined,
          activity: activity.saved ? { id: activity.id, saved: true } : { saved: false, detail: activity.detail },
        },
        { status: 409 },
      );
    case "unpaid_rejected":
      return NextResponse.json(
        {
          status: "refused",
          detail: `The node refused this request before any payment: HTTP ${outcome.status}.`,
          node: outcome.body ?? null,
          activity: activity.saved ? { id: activity.id, saved: true } : { saved: false, detail: activity.detail },
        },
        { status: 200 },
      );
    case "payment_rejected":
      return NextResponse.json({ status: "payment_rejected", detail: outcome.detail, activity: activity.saved ? { id: activity.id, saved: true } : { saved: false, detail: activity.detail } }, { status: 402 });
    case "failed":
      return NextResponse.json({ status: "failed", httpStatus: outcome.status ?? null, detail: outcome.detail, activity: activity.saved ? { id: activity.id, saved: true } : { saved: false, detail: activity.detail } }, { status: 502 });
    case "integrity":
      return NextResponse.json({ status: "integrity", detail: outcome.detail, activity: activity.saved ? { id: activity.id, saved: true } : { saved: false, detail: activity.detail } }, { status: 422 });
  }
}
