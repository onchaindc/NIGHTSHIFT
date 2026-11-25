import { NextResponse } from "next/server";
import { rpcForChainId } from "@/lib/chain/rpc";
import { telegraphPayerAddress } from "@/lib/telegraph/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/wallet/balance — the money autonomous Minds actually spend.
 *
 * Telegraph challenges two payment rails, and they debit DIFFERENT wallets:
 *  - the escrow rail (Ethereum Sepolia, Telegraph test USDC) is signed by the
 *    user's own wallet in the Terminal — that balance is visible on the Funds
 *    page card for the connected wallet;
 *  - the direct x402 exact rail is signed by the deployment's payer key —
 *    BEFORE this endpoint existed, those spends were invisible anywhere in the
 *    app, which is why "I spend, but the balance never changes".
 *
 * Public chain reads only (eth_call balanceOf); no key material leaves the
 * server, and the key itself is never returned.
 */

const PAYMENT_RAILS = [
  {
    network: "eip155:11155111",
    chain: "Ethereum Sepolia",
    asset: "0xcc194e1a843B658526D0D5C431f670028582Ae17",
    name: "Telegraph test USDC",
    role: "escrow rail — Terminal payments signed by YOUR wallet (fund it with the in-app faucet)",
  },
  {
    network: "eip155:84532",
    chain: "Base Sepolia",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USD Coin (Circle test)",
    role: "direct x402 rail — autonomous Minds payments signed by the payer wallet",
  },
] as const;

async function readBalance(payer: string, asset: string, network: string): Promise<{ whole: string; atomic: string } | null> {
  const rpcUrl = rpcForChainId(network);
  if (!rpcUrl) return null;
  const data = `0x70a08231${payer.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: asset, data }, "latest"] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: string };
    if (!body.result || body.result === "0x") return { whole: "0.000000", atomic: "0" };
    const raw = BigInt(body.result);
    return { whole: `${raw / 1000000n}.${String(raw % 1000000n).padStart(6, "0")}`, atomic: raw.toString() };
  } catch {
    return null;
  }
}

export async function GET() {
  const payer = telegraphPayerAddress();
  if (!payer) {
    return NextResponse.json(
      { error: "No payer wallet is configured on this deployment (TELEGRAPH_EVM_PRIVATE_KEY missing) — autonomous Minds cannot pay." },
      { status: 503 },
    );
  }
  const rails = await Promise.all(
    PAYMENT_RAILS.map(async (rail) => ({
      ...rail,
      balance: await readBalance(payer, rail.asset, rail.network),
    })),
  );
  return NextResponse.json({ payer, rails });
}
