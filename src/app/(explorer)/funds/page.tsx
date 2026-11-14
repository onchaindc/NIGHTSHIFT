"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useState } from "react";

export default function FundsPage() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const [mode, setMode] = useState<"choose" | "connect" | "create">("choose");

  if (!ready) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <p className="text-[13px] text-ink-faint">Loading funds…</p>
      </div>
    );
  }

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const external = wallets.find((w) => w.walletClientType !== "privy");

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="x-tag">FUNDS</p>
      <h1 className="x-display-1 mt-3 text-ink">Funds</h1>
      <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
        Pay for asks from your own wallet. Connect an existing one, or create an in-app wallet.
      </p>

      {!authenticated ? (
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <button
            onClick={() => { setMode("connect"); login(); }}
            className="rounded-lg border border-edge bg-panel p-5 text-left transition-colors hover:border-teal"
          >
            <p className="text-[13.5px] font-medium text-ink">Connect wallet</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
              Use MetaMask, WalletConnect, or another external wallet.
            </p>
          </button>
          <button
            onClick={() => { setMode("create"); login(); }}
            className="rounded-lg border border-edge bg-panel p-5 text-left transition-colors hover:border-teal"
          >
            <p className="text-[13.5px] font-medium text-ink">Create in-app wallet</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
              Privy creates a wallet for you. Fund it and pay from this browser.
            </p>
          </button>
        </div>
      ) : (
        <div className="mt-10 space-y-6">
          <div className="rounded-lg border border-edge bg-panel p-5">
            <p className="x-label">Active</p>
            {embedded && (
              <p className="tabular mt-2 break-all text-[12.5px] text-ink">
                In-app: {embedded.address}
              </p>
            )}
            {external && (
              <p className="tabular mt-2 break-all text-[12.5px] text-ink">
                Connected: {external.address}
              </p>
            )}
            {!embedded && !external && (
              <p className="mt-2 text-[12.5px] text-ink-soft">No wallet yet. Log in again to create or connect one.</p>
            )}
            <button onClick={logout} className="btn-quiet mt-4 !min-h-8 !text-[12px]">
              Log out
            </button>
          </div>
          <p className="text-[12px] text-ink-faint">
            Fund the address above with testnet USDC on Sepolia, then return to the terminal to pay for an ask.
          </p>
        </div>
      )}
    </div>
  );
}
