"use client";

import { usePrivy, useWallets, useConnectWallet, useCreateWallet } from "@privy-io/react-auth";
import { useEffect, useState } from "react";

const SEPOLIA_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://rpc.sepolia.org",
  "https://eth-sepolia.api.onfinality.io/public",
];

async function fetchEthBalance(address: string): Promise<string> {
  for (const rpc of SEPOLIA_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [address, "latest"],
        }),
      });
      const data = await res.json();
      if (data.result) {
        const wei = BigInt(data.result);
        const eth = Number(wei) / 1e18;
        return eth.toFixed(6).replace(/\.?0+$/, "") || "0";
      }
    } catch {
      /* try next */
    }
  }
  return "0";
}

function WalletCard({
  label,
  address,
  balance,
}: {
  label: string;
  address: string;
  balance: string | null;
}) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-5">
      <p className="x-label">{label}</p>
      <p className="tabular mt-1 break-all text-[11.5px] text-ink-faint">{address}</p>
      <p className="mt-3 text-[28px] font-semibold tabular leading-none text-ink">
        {balance === null ? "…" : balance}
        <span className="ml-1.5 text-[16px] font-medium text-ink-soft">ETH</span>
      </p>
      <p className="mt-1 text-[11px] text-ink-faint">Sepolia testnet</p>
    </div>
  );
}

export default function FundsPage() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const { createWallet } = useCreateWallet();
  const [creating, setCreating] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string | null>>({});

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const external = wallets.find((w) => w.walletClientType !== "privy");

  useEffect(() => {
    const addrs = [embedded?.address, external?.address].filter(Boolean) as string[];
    if (addrs.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const addr of addrs) {
        if (cancelled) return;
        const bal = await fetchEthBalance(addr);
        if (!cancelled) {
          setBalances((prev) => ({ ...prev, [addr]: bal }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embedded?.address, external?.address]);

  const handleCreateInApp = async () => {
    setError(null);
    setCreating(true);
    try {
      if (!authenticated) {
        // login() opens the modal and resolves when the user finishes
        await login();
      }
      // Give Privy a moment to settle the session if login just completed
      await new Promise((r) => setTimeout(r, 300));
      if (!embedded) {
        await createWallet();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not create in-app wallet";
      setError(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleConnectExternal = () => {
    setError(null);
    connectWallet();
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    setError(null);
    try {
      await logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logout failed");
    } finally {
      setLoggingOut(false);
    }
  };

  if (!ready) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <p className="text-[13px] text-ink-faint">Loading wallet…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="x-tag">WALLET</p>
      <h1 className="x-display-1 mt-3 text-ink">Wallet</h1>
      <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
        Pay for asks from your own wallet. Connect an existing one, or create an in-app wallet that stays in this browser.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={handleConnectExternal}
          className="rounded-lg border border-edge bg-panel p-5 text-left transition-colors hover:border-teal"
        >
          <p className="text-[13.5px] font-medium text-ink">Connect wallet</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            Use MetaMask, WalletConnect, or another external wallet.
          </p>
        </button>
        <button
          type="button"
          onClick={handleCreateInApp}
          disabled={creating}
          className="rounded-lg border border-edge bg-panel p-5 text-left transition-colors hover:border-teal disabled:opacity-60"
        >
          <p className="text-[13.5px] font-medium text-ink">
            {creating ? "Creating…" : "Create in-app wallet"}
          </p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            Privy creates a wallet for you. Fund it and pay from this browser.
          </p>
        </button>
      </div>

      {error && (
        <p className="mt-4 text-[12.5px] text-risk">{error}</p>
      )}

      {(embedded || external) && (
        <div className="mt-8 space-y-4">
          <p className="x-label">Your wallets</p>
          {embedded && (
            <WalletCard
              label="In-app wallet"
              address={embedded.address}
              balance={balances[embedded.address] ?? null}
            />
          )}
          {external && (
            <WalletCard
              label="Connected wallet"
              address={external.address}
              balance={balances[external.address] ?? null}
            />
          )}
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="btn-quiet !min-h-9 !px-4 !text-[13px]"
          >
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
          <p className="text-[12px] text-ink-faint">
            Balances are Sepolia testnet ETH. Fund the address with testnet USDC or ETH, then return to the terminal to pay for an ask.
          </p>
        </div>
      )}
    </div>
  );
}
