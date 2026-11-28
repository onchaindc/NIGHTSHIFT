import { persistence } from "@/lib/storage";
import { isPayerAddress } from "@/lib/api/auth";

/**
 * The per-user in-app spend credit — the wallet the user actually pays with.
 *
 * Before this ledger, every autonomous paid run (Terminal, Minds, Deal Desk)
 * settled from the deployment payer wallet and the user's own wallet was only
 * metered. That inverted the product's own promise: buyers must see THEIR
 * wallet pay. Now each signed-in wallet holds a spend-credit balance in this
 * ledger; a paid run debits the RUN OWNER's balance at the same moment the
 * task's spend entry is written, and the paid-run gate refuses a user whose
 * balance cannot cover the run's ceiling.
 *
 * The faucet mint tops this balance up alongside the on-chain test USDC, so
 * one button funds both rails. The per-user daily cap (userSpend.ts) stays as
 * the guard on faucet-funded credit: free faucet credit plus no cap would let
 * one address farm the deployment rail. The operator (the payer wallet's own
 * session) is never debited and never capped — it belongs to whoever funds
 * the deployment.
 *
 * Storage: one named document per wallet in the persistence KV store
 * (`ns_credits:<address>`), mutated only through updateNamed so two
 * concurrent runs can never interleave their debits.
 */

export interface CreditEntry {
  ts: number;
  /** + when credit is granted (faucet), − when a paid run settles. */
  deltaUsdCents: number;
  /** The balance this entry left behind — the ledger is self-auditing. */
  balanceAfterUsdCents: number;
  label: string;
  taskId?: string;
}

export interface CreditLedger {
  balanceUsdCents: number;
  /** Newest last. Capped — a long history never bloats the document. */
  entries: CreditEntry[];
}

/** What one successful faucet mint adds to the in-app credit balance. */
export const FAUCET_CREDIT_USD_CENTS = 1_000; // $10.00 — matches the 10 test USDC the mint puts on-chain

const ENTRY_CAP = 200;

function normalize(addr: string): string {
  return addr.trim().toLowerCase();
}

function kvName(addr: string): string {
  return `ns_credits:${normalize(addr)}`;
}

function emptyLedger(): CreditLedger {
  return { balanceUsdCents: 0, entries: [] };
}

export async function getCreditLedger(address: string): Promise<CreditLedger> {
  const doc = await persistence().readNamed<CreditLedger>(kvName(address));
  if (!doc || typeof doc.balanceUsdCents !== "number" || !Array.isArray(doc.entries)) return emptyLedger();
  return doc;
}

export async function creditBalanceOf(address: string): Promise<number> {
  return (await getCreditLedger(address)).balanceUsdCents;
}

/** Grant spend credit (the faucet). Returns the ledger as persisted. */
export async function grantCredits(address: string, amountUsdCents: number, label: string): Promise<CreditLedger> {
  const amount = Math.round(amountUsdCents);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("credit grant must be a positive number of cents");
  return persistence().updateNamed<CreditLedger>(kvName(address), (current) => {
    const ledger: CreditLedger =
      current && typeof current.balanceUsdCents === "number" && Array.isArray(current.entries)
        ? current
        : emptyLedger();
    const balance = ledger.balanceUsdCents + amount;
    const entry: CreditEntry = { ts: Date.now(), deltaUsdCents: amount, balanceAfterUsdCents: balance, label };
    return { balanceUsdCents: balance, entries: [...ledger.entries, entry].slice(-ENTRY_CAP) };
  });
}

/**
 * Debit a paid run from its owner's own balance. The miner has ALREADY been
 * paid by the time this runs, so the debit always records — a concurrent run
 * can push the balance slightly negative, and the gate (not the debit) is
 * what refuses the NEXT run while the balance cannot cover a ceiling. Returns
 * null when there is nothing to debit: no owner, or the owner IS the payer
 * (the operator fronts its own runs).
 */
export async function debitCreditsForRun(
  owner: string | null | undefined,
  amountUsdCents: number,
  taskId: string,
  label: string,
): Promise<CreditLedger | null> {
  const ownerAddr = (owner ?? "").trim();
  if (!ownerAddr || isPayerAddress(ownerAddr)) return null;
  const amount = Math.round(amountUsdCents);
  if (!Number.isFinite(amount) || amount === 0) return null;
  return persistence().updateNamed<CreditLedger>(kvName(ownerAddr), (current) => {
    const ledger: CreditLedger =
      current && typeof current.balanceUsdCents === "number" && Array.isArray(current.entries)
        ? current
        : emptyLedger();
    const balance = ledger.balanceUsdCents - amount;
    const entry: CreditEntry = {
      ts: Date.now(),
      deltaUsdCents: -amount,
      balanceAfterUsdCents: balance,
      label,
      taskId,
    };
    return { balanceUsdCents: balance, entries: [...ledger.entries, entry].slice(-ENTRY_CAP) };
  });
}

/**
 * The spend history a wallet page shows: every credit and debit on the
 * user's own rail, newest first. The run label already reads like a receipt
 * line ("whale-alert: holder concentration via Telegraph"), so entries render
 * as-is.
 */
export async function creditHistoryFor(address: string): Promise<CreditLedger> {
  const ledger = await getCreditLedger(address);
  return { balanceUsdCents: ledger.balanceUsdCents, entries: [...ledger.entries].reverse() };
}
