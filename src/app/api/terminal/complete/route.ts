import { NextResponse } from "next/server";
import { telegraphNodeUrl, decodeChallenge } from "@/lib/telegraph/client";

/** POST /api/terminal/complete — send a signed payment and return the answer. */
export const maxDuration = 60;

export async function POST(req: Request) {
  let input: {
    urlPath?: string;
    body?: unknown;
    paymentSignature?: string;
    payer?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const urlPath = input.urlPath ?? "/engine/v1/ask";
  if (!urlPath.startsWith("/engine/v1/ask")) {
    return NextResponse.json({ error: "only /engine/v1/ask paths are allowed" }, { status: 400 });
  }
  if (!input.paymentSignature) {
    return NextResponse.json({ error: "paymentSignature required" }, { status: 400 });
  }

  const node = telegraphNodeUrl();
  const res = await fetch(`${node}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": input.paymentSignature,
    },
    body: JSON.stringify(input.body ?? {}),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 400);
  }

  if (res.status === 402) {
    const challenge = decodeChallenge(res.headers.get("payment-required"));
    return NextResponse.json({ status: 402, body: parsed, challenge, error: "payment rejected" });
  }

  return NextResponse.json({
    status: res.status,
    body: parsed,
    paymentResponse: res.headers.get("payment-response"),
    receipt: res.headers.get("x-telegraph-receipt"),
  });
}
