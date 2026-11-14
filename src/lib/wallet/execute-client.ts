"use client";

import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
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
 * The browser cannot read the node's PAYMENT-REQUIRED header (CORS), so we
 * proxy through /api/terminal/proxy:
 *   1. Probe via proxy to get the raw challenge.
 *   2. Sign the payment locally with the in-app key.
 *   3. Forward the signed request through the proxy to the node.
 */
export async function executeWithInAppWallet(input: ClientExecuteInput): Promise<ClientExecuteResult> {
  const account = privateKeyToAccount(input.wallet.privateKey);
  const paymentNetwork = input.network as `${string}:${string}`;

  // 1. Probe through the proxy (server can see the header).
  let probe: { status: number; body: unknown; paymentRequired: string | null };
  try {
    const res = await fetch("/api/terminal/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urlPath: input.urlPath, body: input.body }),
    });
    probe = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: null, receiptHash: null, signalHash: null, settlement: null, detail: `probe failed: ${msg.slice(0, 200)}` };
  }

  if (probe.status !== 402 || !probe.paymentRequired) {
    const detail = typeof probe.body === "object" && probe.body ? JSON.stringify(probe.body).slice(0, 200) : `HTTP ${probe.status}`;
    return { ok: false, status: probe.status, body: (probe.body as Record<string, unknown>) ?? null, receiptHash: null, signalHash: null, settlement: null, detail: `node did not challenge: ${detail}` };
  }

  // 2. Sign the payment locally.
  let paymentSignature: string;
  try {
    const client = x402Client.fromConfig({
      schemes: [{ network: paymentNetwork, client: new ExactEvmScheme(account) }],
      spendControls: { allowedAssets: [{ network: paymentNetwork, asset: input.asset }] },
      paymentRequirementsSelector: (_version, accepts) => {
        const list = accepts as Array<{ scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string }>;
        const exact = list.find(
          (a) =>
            a.scheme === "exact" &&
            a.network === input.network &&
            a.asset?.toLowerCase() === input.asset.toLowerCase() &&
            a.payTo?.toLowerCase() === input.payTo.toLowerCase(),
        );
        if (exact) return exact as never;
        const any = list.find((a) => a.scheme === "exact" && a.network === input.network);
        if (any) return any as never;
        throw new Error(`No exact EVM entry for ${input.network}`);
      },
    });
    // Build a synthetic 402 response the client can parse, then create the payload.
    // We pass the raw header through a minimal Response-like object via the
    // client's createPaymentPayload after decoding ourselves.
    const challenge = JSON.parse(atob(probe.paymentRequired));
    const payload = await (client as { createPaymentPayload: (p: unknown) => Promise<unknown> }).createPaymentPayload(challenge);
    // The client returns the payload; we need the encoded header. Fall back to
    // re-encoding if the method doesn't return the header directly.
    const encoded = typeof payload === "string" ? payload : btoa(JSON.stringify(payload));
    paymentSignature = encoded;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: null, receiptHash: null, signalHash: null, settlement: null, detail: `sign failed: ${msg.slice(0, 250)}` };
  }

  // 3. Forward the signed request through the proxy.
  let paid: { status: number; body: unknown; paymentResponse: string | null; receipt: string | null };
  try {
    const res = await fetch("/api/terminal/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urlPath: input.urlPath,
        body: input.body,
        paymentSignature,
      }),
    });
    paid = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: null, receiptHash: null, signalHash: null, settlement: null, detail: `paid forward failed: ${msg.slice(0, 200)}` };
  }

  const parsed = (paid.body && typeof paid.body === "object" ? paid.body : null) as Record<string, unknown> | null;
  const signalHash = typeof parsed?.signal_hash === "string" ? parsed.signal_hash : null;
  const receiptHash = paid.receipt ? "present" : null;

  if (paid.status !== 200 || !signalHash) {
    const detail = parsed ? JSON.stringify(parsed).slice(0, 250) : `HTTP ${paid.status}`;
    return { ok: false, status: paid.status, body: parsed, receiptHash, signalHash, settlement: paid.paymentResponse, detail };
  }

  return {
    ok: true,
    status: paid.status,
    body: parsed,
    receiptHash,
    signalHash,
    settlement: paid.paymentResponse,
  };
}
