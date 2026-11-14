"use client";

import { usePrivy, useWallets, useConnectWallet, useCreateWallet } from "@privy-io/react-auth";
import { useEffect, useState } from "react";
import { Copy, Check, Wallet, Plus, LogOut } from "lucide-react";

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

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="relative overflow-hidden rounded-2xl border border-edge bg-panel p-6 shadow-sm">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal/40 to-transparent" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">{label}</p>
          <button
            type="button"
            onClick={copy}
            className="mt-1.5 flex items-center gap-1.5 tabular text-[12.5px] text-ink-soft transition-colors hover:text-ink"
          >
            {shortAddr(address)}
            {copied ? <Check size={12} className="text-teal" /> : <Copy size={12} className="opacity-50" />}
          </button>
        </div>
        <div className="grid h-9 w-9 place-items-center rounded-full bg-teal/10 text-teal">
          <Wallet size={16} strokeWidth={1.8} />
        </div>
      </div>
      <p className="mt-5 text-[32px] font-semibold tabular leading-none tracking-tight text-ink">
        {balance === null ? "…" : balance}
        <span className="ml-1.5 text-[15px] font-medium text-ink-soft">ETH</span>
      </p>
      <p className="mt-1.5 text-[11px] text-ink-faint">Sepolia testnet</p>
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
        if (!cancelled) setBalances((prev) => ({ ...prev, [addr]: bal }));
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
        await login();
      }
      // Privy session must be fully settled before createWallet is allowed.
      // Poll briefly; the previous 300ms delay was not always enough.
      let tries = 0;
      while (!authenticated && tries < 20) {
        await new Promise((r) => setTimeout(r, 150));
        tries++;
      }
      if (!authenticated) {
        setError("Log in first, then create the wallet.");
        return;
      }
      // If an embedded wallet already exists for this account, do nothing.
      if (!embedded) {
        await createWallet();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not create in-app wallet";
      // Swallow the race-condition message if a wallet actually appeared.
      if (!/must be authenticated/i.test(msg) || !embedded) {
        setError(msg);
      }
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

  const hasWallet = !!(embedded || external);
  const hasEmbedded = !!embedded;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="x-tag">WALLET</p>
      <h1 className="x-display-1 mt-3 text-ink">Wallet</h1>

      {hasWallet && (
        <div className="mt-6 space-y-3">
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
          <div className="flex items-center justify-between pt-1">
            <p className="text-[11.5px] text-ink-faint">
              Logging out and back in with the same method restores this wallet.
            </p>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-panel px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-50"
            >
              <LogOut size={12} strokeWidth={1.8} />
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          </div>
        </div>
      )}

      <p className="mt-8 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
        {hasEmbedded
          ? "Your in-app wallet is ready. Connect an external wallet if you also want one."
          : hasWallet
            ? "Connect another wallet, or create an in-app one."
            : "Connect an existing wallet, or create an in-app wallet that stays with your account."}
      </p>

      <div className={`mt-4 grid gap-4 ${hasEmbedded ? "sm:grid-cols-1" : "sm:grid-cols-2"}`}>
        <button
          type="button"
          onClick={handleConnectExternal}
          className="group rounded-2xl border border-edge bg-panel p-5 text-left transition-all hover:border-teal hover:shadow-sm"
        >
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-panel-2 text-ink-soft group-hover:text-teal">
              <Wallet size={14} strokeWidth={1.8} />
            </span>
            <p className="text-[13.5px] font-medium text-ink">Connect wallet</p>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
            Use MetaMask, WalletConnect, or another external wallet.
          </p>
        </button>

        {!hasEmbedded && (
          <button
            type="button"
            onClick={handleCreateInApp}
            disabled={creating}
            className="group rounded-2xl border border-edge bg-panel p-5 text-left transition-all hover:border-teal hover:shadow-sm disabled:opacity-60"
          >
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-panel-2 text-ink-soft group-hover:text-teal">
                <Plus size={14} strokeWidth={1.8} />
              </span>
              <p className="text-[13.5px] font-medium text-ink">
                {creating ? "Creating…" : "Create in-app wallet"}
              </p>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
              Privy creates a wallet for your account. Log in with the same method later to get it back.
            </p>
          </button>
        )}
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-[12.5px] text-risk">{error}</p>
      )}
    </div>
  );
}
