import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { telegraphNodeUrl, selectTelegraphRequirement, exactEvmOffer, decodeChallenge } from "@/lib/telegraph/client";

/**
 * POST /api/terminal/pay-with-key
 *
 * Signs and sends a Telegraph ask using the caller's in-app private key.
 * The browser cannot complete the x402 handshake (CORS hides the challenge
 * header, and the client-side payload encoding is unreliable). This route
 * uses the same server path that already works for TELEGRAPH_EVM_PRIVATE_KEY,
 * but with the key the user supplied for this one request.
 *
 * Body: { urlPath: string; body: unknown; privateKey: string; network: string; asset: string; payTo: string; amount: string }
 * The key is used only in memory for this request and is never logged or stored.
 */
export const maxDuration = 60;

export async function POST(req: Request) {
  let input: {
    urlPath?: string;
    body?: unknown;
    privateKey?: string;
    network?: string;
    asset?: string;
    payTo?: string;
    amount?: string;
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
  if (!input.privateKey || !input.privateKey.startsWith("0x")) {
    return NextResponse.json({ error: "privateKey required" }, { status: 400 });
  }

  const node = telegraphNodeUrl();
  const account = privateKeyToAccount(input.privateKey as `0x${string}`);
  const network = (input.network ?? "eip155:11155111") as `${string}:${string}`;
  const asset = input.asset ?? "";

  // Probe first to pin the exact offer (same as the working server path).
  let probeRes: Response;
  try {
    probeRes = await fetch(`${node}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body ?? {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `probe failed: ${msg.slice(0, 200)}` }, { status: 502 });
  }

  if (probeRes.status !== 402) {
    const text = await probeRes.text().catch(() => "");
    return NextResponse.json({ status: probeRes.status, body: text.slice(0, 400), error: "node did not challenge" }, { status: 200 });
  }

  const challenge = decodeChallenge(probeRes.headers.get("payment-required"));
  const offer = exactEvmOffer(challenge);
  if (!challenge || !offer || !offer.asset || !offer.payTo) {
    return NextResponse.json({ error: "challenge incomplete" }, { status: 502 });
  }

  const client = x402Client.fromConfig({
    schemes: [{ network, client: new ExactEvmScheme(account) }],
    spendControls: { allowedAssets: [{ network, asset: offer.asset }] },
    paymentRequirementsSelector: (_version, accepts) =>
      selectTelegraphRequirement(
        accepts as never,
        { network: offer.network, asset: offer.asset, payTo: offer.payTo, amountCents: offer.amountCents },
        Number.POSITIVE_INFINITY,
      ) as never,
  });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  let res: Response;
  try {
    res = await fetchWithPayment(`${node}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body ?? {}),
      signal: AbortSignal.timeout(50_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `payment failed: ${msg.slice(0, 300)}` }, { status: 502 });
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 400);
  }

  return NextResponse.json({
    status: res.status,
    body: parsed,
    paymentResponse: res.headers.get("payment-response"),
    receipt: res.headers.get("x-telegraph-receipt"),
    payer: account.address,
  });
}
