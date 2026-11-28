import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { runDecisionAssurance, getDecisionAssurance, DecisionAssuranceError } from "@/lib/hunyuan/assurance";
import {
  HunyuanAuthError,
  HunyuanCredentialsError,
  HunyuanRateLimitError,
  HunyuanResponseError,
  HunyuanSchemaError,
  HunyuanTimeoutError,
} from "@/lib/hunyuan/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Live inference on a long evidence digest; the window covers one review.
export const maxDuration = 300;

function scopeOf(value: unknown): "assurance" | "desk" | null {
  return value === "assurance" || value === "desk" ? value : null;
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof DecisionAssuranceError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof HunyuanCredentialsError) {
    return NextResponse.json({ error: err.message, missing: ["HUNYUAN_API_KEY"] }, { status: 503 });
  }
  if (err instanceof HunyuanAuthError) return NextResponse.json({ error: err.message }, { status: 502 });
  if (err instanceof HunyuanRateLimitError) return NextResponse.json({ error: err.message }, { status: 429 });
  if (err instanceof HunyuanTimeoutError) return NextResponse.json({ error: err.message }, { status: 504 });
  if (err instanceof HunyuanSchemaError) {
    return NextResponse.json({ error: err.message, issues: err.issues.slice(0, 10) }, { status: 502 });
  }
  if (err instanceof HunyuanResponseError) return NextResponse.json({ error: err.message }, { status: 502 });
  return NextResponse.json({ error: err instanceof Error ? err.message : "decision assurance failed" }, { status: 500 });
}

/**
 * POST /api/hunyuan/decision-assurance  { scope: "assurance"|"desk", id }
 *
 * Mission #01 — Enterprise Decision Assurance. Gathers the record's evidence
 * and the entity's continuum events, requests a structured Hunyuan review,
 * enforces evidence-traceability locally and persists the review ON the
 * investigation record (with an audit entry). Nothing is spent and nothing is
 * fabricated: a missing HUNYUAN_API_KEY is a 503, a provider failure is a
 * mapped error — never a synthetic review.
 *
 * Operator-gated: Hunyuan inference consumes provider quota on the
 * deployment's key, the same class of gate as paid-run creation.
 */
export async function POST(req: NextRequest) {
  if (!requestAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: decision assurance runs on the deployment's Tencent Hunyuan key and is operator-gated (NIGHTSHIFT_API_TOKEN)" },
      { status: 401 },
    );
  }
  let body: { scope?: unknown; id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const scope = scopeOf(body.scope);
  const id = idOf(body.id);
  if (!scope) return NextResponse.json({ error: 'scope must be "assurance" or "desk"' }, { status: 400 });
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const result = await runDecisionAssurance(scope, id);
    return NextResponse.json({
      review: result.record,
      citationsAccepted: result.citationsAccepted,
      citationsRejected: result.citationsRejected,
      correctiveRetry: result.correctiveRetry,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * GET /api/hunyuan/decision-assurance?scope=&id= — the persisted review, when
 * the record carries one. Operator-gated like the records it summarises.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const scope = scopeOf(url.searchParams.get("scope"));
  const id = idOf(url.searchParams.get("id"));
  if (!scope || !id) return NextResponse.json({ error: "scope and id are required" }, { status: 400 });
  try {
    const review = await getDecisionAssurance(scope, id);
    return NextResponse.json({ review, exists: review !== null });
  } catch (err) {
    return errorResponse(err);
  }
}
