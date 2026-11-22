import { NextResponse } from "next/server";
import { telegraphNodeUrl, decodeChallenge, extractReceipt } from "@/lib/telegraph/client";
import { recordTerminalOutcome } from "@/lib/terminal/store";
import { payerFromSettlement } from "@/lib/terminal/activity";
import { normalizeAskPath } from "@/lib/terminal/paths";
import type { AskRequestSpec, ExecuteOutcome } from "@/lib/terminal/ask";

/** POST /api/terminal/complete — send a signed payment, record activity, return the answer. */
export const maxDuration = 60;

function normalizePayer(value: unknown): string | null {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;
}

/** Rebuild the ask spec from the exact body that was signed. */
function specFromPayload(payload: Record<string, unknown>): AskRequestSpec {
  const minerId =
    typeof payload.miner === "string" && payload.miner.trim().length > 0
      ? payload.miner.trim()
      : undefined;
  if (
    typeof payload.intent === "string" &&
    payload.intent.trim().length > 0 &&
    payload.params &&
    typeof payload.params === "object" &&
    !Array.isArray(payload.params)
  ) {
    return { intent: payload.intent.trim(), params: payload.params as Record<string, unknown>, minerId };
  }
  if (typeof payload.query === "string" && payload.query.trim().length > 0) {
    return { query: payload.query.trim(), minerId };
  }
  if (payload.rawBody !== undefined) return { rawBody: payload.rawBody, minerId };
  return { rawBody: payload, minerId };
}

function activityRef(activity: Awaited<ReturnType<typeof recordTerminalOutcome>>) {
  return activity.saved ? { id: activity.id, saved: true } : { saved: false, detail: activity.detail };
}

export async function POST(req: Request) {
  let input: {
    urlPath?: string;
    body?: unknown;
    paymentSignature?: string;
    paymentHeader?: string;
    paymentHeaderName?: string;
    payer?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const urlPath = normalizeAskPath(input.urlPath ?? "/engine/v1/ask");
  if (!urlPath) {
    return NextResponse.json({ error: "only /engine/v1/ask paths are allowed" }, { status: 400 });
  }
  const paymentHeader = input.paymentHeader ?? input.paymentSignature;
  if (!paymentHeader) {
    return NextResponse.json({ error: "paymentSignature required" }, { status: 400 });
  }
  const paymentHeaderName = input.paymentHeaderName === "X-PAYMENT" ? "X-PAYMENT" : "PAYMENT-SIGNATURE";

  const payload = (input.body ?? {}) as Record<string, unknown>;
  const spec = specFromPayload(payload);
  const claimedPayer = normalizePayer(input.payer);

  const node = telegraphNodeUrl();
  let res: Response | null = null;
  try {
    res = await fetch(`${node}${urlPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [paymentHeaderName]: paymentHeader,
      },
      body: JSON.stringify(input.body ?? {}),
      signal: AbortSignal.timeout(55_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = `The node could not be reached after signing: ${msg.slice(0, 220)}`;
    const activity = await recordTerminalOutcome(
      { kind: "failed", detail },
      spec,
      claimedPayer ?? undefined,
    );
    return NextResponse.json({ status: 502, error: detail, activity: activityRef(activity) });
  }
  if (!res) {
    return NextResponse.json({ status: 502, error: "The node did not return a response." }, { status: 502 });
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 400);
  }

  const receipt = extractReceipt(res.headers);
  const paymentResponse = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  const signalHash =
    parsed && typeof parsed === "object" && "signal_hash" in parsed
      ? String((parsed as { signal_hash?: string }).signal_hash ?? "")
      : "";

  // The signed proof is authoritative; the client's value is only a fallback
  // for responses that arrive without one.
  const payer = payerFromSettlement(paymentResponse) ?? claimedPayer ?? undefined;

  if (res.status === 200 && signalHash) {
    if (receipt) {
      const approved = payload.offer as
        | { scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string }
        | undefined;
      const outcome: ExecuteOutcome = {
        kind: "answered",
        urlPath,
        requestSent: input.body,
        offer: {
          scheme: approved?.scheme === "escrow" ? "escrow" : "exact",
          network: approved?.network ?? "eip155:11155111",
          asset: approved?.asset ?? "",
          payTo: approved?.payTo ?? "",
          amount: receipt.amount_uusdc ?? approved?.amount ?? "0",
        },
        result: (parsed as { result?: unknown }).result ?? parsed,
        signalHash,
        receipt,
        settlementHeader: paymentResponse ?? undefined,
        minerName: (parsed as { miner_name?: string }).miner_name,
        minerId: (parsed as { miner_id?: string }).miner_id,
      };
      const activity = await recordTerminalOutcome(outcome, spec, payer);
      return NextResponse.json({
        status: res.status,
        body: parsed,
        paymentResponse,
        receipt: res.headers.get("x-telegraph-receipt"),
        activity: activityRef(activity),
      });
    }

    // The answer is real, but without the receipt header there is no honest
    // receipt to store. Deliver it and say plainly that activity was not saved.
    return NextResponse.json({
      status: res.status,
      body: parsed,
      paymentResponse,
      receipt: res.headers.get("x-telegraph-receipt"),
      activity: {
        saved: false,
        detail: "The node delivered an answer without a receipt header, so no activity record was written.",
      },
    });
  }

  const nodeBody = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const nodeError = typeof nodeBody?.error === "string" ? nodeBody.error : null;
  // "payment required" is only the generic headline; `reason` is the node's
  // actual refusal (insufficient escrow, spent nonce, signer mismatch, …).
  const nodeReason = typeof nodeBody?.reason === "string" && nodeBody.reason.trim() ? nodeBody.reason.trim() : null;
  const detail =
    res.status === 402
      ? nodeReason ?? nodeError ?? "The signed payment did not verify. Nothing was re-sent or charged."
      : `The node answered HTTP ${res.status}${nodeReason ?? nodeError ? `: ${nodeReason ?? nodeError}` : ""}.`;

  const outcome: ExecuteOutcome =
    res.status === 402
      ? { kind: "payment_rejected", detail }
      : { kind: "failed", status: res.status, detail };
  const activity = await recordTerminalOutcome(outcome, spec, payer);

  return NextResponse.json({
    status: res.status,
    body: parsed,
    paymentResponse,
    receipt: res.headers.get("x-telegraph-receipt"),
    ...(res.status === 402
      ? { challenge: decodeChallenge(res.headers.get("payment-required")), error: detail }
      : { error: detail }),
    activity: activityRef(activity),
  });
}
