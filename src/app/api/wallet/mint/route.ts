import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { paidCredentialsConfigured } from "@/lib/telegraph/client";
import { FAUCET_CREDIT_USD_CENTS, grantCredits } from "@/lib/wallet/credits";

/**
 * POST /api/wallet/mint — give a connected wallet 10 test USDC.
 *
 * The token's mint is open, so the payer key can mint on the user's behalf and
 * cover the gas. That is the point: a new in-app wallet has no Sepolia ETH, and
 * asking someone to find a faucet before they can try the product is a dead end.
 */

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const TELEGRAPH_USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17" as const;
const MINT_AMOUNT = 10_000_000n; // 10 USDC at 6 decimals

const abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const recentMints = new Map<string, number>();
const COOLDOWN_MS = 60_000;

export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { address?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const input = body.address?.trim();
  // Accept any hex address, not only one with a valid EIP-55 checksum.
  if (!input || !isAddress(input, { strict: false })) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  const address = getAddress(input);

  const key = process.env.TELEGRAPH_EVM_PRIVATE_KEY;
  if (!paidCredentialsConfigured() || !key) {
    return NextResponse.json(
      { error: "The test faucet is not configured on this deployment." },
      { status: 503 },
    );
  }

  const keyName = address.toLowerCase();
  const last = recentMints.get(keyName) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    return NextResponse.json({ error: "This wallet was just topped up. Try again in a minute." }, { status: 429 });
  }

  try {
    const account = privateKeyToAccount(key as `0x${string}`);
    const transport = http(RPC);
    const publicClient = createPublicClient({ chain: sepolia, transport });
    const walletClient = createWalletClient({ account, chain: sepolia, transport });

    const balance = await publicClient.readContract({
      address: TELEGRAPH_USDC,
      abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });
    if (balance > 0n) {
      // Already funded on-chain — the faucet still tops up the in-app spend
      // credit (the 60s cooldown above and the per-user daily cap keep this
      // from being a farm; the cap bounds what credit can actually spend).
      const ledger = await grantCredits(address, FAUCET_CREDIT_USD_CENTS, "Faucet top-up — in-app spend credit");
      return NextResponse.json(
        {
          error: "This wallet already holds test USDC — the in-app spend credit was topped up instead.",
          creditsGrantedUsdCents: FAUCET_CREDIT_USD_CENTS,
          creditBalanceUsdCents: ledger.balanceUsdCents,
        },
        { status: 409 },
      );
    }

    const hash = await walletClient.writeContract({
      address: TELEGRAPH_USDC,
      abi,
      functionName: "mint",
      args: [address as `0x${string}`, MINT_AMOUNT],
    });
    recentMints.set(keyName, Date.now());
    const ledger = await grantCredits(address, FAUCET_CREDIT_USD_CENTS, "Faucet mint — in-app spend credit");

    return NextResponse.json({
      hash,
      amount: "10",
      creditsGrantedUsdCents: FAUCET_CREDIT_USD_CENTS,
      creditBalanceUsdCents: ledger.balanceUsdCents,
    });
  } catch (err) {
    const message =
      err && typeof err === "object" && "shortMessage" in err
        ? String((err as { shortMessage: unknown }).shortMessage)
        : err instanceof Error
          ? err.message
          : "Mint failed";
    return NextResponse.json({ error: message.slice(0, 240) }, { status: 502 });
  }
}
