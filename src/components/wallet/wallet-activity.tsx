"use client";

/**
 * Wallet activity: the money movements and their receipts, merged from the
 * two real ledgers this deployment writes —
 *
 *   · the engine spend ledger (/api/tasks): every Telegraph ask that settled,
 *     with its receipt hash, settlement tx and signal hash;
 *   · the buyer escrow ledger (/api/acp/buyer/jobs): every ACP purchase the
 *     signed-in wallet opened on Base, with its on-chain transaction hashes.
 *
 * Nothing here is synthesized: an entry exists only because the corresponding
 * record was written by the run or the purchase itself. The signed-in wallet's
 * session decides what either API returns; a failed fetch says so instead of
 * rendering an empty-looking history.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ReceiptText, RefreshCw } from "lucide-react";

import type { TaskRecord } from "@/lib/engine/types";
import { activityTitle } from "@/lib/terminal/activity";
import type { BuyerJobView } from "@/lib/acp/buyer";

/** The explorer for the chain the payment actually settled on. */
const EXPLORERS: Record<string, string> = {
  "eip155:11155111": "https://sepolia.etherscan.io/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:1": "https://etherscan.io/tx/",
};

function txHref(hash: string | null | undefined, network: string | undefined | null): string | null {
  if (!hash) return null;
  const base = network ? EXPLORERS[network] : undefined;
  return base ? `${base}${hash}` : null;
}

function baseTxHref(chainId: number, hash: string | null | undefined): string | null {
  if (!hash) return null;
  // ACP purchasing is Base-only by chain discipline; 84532 is its testnet.
  const base = chainId === 84532 ? "https://sepolia.basescan.org/tx/" : "https://basescan.org/tx/";
  return `${base}${hash}`;
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : hash;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function when(ts: number): string {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface AskTx {
  kind: "ask";
  key: string;
  ts: number;
  label: string;
  taskId: string;
  amountCents: number;
  txHash?: string;
  network?: string;
  receiptHash?: string;
  signalHash?: string;
}

interface BuyerTx {
  kind: "buyer";
  key: string;
  ts: number;
  label: string;
  jobId: string;
  chainId: number;
  priceCents: number | null;
  phaseLabel: string;
  createdTx: string | null;
  allowanceTx: string | null;
  fundedTx: string | null;
  releasedTx: string | null;
}

type WalletTx = AskTx | BuyerTx;

interface ReceiptRow {
  key: string;
  ts: number;
  label: string;
  receiptHash: string;
  signalHash: string | null;
  /** The settlement tx this receipt proves, plus the chain it settled on. */
  txHash: string | null;
  network: string | null;
  /** Buyer-escrow receipts resolve through the job's chain id instead. */
  buyerChainId?: number;
  /** Where the full record lives, when one exists. */
  recordHref: string | null;
  amountCents: number;
}

function buyerCents(job: BuyerJobView): number | null {
  const raw = job.provider?.priceUsdCents;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export function WalletActivity() {
  const [asks, setAsks] = useState<AskTx[] | null>(null);
  const [jobs, setJobs] = useState<BuyerTx[] | null>(null);
  const [asksFailed, setAsksFailed] = useState(false);
  const [jobsFailed, setJobsFailed] = useState(false);
  const [jobsPrivate, setJobsPrivate] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    let asksOk = true;
    let jobsOk = true;
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      if (!res.ok) {
        asksOk = false;
      } else {
        const body = (await res.json()) as { tasks?: TaskRecord[] };
        const rows: AskTx[] = [];
        for (const t of body.tasks ?? []) {
          const entries = t.spend?.entries ?? [];
          for (const [i, e] of entries.entries()) {
            rows.push({
              kind: "ask",
              key: `${t.id}:${i}`,
              ts: e.ts,
              label: activityTitle(t),
              taskId: t.id,
              amountCents: e.amountUsdCents,
              txHash: e.txHash,
              network: t.terminal?.offer?.network ?? undefined,
              receiptHash: e.receiptHash,
              signalHash: e.signalHash,
            });
          }
        }
        rows.sort((a, b) => b.ts - a.ts);
        setAsks(rows);
      }
    } catch {
      asksOk = false;
    }

    try {
      const res = await fetch("/api/acp/buyer/jobs", { cache: "no-store" });
      if (res.status === 401) {
        // The buyer escrow ledger is session-scoped; not signed in is not an error.
        setJobsPrivate(true);
        setJobs([]);
      } else if (!res.ok) {
        jobsOk = false;
      } else {
        const body = (await res.json()) as { jobs?: BuyerJobView[] };
        const rows: BuyerTx[] = (body.jobs ?? []).map((j) => ({
          kind: "buyer",
          key: j.buyer.key,
          ts: Date.parse(j.buyer.updatedAt) || Date.parse(j.buyer.createdAt) || 0,
          label: j.provider?.offering ?? j.buyer.offering,
          jobId: j.buyer.jobId,
          chainId: j.buyer.chainId,
          priceCents: buyerCents(j),
          phaseLabel: j.phaseLabel,
          createdTx: j.buyer.txHash,
          allowanceTx: j.buyer.allowanceTxHash,
          fundedTx: j.buyer.fundedTxHash,
          releasedTx: j.buyer.completedTxHash,
        }));
        rows.sort((a, b) => b.ts - a.ts);
        setJobs(rows);
        setJobsPrivate(false);
      }
    } catch {
      jobsOk = false;
    }

    setAsksFailed(!asksOk);
    setJobsFailed(!jobsOk);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    const poll = setInterval(() => void reload(), 30_000);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);

  const transactions = useMemo<WalletTx[]>(
    () => [...(asks ?? []), ...(jobs ?? [])].sort((a, b) => b.ts - a.ts).slice(0, 30),
    [asks, jobs],
  );

  const receiptRows = useMemo<ReceiptRow[]>(() => {
    const fromAsks: ReceiptRow[] = (asks ?? [])
      .filter((a) => !!a.receiptHash)
      .map((a) => ({
        key: a.key,
        ts: a.ts,
        label: a.label,
        receiptHash: a.receiptHash as string,
        signalHash: a.signalHash ?? null,
        txHash: a.txHash ?? null,
        network: a.network ?? null,
        recordHref: `/activity/${a.taskId}`,
        amountCents: a.amountCents,
      }));
    const fromBuyer: ReceiptRow[] = (jobs ?? [])
      .filter((j) => !!j.releasedTx)
      .map((j) => ({
        key: `${j.key}:release`,
        ts: j.ts,
        label: j.label,
        receiptHash: j.releasedTx as string,
        signalHash: null,
        txHash: j.releasedTx,
        network: null,
        buyerChainId: j.chainId,
        recordHref: null,
        amountCents: j.priceCents ?? 0,
      }));
    return [...fromAsks, ...fromBuyer].sort((a, b) => b.ts - a.ts).slice(0, 20);
  }, [asks, jobs]);

  const totalAsks = (asks ?? []).length;
  const totalJobs = (jobs ?? []).length;

  // What the wallet actually SPENT, per rail — the summary the history below
  // itemizes. Ask rows carry the settled amount from the engine spend ledger;
  // buyer rows carry the offering price the escrow was funded with.
  const asksTotalCents = (asks ?? []).reduce((n, a) => n + a.amountCents, 0);
  const jobsTotalCents = (jobs ?? []).reduce((n, j) => n + (j.priceCents ?? 0), 0);

  if (!loading && asksFailed && jobsFailed) {
    return (
      <div className="rounded-2xl border border-risk/30 bg-panel px-5 py-6" role="alert">
        <p className="text-[13.5px] font-medium text-ink">The ledgers could not be read.</p>
        <p className="mt-1.5 max-w-[56ch] text-[12.5px] leading-relaxed text-ink-soft">
          Neither the spend ledger nor the escrow ledger answered. Nothing is invented to fill the gap — the records
          themselves are untouched.
        </p>
        <button type="button" onClick={() => void reload()} className="btn-quiet mt-4 !min-h-9">
          <RefreshCw size={13} aria-hidden /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Spend history */}
      <section aria-label="Spend history">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="x-label !mt-0">
            SPEND HISTORY
            {!loading && <span className="tabular ml-1 tracking-normal">· {totalAsks + totalJobs} on record</span>}
          </h2>
          <span className="text-[11px] text-ink-faint">spend ledger + buyer escrow, newest first</span>
        </div>

        {!loading && (totalAsks > 0 || totalJobs > 0) && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-edge bg-panel-3 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Autonomous asks · settled</p>
              <p className="tabular mt-1 text-[20px] font-semibold leading-none text-ink">{usd(asksTotalCents)}</p>
              <p className="mt-1 text-[10.5px] text-ink-faint">
                {totalAsks} {totalAsks === 1 ? "ask" : "asks"} · paid from your in-app spend credit
              </p>
            </div>
            <div className="rounded-xl border border-edge bg-panel-3 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Buyer Desk purchases · escrowed</p>
              <p className="tabular mt-1 text-[20px] font-semibold leading-none text-ink">{usd(jobsTotalCents)}</p>
              <p className="mt-1 text-[10.5px] text-ink-faint">
                {totalJobs} {totalJobs === 1 ? "purchase" : "purchases"} · signed from your own wallet on Base
              </p>
            </div>
          </div>
        )}

        {loading && asks === null && (
          <div aria-live="polite" className="mt-3 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 rounded-lg bg-panel-2 motion-safe:animate-pulse" />
            ))}
            <p className="pt-1 text-[12px] text-ink-faint">Reading the ledgers…</p>
          </div>
        )}

        {!loading && transactions.length === 0 && (
          <div className="mt-3 rounded-2xl border border-dashed border-edge bg-panel/40 px-5 py-8 text-center">
            <p className="mx-auto max-w-[46ch] text-[12.5px] leading-relaxed text-ink-soft">
              No payments recorded yet. A funded Terminal or Mind ask, or a Buyer Desk purchase, lands here with its
              on-chain references.
            </p>
          </div>
        )}

        {!loading && transactions.length > 0 && (
          <ul className="mt-3 divide-y divide-edge rounded-2xl border border-edge bg-panel">
            {transactions.map((tx) => {
              const askHref = tx.kind === "ask" ? `/activity/${tx.taskId}` : null;
              const buyerChainHref =
                tx.kind === "buyer" ? baseTxHref(tx.chainId, tx.fundedTx ?? tx.createdTx) : null;
              const settleHash = tx.kind === "ask" ? (tx.txHash ?? null) : (tx.fundedTx ?? tx.createdTx);
              return (
                <li key={`${tx.kind}:${tx.key}`} className="px-4 py-3.5 sm:px-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="min-w-0 flex-1 basis-52">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{tx.label}</span>
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        {tx.kind === "ask" ? "Telegraph ask" : `Buyer Desk · ${tx.phaseLabel}`}
                        {tx.kind === "buyer" ? (
                          <>
                            {" · "}
                            <span className="tabular">job {tx.jobId}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="tabular text-[13px] font-semibold text-ink">
                      {tx.kind === "ask" ? usd(tx.amountCents) : tx.priceCents !== null ? usd(tx.priceCents) : "—"}
                    </span>
                    <span className="tabular w-full text-[11px] text-ink-faint sm:w-auto">{when(tx.ts)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {tx.kind === "ask" && txHref(tx.txHash, tx.network) && (
                      <a
                        href={txHref(tx.txHash, tx.network) as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tabular inline-flex items-center gap-0.5 text-[10.5px] text-blue hover:underline"
                        title={tx.txHash}
                      >
                        settlement {shortHash(tx.txHash as string)} <ArrowUpRight size={10} aria-hidden />
                      </a>
                    )}
                    {tx.kind === "buyer" && buyerChainHref && (
                      <a
                        href={buyerChainHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tabular inline-flex items-center gap-0.5 text-[10.5px] text-blue hover:underline"
                        title={settleHash ?? ""}
                      >
                        escrow {shortHash(settleHash ?? "")} <ArrowUpRight size={10} aria-hidden />
                      </a>
                    )}
                    {askHref && (
                      <Link href={askHref} className="text-[10.5px] font-medium text-teal hover:underline">
                        Open the run
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {jobsPrivate && (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Buyer Desk purchases appear once you sign in with the wallet that opened them.
          </p>
        )}
      </section>

      {/* Receipts */}
      <section aria-label="Receipts">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="x-label !mt-0">
            RECEIPTS
            {!loading && <span className="tabular ml-1 tracking-normal">· {receiptRows.length} kept</span>}
          </h2>
          <span className="text-[11px] text-ink-faint">the proof each payment left behind</span>
        </div>

        {!loading && receiptRows.length === 0 && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-faint">
            No receipts yet. Every settled payment writes one — a receipt hash and a settlement transaction you can
            verify on the explorer.
          </p>
        )}

        {receiptRows.length > 0 && (
          <ul className="mt-3 divide-y divide-edge rounded-2xl border border-edge bg-panel">
            {receiptRows.map((r) => {
              const href =
                r.buyerChainId !== undefined
                  ? baseTxHref(r.buyerChainId, r.receiptHash)
                  : txHref(r.txHash, r.network);
              return (
                <li key={r.key} className="px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <ReceiptText size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-ink-faint" />
                      <span className="truncate text-[12.5px] text-ink">{r.label}</span>
                    </span>
                    {r.amountCents > 0 && <span className="tabular text-[12px] text-ink-soft">{usd(r.amountCents)}</span>}
                    <span className="tabular w-full text-[11px] text-ink-faint sm:w-auto">{when(r.ts)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="tabular text-[10.5px] text-ink-faint" title={r.receiptHash}>
                      receipt {shortHash(r.receiptHash)}
                    </span>
                    {r.signalHash && (
                      <span className="tabular text-[10.5px] text-ink-faint" title={r.signalHash}>
                        signal {shortHash(r.signalHash)}
                      </span>
                    )}
                    {href && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tabular inline-flex items-center gap-0.5 text-[10.5px] text-blue hover:underline"
                      >
                        on-chain <ArrowUpRight size={10} aria-hidden />
                      </a>
                    )}
                    {r.recordHref && (
                      <Link href={r.recordHref} className="text-[10.5px] font-medium text-teal hover:underline">
                        Open the run
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
