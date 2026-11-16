import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { telegraphNodeUrl, decodeChallenge, exactEvmOffer } from "@/lib/telegraph/client";
import { normalizeAskPath } from "@/lib/terminal/paths";

/** POST /api/terminal/challenge — return the live x402 challenge for client signing. */
export async function POST(req: Request) {
  let body: { urlPath?: string; body?: unknown };
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

  const accepted = challenge.accepts.find((a) => a.scheme === "exact" && a.network === offer.network);
  const atomicAmount = accepted?.amount;
  if (!atomicAmount || !/^\d+$/.test(atomicAmount)) {
    return NextResponse.json({ error: "challenge has no exact atomic amount" }, { status: 502 });
  }
  const chainId = Number(offer.network.replace(/^eip155:/, ""));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "challenge has an invalid EVM network" }, { status: 502 });
  }

  const extra = accepted?.extra && typeof accepted.extra === "object" ? (accepted.extra as Record<string, unknown>) : null;
  const domainName = typeof extra?.name === "string" && extra.name.trim() ? extra.name : "USD Coin";
  const domainVersion = typeof extra?.version === "string" && extra.version.trim() ? extra.version : "2";

  // EIP-712 typed data for USDC transferWithAuthorization (x402 exact scheme).
  // The amount is copied exactly from the challenge rather than reconstructed
  // from a rounded cents value, and the domain follows the offered chain/token.
  const now = Math.floor(Date.now() / 1000);
  const typedData = {
    domain: {
      name: domainName,
      version: domainVersion,
      chainId,
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
      value: atomicAmount,
      validAfter: String(now - 60),
      validBefore: String(now + 300),
      nonce: `0x${randomBytes(32).toString("hex")}`,
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
