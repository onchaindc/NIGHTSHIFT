import { NextResponse } from "next/server";

import { userAddressFromRequest } from "@/lib/api/auth";
import { creditHistoryFor } from "@/lib/wallet/credits";

/**
 * GET /api/wallet/credits — the signed-in wallet's own in-app spend credit:
 * the balance paid runs settle against, and the history of every top-up and
 * every debit (what the wallet actually paid for). Anonymous callers get 401:
 * credits belong to a session wallet, there is no "global" balance.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const address = userAddressFromRequest(req);
  if (!address) {
    return NextResponse.json(
      { error: "sign in with your wallet to read its spend credit" },
      { status: 401 },
    );
  }
  const ledger = await creditHistoryFor(address);
  return NextResponse.json({
    address,
    balanceUsdCents: ledger.balanceUsdCents,
    entries: ledger.entries,
  });
}
