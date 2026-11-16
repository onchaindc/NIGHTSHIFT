import { NextResponse } from "next/server";
import { telegraphNodeUrl } from "@/lib/telegraph/client";
import { normalizeAskPath } from "@/lib/terminal/paths";

/**
 * POST /api/terminal/proxy
 *
 * Forwards a client-signed x402 request to the Telegraph node.
 * The browser cannot read the node's PAYMENT-REQUIRED header (CORS),
 * so the client signs locally and we forward the paid request here.
 *
 * Body: { urlPath: string; body: unknown; paymentSignature?: string }
 * - Without paymentSignature: probes the node and returns the raw 402 challenge.
 * - With paymentSignature: forwards the paid request and returns the answer.
 */
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { urlPath?: string; body?: unknown; paymentSignature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const urlPath = normalizeAskPath(body.urlPath ?? "/engine/v1/ask");
  if (!urlPath) {
    return NextResponse.json({ error: "only /engine/v1/ask paths are allowed" }, { status: 400 });
  }

  const node = telegraphNodeUrl();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (body.paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = body.paymentSignature;
  }

  let res: Response;
  try {
    res = await fetch(`${node}${urlPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body.body ?? {}),
      signal: AbortSignal.timeout(55_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `node unreachable: ${msg.slice(0, 200)}` }, { status: 502 });
  }

  const paymentRequired = res.headers.get("payment-required");
  const paymentResponse = res.headers.get("payment-response");
  const receipt = res.headers.get("x-telegraph-receipt");
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 500);
  }

  return NextResponse.json({
    status: res.status,
    body: parsed,
    paymentRequired,
    paymentResponse,
    receipt,
  });
}
