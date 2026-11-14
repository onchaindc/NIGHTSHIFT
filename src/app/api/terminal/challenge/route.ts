import { NextResponse } from "next/server";
import { telegraphNodeUrl, decodeChallenge, exactEvmOffer } from "@/lib/telegraph/client";

/** POST /api/terminal/challenge — return the live x402 challenge for client signing. */
export async function POST(req: Request) {
  let body: { urlPath?: string; body?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const urlPath = body.urlPath ?? "/engine/v1/ask";
  if (!urlPath.startsWith("/engine/v1/ask")) {
    return NextResponse.json({ error: "only /engine/v1/ask paths are allowed" }, { status: 400 });
  }

  const node = telegraphNodeUrl();
  const res = await fetch(`${node}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body.body ?? {}),
  });

  if (res.status !== 402) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({ error: "node did not challenge", status: res.status, body: text.slice(0, 200) }, { status: 502 });
  }

  const challenge = decodeChallenge(res.headers.get("payment-required"));
  const offer = exactEvmOffer(challenge);
  if (!challenge || !offer || !offer.asset || !offer.payTo) {
    return NextResponse.json({ error: "challenge incomplete" }, { status: 502 });
  }

  // EIP-712 typed data for USDC transferWithAuthorization (x402 exact scheme).
  const now = Math.floor(Date.now() / 1000);
  const typedData = {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 11155111,
      verifyingContract: offer.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: "", // filled by client
      to: offer.payTo,
      value: String(offer.amountCents * 10000),
      validAfter: String(now - 60),
      validBefore: String(now + 300),
      nonce: `0x${Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("")}`,
    },
  };

  return NextResponse.json({
    challenge,
    offer,
    typedData,
    nodeUrl: node,
    urlPath,
  });
}
