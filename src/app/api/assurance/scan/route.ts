import { NextRequest, NextResponse } from "next/server";

import { inspectMint, inspectWallet, isValidSolanaAddress, SolanaReadError } from "@/lib/assurance/solana";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface ScanBody {
  address?: unknown;
  mint?: unknown;
}

/**
 * POST /api/assurance/scan — the free Wallet Exposure scan.
 *
 * Real, read-only Solana RPC for one address: existence, SOL balance, SPL
 * token accounts (with the USDC balance called out), recent activity window.
 * No file is opened, nothing is stored, nothing is spent; provenance (rpc,
 * slot, readAt) travels with the result so the caller can re-derive it.
 */
export async function POST(req: NextRequest) {
  let body: ScanBody;
  try {
    body = (await req.json()) as ScanBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  const mint = typeof body.mint === "string" && body.mint.trim() ? body.mint.trim() : USDC_MINT_MAINNET;

  if (!address) return NextResponse.json({ error: "an address is required" }, { status: 400 });
  if (!isValidSolanaAddress(address)) {
    return NextResponse.json({ error: "that is not a valid Solana address" }, { status: 400 });
  }
  if (!isValidSolanaAddress(mint)) {
    return NextResponse.json({ error: "the token mint is not a valid Solana address" }, { status: 400 });
  }

  try {
    const [wallet, mintInfo] = await Promise.all([inspectWallet(address, mint), inspectMint(mint)]);
    const usdcAccount = wallet.tokenAccounts.find((a) => a.mint === mint) ?? null;
    return NextResponse.json({
      wallet: {
        address: wallet.address,
        valid: wallet.valid,
        exists: wallet.exists,
        solBalance: wallet.solBalance,
        lamports: wallet.lamports,
        tokenAccountCount: wallet.tokenAccounts.length,
        mintBalance: usdcAccount
          ? {
              uiAmount: usdcAccount.uiAmount,
              raw: usdcAccount.amountRaw,
              decimals: usdcAccount.decimals,
              owner: usdcAccount.owner,
            }
          : null,
        recentSignatures: wallet.signatures.length,
        newestActivity: wallet.newestSignatureBlockTime,
        oldestActivity: wallet.oldestSignatureBlockTime,
        historyUnavailable: wallet.historyUnavailable ?? null,
      },
      mint: {
        address: mintInfo.address,
        decimals: mintInfo.decimals,
        supply: mintInfo.supply,
        mintAuthority: mintInfo.mintAuthority,
        freezeAuthority: mintInfo.freezeAuthority,
        isInitialized: mintInfo.isInitialized,
      },
      provenance: { rpcUrl: wallet.rpcUrl, slot: wallet.slot, readAt: wallet.readAt, cluster: process.env.SOLANA_RPC_URL ? "configured" : "public mainnet" },
      note:
        "Read-only inspection of live Solana state. Existence and balances are facts; history is best-effort from a public RPC and is not proof of absence of activity.",
    });
  } catch (err) {
    const detail = err instanceof SolanaReadError ? err.message : err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Solana read failed: ${detail}` }, { status: 502 });
  }
}
