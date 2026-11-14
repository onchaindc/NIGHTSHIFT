"use client";

import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
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

export async function executeWithInAppWallet(input: ClientExecuteInput): Promise<ClientExecuteResult> {
  const account = privateKeyToAccount(input.wallet.privateKey);
  const paymentNetwork = input.network as `${string}:${string}`;
  const client = x402Client.fromConfig({
    schemes: [{ network: paymentNetwork, client: new ExactEvmScheme(account) }],
    spendControls: { allowedAssets: [{ network: paymentNetwork, asset: input.asset }] },
  });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  let res: Response;
  try {
    res = await fetchWithPayment(`${input.nodeUrl}${input.urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: null, receiptHash: null, signalHash: null, settlement: null, detail: msg.slice(0, 300) };
  }

  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const signalHash = typeof parsed?.signal_hash === "string" ? parsed.signal_hash : null;
  const receiptHash = res.headers.get("x-receipt-hash") ?? res.headers.get("receipt-hash");
  const settlement = res.headers.get("payment-response");

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body: parsed,
      receiptHash,
      signalHash,
      settlement,
      detail: `HTTP ${res.status}`,
    };
  }

  return { ok: true, status: res.status, body: parsed, receiptHash, signalHash, settlement };
}
