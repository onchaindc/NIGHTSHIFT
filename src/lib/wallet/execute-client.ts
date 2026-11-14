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

/**
 * Decode the base64 PAYMENT-REQUIRED header the same way the server does.
 * The x402 library's default parser rejects Telegraph's challenge shape;
 * we pin the exact EVM entry ourselves.
 */
function decodeChallenge(headerValue: string | null): {
  accepts?: Array<{ scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string }>;
} | null {
  if (!headerValue) return null;
  try {
    const json = atob(headerValue);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function executeWithInAppWallet(input: ClientExecuteInput): Promise<ClientExecuteResult> {
  const account = privateKeyToAccount(input.wallet.privateKey);
  const paymentNetwork = input.network as `${string}:${string}`;

  // Probe first so we can pin the exact requirement the user approved.
  // The library's automatic parse of Telegraph's 402 fails with
  // "Invalid payment required response"; selecting the entry ourselves avoids it.
  let probeChallenge: ReturnType<typeof decodeChallenge> = null;
  try {
    const probe = await fetch(`${input.nodeUrl}${input.urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
    });
    if (probe.status === 402) {
      probeChallenge = decodeChallenge(probe.headers.get("payment-required"));
    }
  } catch {
    /* continue; the paying fetch will surface a clearer error */
  }

  const client = x402Client.fromConfig({
    schemes: [{ network: paymentNetwork, client: new ExactEvmScheme(account) }],
    spendControls: { allowedAssets: [{ network: paymentNetwork, asset: input.asset }] },
    paymentRequirementsSelector: (_version, accepts) => {
      const list = accepts as Array<{ scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string }>;
      // Prefer the entry that matches what the user approved.
      const exact = list.find(
        (a) =>
          a.scheme === "exact" &&
          a.network === input.network &&
          a.asset?.toLowerCase() === input.asset.toLowerCase() &&
          a.payTo?.toLowerCase() === input.payTo.toLowerCase() &&
          a.amount === input.amount,
      );
      if (exact) return exact as never;
      // Fall back to any exact EVM entry on the approved network.
      const anyExact = list.find((a) => a.scheme === "exact" && a.network === input.network);
      if (anyExact) return anyExact as never;
      throw new Error(
        `No signable exact-scheme entry for ${input.network}. Schemes offered: ${list.map((a) => a.scheme).join(", ") || "none"}`,
      );
    },
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
    // Surface the probe challenge if the library still rejected the format.
    const hint = probeChallenge ? " (challenge was readable on probe)" : "";
    return {
      ok: false,
      status: 0,
      body: null,
      receiptHash: null,
      signalHash: null,
      settlement: null,
      detail: `${msg.slice(0, 280)}${hint}`,
    };
  }

  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const signalHash = typeof parsed?.signal_hash === "string" ? parsed.signal_hash : null;
  const receiptHash = res.headers.get("x-receipt-hash") ?? res.headers.get("x-telegraph-receipt");
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
