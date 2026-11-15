import { NextResponse } from "next/server";
import { telegraphNodeUrl, decodeChallenge, extractReceipt } from "@/lib/telegraph/client";
import { recordTerminalOutcome } from "@/lib/terminal/store";
import type { AskRequestSpec, ExecuteOutcome } from "@/lib/terminal/ask";

/** POST /api/terminal/complete — send a signed payment, record activity, return the answer. */
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

  const receipt = extractReceipt(res.headers);
  const signalHash = parsed && typeof parsed === "object" && "signal_hash" in parsed
    ? String((parsed as { signal_hash?: string }).signal_hash ?? "")
    : "";

  if (res.status === 200 && signalHash && receipt) {
    // Record activity so it shows in the user's history.
    try {
      const payload = (input.body ?? {}) as Record<string, unknown>;
      const pin = typeof payload.miner === "string" ? payload.miner : undefined;
      const spec: AskRequestSpec =
        typeof payload.intent === "string" && payload.params && typeof payload.params === "object"
          ? { intent: payload.intent, params: payload.params as Record<string, unknown>, minerId: pin }
          : typeof payload.query === "string"
            ? { query: payload.query, minerId: pin }
            : { rawBody: payload, minerId: pin };
      const approved = payload.offer as
        | { network?: string; asset?: string; payTo?: string; amount?: string }
        | undefined;
      const outcome: ExecuteOutcome = {
        kind: "answered",
        urlPath,
        requestSent: input.body,
        offer: {
          scheme: "exact",
          network: approved?.network ?? "eip155:11155111",
          asset: approved?.asset ?? "",
          payTo: approved?.payTo ?? "",
          amount: receipt.amount_uusdc ?? approved?.amount ?? "0",
        },
        result: (parsed as { result?: unknown }).result ?? parsed,
        signalHash,
        receipt,
        settlementHeader: res.headers.get("payment-response") ?? undefined,
        minerName: (parsed as { miner_name?: string }).miner_name,
        minerId: (parsed as { miner_id?: string }).miner_id,
      };
      await recordTerminalOutcome(outcome, spec, input.payer);
    } catch {
      /* recording is best-effort */
    }
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
