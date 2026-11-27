import { NextResponse } from "next/server";

import { ACP_OFFERINGS } from "@/lib/acp/offerings";
import { acpConfig } from "@/lib/acp/transport";
import { acpProviderStatus } from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/acp/buyer/catalog — everything a buyer's browser needs to run the
 * REAL ACP buyer workflow against NIGHTSHIFT: the published offerings, the
 * provider wallet (public on the ACP server), the chain, and the on-chain
 * contract/USDC addresses the SDK's client prepares calls against. The
 * buyer's own wallet signs every transaction in their browser; no provider
 * credential is involved or exposed.
 */
export async function GET() {
  const cfg = acpConfig();
  const status = await acpProviderStatus();
  // The addresses come from the installed SDK's own registry — never
  // hard-coded here, so a protocol upgrade flows through automatically.
  let contracts: { acp: string; usdc: string } | null = null;
  try {
    const sdk = (await import("@virtuals-protocol/acp-node-v2")) as unknown as {
      ACP_CONTRACT_ADDRESSES: Record<number, string>;
      USDC_ADDRESSES: Record<number, string>;
    };
    contracts = {
      acp: sdk.ACP_CONTRACT_ADDRESSES[cfg.chainId] ?? "",
      usdc: sdk.USDC_ADDRESSES[cfg.chainId] ?? "",
    };
  } catch {
    contracts = null; // the browser bundle carries the same registry; the desk still renders
  }
  return NextResponse.json({
    offerings: ACP_OFFERINGS,
    provider: {
      walletAddress: cfg.walletAddress || status.agentWalletAddress,
      chainId: cfg.chainId,
      // Nightshift runs with no separate evaluator contract party: the BUYER
      // reviews the deliverable and releases the escrow themselves.
      evaluatorAddress: "0x0000000000000000000000000000000000000000",
      live: status.mode === "real" && status.connected === true,
      mode: status.mode,
    },
    contracts,
  });
}
