"use client";

import type { InAppWallet } from "./in-app";

export interface ClientExecuteInput {
  wallet: InAppWallet;
  nodeUrl: string;
  urlPath: string;
  body: unknown;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

export interface ClientExecuteResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  receiptHash: string | null;
  signalHash: string | null;
  settlement: string | null;
  detail?: string;
}

/**
 * Pay for a Telegraph ask with the in-app wallet.
 *
 * The browser cannot complete the x402 handshake (CORS hides the challenge
 * header). We send the in-app key to our own server for this one request;
 * the server uses the same wrapFetchWithPayment path that already works,
 * then discards the key.
 */
export async function executeWithInAppWallet(input: ClientExecuteInput): Promise<ClientExecuteResult> {
  let res: Response;
  try {
    res = await fetch("/api/terminal/pay-with-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urlPath: input.urlPath,
        body: input.body,
        privateKey: input.wallet.privateKey,
        network: input.network,
        asset: input.asset,
        payTo: input.payTo,
        amount: input.amount,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: null, receiptHash: null, signalHash: null, settlement: null, detail: msg.slice(0, 250) };
  }

  const data = (await res.json().catch(() => null)) as {
    status?: number;
    body?: Record<string, unknown> | string | null;
    paymentResponse?: string | null;
    receipt?: string | null;
    error?: string;
    payer?: string;
  } | null;

  if (!data) {
    return { ok: false, status: res.status, body: null, receiptHash: null, signalHash: null, settlement: null, detail: `HTTP ${res.status}` };
  }
  if (data.error) {
    return { ok: false, status: data.status ?? res.status, body: null, receiptHash: null, signalHash: null, settlement: null, detail: data.error };
  }

  const parsed = data.body && typeof data.body === "object" ? data.body : null;
  const signalHash = typeof parsed?.signal_hash === "string" ? parsed.signal_hash : null;
  const receiptHash = data.receipt ?? null;

  if ((data.status ?? res.status) !== 200 || !signalHash) {
    const detail = parsed ? JSON.stringify(parsed).slice(0, 300) : `HTTP ${data.status ?? res.status}`;
    return { ok: false, status: data.status ?? res.status, body: parsed, receiptHash, signalHash, settlement: data.paymentResponse ?? null, detail };
  }

  return {
    ok: true,
    status: data.status ?? 200,
    body: parsed,
    receiptHash,
    signalHash,
    settlement: data.paymentResponse ?? null,
  };
}
