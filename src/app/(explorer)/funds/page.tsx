"use client";

import { createPortal } from "react-dom";

import { usePrivy, useWallets, useConnectWallet, useCreateWallet, useSendTransaction } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Wallet, Plus, LogOut, ArrowDownToLine, ArrowUpFromLine, X, Coins, RefreshCw } from "lucide-react";

import { SpendAllowance } from "@/components/wallet/spend-allowance";
import { WalletActivity } from "@/components/wallet/wallet-activity";

const SEPOLIA_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://rpc.sepolia.org",
  "https://eth-sepolia.api.onfinality.io/public",
];
const SEPOLIA_CHAIN_ID = 11155111;
const CIRCLE_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TELEGRAPH_USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";

async function rpc(method: string, params: unknown[]): Promise<string | null> {
  for (const url of SEPOLIA_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (data.result) return data.result as string;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fetchEthBalance(address: string): Promise<string | null> {
  const result = await rpc("eth_getBalance", [address, "latest"]);
  // null means "could not read", not "zero": showing 0 for a failed read is
  // what made a funded wallet look empty.
  if (!result) return null;
  const eth = Number(BigInt(result)) / 1e18;
  return eth.toFixed(6).replace(/\.?0+$/, "") || "0";
}

async function fetchTokenBalance(address: string, token: string): Promise<string | null> {
  const data = `0x70a08231${address.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  const result = await rpc("eth_call", [{ to: token, data }, "latest"]);
  if (!result) return null;
  if (result === "0x") return "0";
  const raw = BigInt(result);
  const val = Number(raw) / 1e6;
  return val.toFixed(2).replace(/\.?0+$/, "") || "0";
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

type Balances = { eth: string | null; circle: string | null; telegraph: string | null };

/**
 * THE wallet summary card. The page renders exactly one of these: the
 * wallet that signs in and owns files (the in-app wallet when it exists,
 * otherwise the connected one). Any second wallet collapses into a compact
 * row beneath it — never a second card repeating the same presentation.
 */
function WalletCard({
  label,
  address,
  ethBalance,
  circleUsdc,
  telegraphUsdc,
  syncing,
  lastSynced,
  onDeposit,
  onWithdraw,
  onMint,
  minting,
  onRefresh,
}: {
  label: string;
  address: string;
  ethBalance: string | null;
  circleUsdc: string | null;
  telegraphUsdc: string | null;
  syncing?: boolean;
  lastSynced?: number | null;
  onDeposit?: () => void;
  onWithdraw?: () => void;
  onMint?: () => void;
  minting?: boolean;
  onRefresh?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  const syncedAgo = lastSynced ? Math.max(0, Math.round((Date.now() - lastSynced) / 1000)) : null;
  const syncedLabel =
    syncedAgo === null
      ? "syncing…"
      : syncedAgo < 5
        ? "just now"
        : syncedAgo < 90
          ? `${syncedAgo}s ago`
          : `${Math.round(syncedAgo / 60)}m ago`;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-edge bg-panel p-6 shadow-sm">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal/40 to-transparent" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">{label}</p>
          <p className="mt-1 tabular text-[12.5px] text-ink-soft">{shortAddr(address)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh balances"
              title={`Balances auto-sync every 15s · updated ${syncedLabel}`}
              className="grid h-8 w-8 place-items-center rounded-full text-ink-faint transition-colors hover:bg-panel-2 hover:text-ink"
            >
              <RefreshCw size={13} strokeWidth={1.8} className={syncing ? "motion-safe:animate-spin" : ""} />
            </button>
          )}
          <div className="grid h-9 w-9 place-items-center rounded-full bg-teal/10 text-teal">
            <Wallet size={16} strokeWidth={1.8} />
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <div>
          <p className="text-[28px] font-semibold tabular leading-none tracking-tight text-ink">
            {circleUsdc === null ? "…" : circleUsdc}
          </p>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">USDC (Circle)</p>
        </div>
        <div>
          <p className="text-[18px] font-medium tabular leading-none text-ink">
            {telegraphUsdc === null ? "…" : telegraphUsdc}
          </p>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">Telegraph USDC</p>
        </div>
        <div>
          <p className="text-[18px] font-medium tabular leading-none text-ink-soft">
            {ethBalance === null ? "…" : ethBalance}
          </p>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">ETH</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">
        Sepolia · auto-syncs every 15s · updated {syncedLabel}
        {onMint ? " · the test mint is free, no gas needed" : ""}
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-teal hover:text-ink"
        >
          {copied ? <Check size={13} className="text-teal" /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy address"}
        </button>
        {onMint && (
          <button
            type="button"
            onClick={onMint}
            disabled={minting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-teal/40 bg-teal/10 px-3 py-1.5 text-[12px] text-teal transition-colors hover:bg-teal/15 disabled:opacity-50"
          >
            <Coins size={13} />
            {minting ? "Minting…" : "Mint 10 test USDC + spend credit"}
          </button>
        )}
        {onDeposit && (
          <button
            type="button"
            onClick={onDeposit}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-teal hover:text-ink"
          >
            <ArrowDownToLine size={13} />
            Deposit
          </button>
        )}
        {onWithdraw && (
          <button
            type="button"
            onClick={onWithdraw}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-teal hover:text-ink"
          >
            <ArrowUpFromLine size={13} />
            Withdraw
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The second wallet, when one exists: a compact row, not a second summary
 * card. It repeats no card chrome — address once, balances inline once.
 */
function SecondaryWalletRow({
  kind,
  address,
  balances,
}: {
  kind: "in-app" | "connected";
  address: string;
  balances: Balances | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-edge bg-panel-3 px-4 py-2.5">
      <p className="min-w-0 text-[12px] text-ink-soft">
        Also connected · {kind === "in-app" ? "in-app wallet" : "external wallet"}{" "}
        <span className="tabular text-ink">{shortAddr(address)}</span>
      </p>
      <p className="tabular text-[11.5px] text-ink-faint">
        {balances?.circle ?? "…"} USDC · {balances?.telegraph ?? "…"} Telegraph USDC · {balances?.eth ?? "…"} ETH
      </p>
    </div>
  );
}

function WithdrawModal({
  fromAddress,
  onClose,
  onSent,
}: {
  fromAddress: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const { sendTransaction } = useSendTransaction();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setHash(null);
    if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
      setErr("Enter a valid 0x address.");
      return;
    }
    const eth = Number(amount);
    if (!Number.isFinite(eth) || eth <= 0) {
      setErr("Enter an amount greater than 0.");
      return;
    }
    const wei = BigInt(Math.round(eth * 1e18));
    setSending(true);
    try {
      const result = await sendTransaction(
        { to: to as `0x${string}`, value: wei, chainId: SEPOLIA_CHAIN_ID },
        { address: fromAddress },
      );
      setHash(result.hash);
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  return (
createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-night/60 p-4 backdrop-blur-sm" onClick={onClose}>
      {/* Dialogs fit the viewport and scroll internally — never off-screen. */}
      <div
        className="x-modal-panel w-full max-w-sm rounded-2xl border border-edge bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-[14px] font-medium text-ink">Withdraw</p>
          <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:text-ink">
            <X size={15} />
          </button>
        </div>
        <p className="mt-1 text-[12px] text-ink-faint">Send Sepolia ETH from your in-app wallet.</p>

        <label className="mt-4 block">
          <span className="text-[11px] uppercase tracking-wider text-ink-faint">To address</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value.trim())}
            placeholder="0x…"
            className="mt-1 w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 tabular text-[13px] text-ink placeholder:text-ink-faint focus:border-teal/50 focus:outline-none"
          />
        </label>
        <label className="mt-3 block">
          <span className="text-[11px] uppercase tracking-wider text-ink-faint">Amount (ETH)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.01"
            inputMode="decimal"
            className="mt-1 w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 tabular text-[13px] text-ink placeholder:text-ink-faint focus:border-teal/50 focus:outline-none"
          />
        </label>

        {err && <p className="mt-3 text-[12px] text-risk">{err}</p>}
        {hash && (
          <p className="mt-3 break-all text-[12px] text-teal">
            Sent. Tx: {hash.slice(0, 10)}…
          </p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={sending}
          className="btn-primary mt-4 w-full !min-h-10 disabled:opacity-60"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  , document.body)
);
}

interface CreditEntryView {
  ts: number;
  deltaUsdCents: number;
  balanceAfterUsdCents: number;
  label: string;
}

/**
 * THE user's own spend wallet: the in-app credit balance paid runs settle
 * against, with the history of what it actually paid for. This is the answer
 * to "which wallet pays?" — yours, not the deployment's.
 */
function CreditCard({ sessionSignedIn }: { sessionSignedIn: boolean }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [entries, setEntries] = useState<CreditEntryView[]>([]);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/wallet/credits", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (res.status === 401) {
        setFailed(false);
        setBalance(null);
        setEntries([]);
        return;
      }
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const body = (await res.json()) as { balanceUsdCents?: number; entries?: CreditEntryView[] };
      setBalance(typeof body.balanceUsdCents === "number" ? body.balanceUsdCents : 0);
      setEntries(Array.isArray(body.entries) ? body.entries.slice(0, 6) : []);
      setFailed(false);
    } catch {
      /* transient — the next poll retries; the last good values stay */
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 15_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const when = (ts: number) =>
    new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="relative overflow-hidden rounded-2xl border border-teal/30 bg-panel p-6 shadow-sm">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal/40 to-transparent" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
            In-app spend credit · YOUR wallet pays for every run
          </p>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            {sessionSignedIn
              ? "Paid asks (Terminal, Minds, Deal Desk) settle from this balance — never from the deployment's wallet."
              : "Sign in with your wallet to hold and spend your own credit."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh spend credit"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-panel-2 hover:text-ink"
        >
          <RefreshCw size={13} strokeWidth={1.8} className={syncing ? "motion-safe:animate-spin" : ""} />
        </button>
      </div>

      <p className="mt-5 text-[28px] font-semibold tabular leading-none tracking-tight text-ink">
        {sessionSignedIn ? (balance === null ? "…" : usd(balance)) : "—"}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        Funded by the faucet mint below (10.00 of credit alongside the 10 on-chain test USDC). A run's daily cap on
        faucet-funded spending still applies. {sessionSignedIn ? "Balances update every 15s." : ""}
      </p>

      {sessionSignedIn && failed && (
        <p className="mt-3 text-[12px] text-amber">The credit ledger could not be read — retrying.</p>
      )}
      {sessionSignedIn && !failed && entries.length > 0 && (
        <ul className="mt-4 divide-y divide-edge/60 border-t border-edge/60">
          {entries.map((e, i) => (
            <li key={`${e.ts}:${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-soft" title={e.label}>
                {e.label}
              </span>
              <span className="text-[10.5px] text-ink-faint">{when(e.ts)}</span>
              <span className={`tabular w-16 text-right text-[12px] ${e.deltaUsdCents >= 0 ? "text-teal" : "text-ink"}`}>
                {e.deltaUsdCents >= 0 ? "+" : "−"}
                {usd(Math.abs(e.deltaUsdCents))}
              </span>
              <span className="tabular w-16 text-right text-[10.5px] text-ink-faint">{usd(e.balanceAfterUsdCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface PayerRail {
  network: string;
  chain: string;
  name: string;
  role: string;
  balance: { whole: string; atomic: string } | null;
}

/**
 * The deployment payer wallet — the one whose funds every autonomous paid
 * run actually spends (Terminal, Minds, Deal Desk; the per-user cap only
 * meters against it). Fed by GET /api/wallet/balance, the same public
 * eth_call reads the verification step uses. A failed read stays "…", never
 * zero, so a flaky RPC never makes a funded wallet look empty. Presented as
 * spending context, not as a second wallet summary card.
 */
function PayerCard({ sessionSignedIn }: { sessionSignedIn: boolean }) {
  const [rails, setRails] = useState<PayerRail[] | null>(null);
  const [payer, setPayer] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/wallet/balance", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => ({}))) as { payer?: string; rails?: PayerRail[]; error?: string };
      if (!res.ok) {
        setNote(body.error ?? `The payer wallet could not be read (status ${res.status}).`);
        return;
      }
      setPayer(body.payer ?? null);
      setRails(body.rails ?? []);
      setNote(null);
      setLastSynced(Date.now());
    } catch {
      /* transient — the next poll retries; the last good values stay */
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 20_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const syncedAgo = lastSynced ? Math.max(0, Math.round((Date.now() - lastSynced) / 1000)) : null;
  const syncedLabel =
    syncedAgo === null ? "syncing…" : syncedAgo < 5 ? "just now" : syncedAgo < 90 ? `${syncedAgo}s ago` : `${Math.round(syncedAgo / 60)}m ago`;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-amber/30 bg-panel p-6 shadow-sm">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/40 to-transparent" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Deployment settlement rail · free modes & operator runs</p>
          <p className="mt-1 tabular text-[12.5px] text-ink-soft">{payer ? shortAddr(payer) : "…"}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh payer balances"
          title={`Auto-syncs every 20s · updated ${syncedLabel}`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-panel-2 hover:text-ink"
        >
          <RefreshCw size={13} strokeWidth={1.8} className={syncing ? "motion-safe:animate-spin" : ""} />
        </button>
      </div>

      {note ? (
        <p className="mt-4 text-[12.5px] leading-relaxed text-amber">{note}</p>
      ) : (
        <dl className="mt-5 grid gap-4 sm:grid-cols-2">
          {(rails ?? []).map((rail) => (
            <div key={rail.network} className="rounded-xl border border-edge bg-panel-2 px-4 py-3">
              <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                {rail.chain} · {rail.name}
              </dt>
              <dd className="tabular mt-1 text-[20px] font-semibold leading-none text-ink">
                {rail.balance === null ? "…" : rail.balance.whole}
              </dd>
              <dd className="mt-1.5 text-[10.5px] leading-snug text-ink-faint">{rail.role}</dd>
            </div>
          ))}
          {(rails ?? []).length === 0 && <dd className="text-[12px] text-ink-faint">Reading both payment rails…</dd>}
        </dl>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
        Your paid runs settle from YOUR in-app spend credit above — not from this wallet. This deployment rail remains
        what free modes and the operator session consume on-chain. Auto-syncs every 20s · updated {syncedLabel}.
        {!sessionSignedIn && " The balances are live on-chain reads; sign in to relate them to your runs."}
      </p>
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
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, Balances>>({});
  const [showDeposit, setShowDeposit] = useState<string | null>(null);
  const [showWithdraw, setShowWithdraw] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const external = wallets.find((w) => w.walletClientType !== "privy");

  // One sync function for every trigger (mount, wallet change, poll, focus,
  // mint/withdraw callbacks). A failed read stays "…" until the next cycle —
  // never shown as zero, which is what made funded wallets look empty.
  const refreshBalances = useCallback(async () => {
    const addrs = [embedded?.address, external?.address].filter(Boolean) as string[];
    if (addrs.length === 0) return;
    setSyncing(true);
    try {
      for (const addr of addrs) {
        const [eth, circle, telegraph] = await Promise.all([
          fetchEthBalance(addr),
          fetchTokenBalance(addr, CIRCLE_USDC),
          fetchTokenBalance(addr, TELEGRAPH_USDC),
        ]);
        setBalances((prev) => ({ ...prev, [addr]: { eth, circle, telegraph } }));
      }
      setLastSynced(Date.now());
    } finally {
      setSyncing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded?.address, external?.address]);

  useEffect(() => {
    void refreshBalances();
    // Live sync: poll while the page is open, and refresh the moment the tab
    // regains focus (mobile users return to a stale card otherwise).
    const poll = setInterval(() => void refreshBalances(), 15_000);
    const onFocus = () => void refreshBalances();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshBalances]);

  // Keeps "updated Ns ago" honest between polls.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  const handleMint = async () => {
    if (!embedded) return;
    setError(null);
    setNotice(null);
    setMinting(true);
    try {
      // The faucet mints from the server key, so the new wallet needs no ETH.
      const res = await fetch("/api/wallet/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: embedded.address }),
      });
      const data = (await res.json()) as { error?: string };
      if (res.status === 409) {
        setNotice(data.error ?? "This wallet already holds test USDC — spend credit topped up instead.");
        void refreshBalances();
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Mint failed");
      setNotice("10 test USDC minted and 10.00 of in-app spend credit added — balances update in a moment.");
      setTimeout(refreshBalances, 3000);
      setTimeout(refreshBalances, 8000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mint failed");
    } finally {
      setMinting(false);
    }
  };

  const handleCreateInApp = async () => {
    setError(null);
    setCreating(true);
    try {
      if (!authenticated) await login();
      let tries = 0;
      while (!authenticated && tries < 20) {
        await new Promise((r) => setTimeout(r, 150));
        tries++;
      }
      if (!authenticated) {
        setError("Log in first, then create the wallet.");
        return;
      }
      if (!embedded) await createWallet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not create in-app wallet";
      if (!/must be authenticated/i.test(msg) || !embedded) setError(msg);
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
        <p aria-live="polite" className="text-[13px] text-ink-faint">Loading wallet…</p>
      </div>
    );
  }

  const hasEmbedded = !!embedded;
  // Exactly ONE summary card: the identity wallet (in-app) wins; a connected
  // external wallet is the summary card only when no in-app wallet exists.
  const primary = embedded ?? external;
  const secondary = primary === embedded ? external : embedded;
  const secondaryKind = secondary === embedded ? "in-app" : "connected";

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="x-tag">WALLET</p>
          <h1 className="x-display-1 mt-3 text-ink">Wallet</h1>
        </div>
        {(embedded || external) && (
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-panel px-3.5 py-2 text-[13px] text-ink-soft transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-50"
          >
            <LogOut size={14} strokeWidth={1.8} />
            {loggingOut ? "…" : "Log out"}
          </button>
        )}
      </div>

      {/* ONE wallet summary card. A second wallet, when present, is a compact
          row — never a second card repeating the same presentation. */}
      <section aria-label="Wallet summary" className="mt-6 space-y-3">
        {primary ? (
          <>
            <WalletCard
              label={
                primary === embedded
                  ? "In-app wallet · your identity — buyer purchases sign from it on-chain"
                  : "Connected wallet · your identity — buyer purchases sign from it on-chain"
              }
              address={primary.address}
              ethBalance={balances[primary.address]?.eth ?? null}
              circleUsdc={balances[primary.address]?.circle ?? null}
              telegraphUsdc={balances[primary.address]?.telegraph ?? null}
              syncing={syncing}
              lastSynced={lastSynced}
              onDeposit={primary === embedded ? () => setShowDeposit(primary.address) : undefined}
              onWithdraw={primary === embedded ? () => setShowWithdraw(primary.address) : undefined}
              onMint={primary === embedded ? handleMint : undefined}
              minting={minting}
              onRefresh={() => void refreshBalances()}
            />
            {secondary && (
              <SecondaryWalletRow
                kind={secondaryKind}
                address={secondary.address}
                balances={balances[secondary.address]}
              />
            )}
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-edge bg-panel px-6 py-8">
            <p className="text-[14px] font-medium text-ink">No wallet connected yet.</p>
            <p className="mt-1.5 max-w-[52ch] text-[12.5px] leading-relaxed text-ink-soft">
              Create an in-app wallet that stays with your account, or connect MetaMask, WalletConnect or another
              external wallet. Balances appear here once one exists.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={handleCreateInApp} disabled={creating} className="btn-primary !min-h-9 !px-4 disabled:opacity-60">
                <Plus size={13} aria-hidden />
                {creating ? "Creating…" : "Create in-app wallet"}
              </button>
              <button type="button" onClick={handleConnectExternal} className="btn-quiet !min-h-9 !px-4">
                <Wallet size={13} aria-hidden />
                Connect wallet
              </button>
            </div>
          </div>
        )}
        {primary && !hasEmbedded && (
          <button
            type="button"
            onClick={handleCreateInApp}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-teal hover:text-ink disabled:opacity-50"
          >
            <Plus size={12} aria-hidden />
            {creating ? "Creating…" : "Create the in-app wallet"}
          </button>
        )}
      </section>

      {/* Spending: the payer wallet that funds autonomous runs + the enforced
          per-user allowance. Both keep their existing APIs. */}
      <section aria-label="Spending controls" className="mt-8 space-y-4">
        <h2 className="x-label !mt-0">SPENDING</h2>
        <CreditCard sessionSignedIn={!!primary} />
        <PayerCard sessionSignedIn={!!primary} />
        <SpendAllowance />
      </section>

      {/* Transactions and receipts: one component, both real ledgers. */}
      <section aria-label="Wallet activity" className="mt-8">
        <WalletActivity />
      </section>

      {error && (
        <p className="mt-6 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-[12.5px] text-risk">{error}</p>
      )}
      {notice && (
        <p className="mt-4 rounded-lg border border-teal/30 bg-teal/5 px-3 py-2 text-[12.5px] text-teal">{notice}</p>
      )}

      {showDeposit &&
        createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-night/60 p-4 backdrop-blur-sm" onClick={() => setShowDeposit(null)}>
          <div
            className="x-modal-panel w-full max-w-sm rounded-2xl border border-edge bg-panel p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="text-[14px] font-medium text-ink">Deposit</p>
              <button type="button" onClick={() => setShowDeposit(null)} className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:text-ink">
                <X size={15} />
              </button>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
              Send Sepolia ETH (for gas). Asks are paid in Telegraph USDC.
            </p>
            <p className="mt-3 break-all rounded-lg bg-panel-2 px-3 py-2 tabular text-[12px] text-ink">{showDeposit}</p>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(showDeposit);
                setShowDeposit(null);
              }}
              className="btn-primary mt-4 w-full !min-h-10"
            >
              Copy address
            </button>
          </div>
        </div>
        , document.body)
      }

      {showWithdraw && (
        <WithdrawModal
          fromAddress={showWithdraw}
          onClose={() => setShowWithdraw(null)}
          onSent={() => {
            setTimeout(refreshBalances, 3000);
          }}
        />
      )}
    </div>
  
);
}
