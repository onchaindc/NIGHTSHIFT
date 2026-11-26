"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, FileSearch, LoaderCircle, Plus, ScanSearch, ShieldCheck } from "lucide-react";

import type { Investigation, InvestigationSummary } from "@/lib/assurance/types";
import { USDC_MINT_MAINNET } from "@/lib/assurance/types";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";

const DECISION_STYLE: Record<string, string> = {
  CLEARED: "border-teal/40 bg-teal/10 text-teal",
  HOLD: "border-amber/40 bg-amber/10 text-amber",
  ESCALATE: "border-risk/40 bg-risk/10 text-risk",
};

function DecisionChip({ value }: { value: string | null }) {
  if (!value) return <span className="text-[11px] text-ink-faint">Not assessed</span>;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold tracking-wide ${DECISION_STYLE[value] ?? DECISION_STYLE.HOLD}`}>
      {value}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Wallet Exposure scan — the free, instant, source-verified tool      */
/* ------------------------------------------------------------------ */

interface ScanResult {
  wallet: {
    address: string;
    exists: boolean;
    solBalance: number | null;
    tokenAccountCount: number;
    mintBalance: { uiAmount: number | null; raw: string; decimals: number; owner: string } | null;
    recentSignatures: number;
    newestActivity: number | null;
    historyUnavailable: string | null;
  };
  mint: { address: string; decimals: number; supply: string; mintAuthority: string | null; freezeAuthority: string | null };
  provenance: { rpcUrl: string; slot: number | null; readAt: string };
  note: string;
}

function ScanCard() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  async function scan() {
    if (!address.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/assurance/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as ScanResult & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `The scan failed with status ${res.status}.`);
        return;
      }
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "min-h-11 w-full rounded-lg border border-edge bg-panel-2 px-3.5 text-[13.5px] text-ink placeholder:text-ink-faint focus:border-teal focus:outline-none";

  return (
    <div className="rounded-3xl border border-teal/25 bg-gradient-to-br from-teal/[0.05] to-panel p-6 sm:p-7">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="grid h-9 w-9 place-items-center rounded-lg border border-teal/40 bg-teal/10 text-teal">
          <ScanSearch size={16} strokeWidth={1.8} />
        </span>
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Wallet exposure scan</h2>
          <p className="text-[11.5px] text-ink-faint">Free · real Solana reads · nothing stored, nothing spent</p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void scan();
        }}
      >
        <input
          className={`${field} tabular flex-1`}
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
          placeholder="Paste any Solana address — wallet or token account"
          spellCheck={false}
          aria-label="Solana address to scan"
        />
        <button type="submit" disabled={busy || !address.trim()} className="btn-primary !min-h-11 shrink-0 !px-5">
          {busy ? <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> : <ScanSearch size={14} aria-hidden />}
          {busy ? "Reading chain…" : "Scan"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 rounded-2xl border border-edge bg-panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tabular break-all text-[12.5px] font-medium text-ink">{result.wallet.address}</p>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold ${
                result.wallet.exists ? "border-teal/40 bg-teal/10 text-teal" : "border-edge bg-panel-3 text-ink-faint"
              }`}
            >
              {result.wallet.exists ? "On-chain" : "No state found"}
            </span>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <div>
              <dt className="x-label">SOL</dt>
              <dd className="tabular mt-1 text-[14px] font-semibold text-ink">
                {result.wallet.solBalance === null ? "—" : result.wallet.solBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </dd>
            </div>
            <div>
              <dt className="x-label">USDC</dt>
              <dd className="tabular mt-1 text-[14px] font-semibold text-ink">
                {result.wallet.mintBalance?.uiAmount === null || result.wallet.mintBalance === null
                  ? "0"
                  : result.wallet.mintBalance.uiAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })}
              </dd>
            </div>
            <div>
              <dt className="x-label">Token accounts</dt>
              <dd className="tabular mt-1 text-[14px] font-semibold text-ink">{result.wallet.tokenAccountCount}</dd>
            </div>
            <div>
              <dt className="x-label">Recent activity</dt>
              <dd className="tabular mt-1 text-[14px] font-semibold text-ink">
                {result.wallet.historyUnavailable ? "—" : `${result.wallet.recentSignatures} sig`}
              </dd>
            </div>
          </dl>

          <p className="mt-4 border-t border-edge pt-3 text-[10.5px] leading-relaxed text-ink-faint">
            Mint {result.mint.decimals} decimals · supply {result.mint.supply} · mint authority {result.mint.mintAuthority ?? "none (frozen)"}
            {" · "}read at slot {result.provenance.slot ?? "—"} · {result.provenance.rpcUrl}
            {result.wallet.newestActivity ? ` · newest activity ${new Date(result.wallet.newestActivity * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}
          </p>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">{result.note}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const EMPTY_FORM = {
  payerWallet: "",
  recipientWallet: "",
  amountUsdc: "",
  tokenMint: USDC_MINT_MAINNET,
  jurisdiction: "GB",
  approvedBeneficiary: "",
  counterpartyName: "",
  registrationNumber: "",
  contractRef: "",
  memo: "",
  spendLimit: "0.10",
  ownershipRequired: true,
};

function ModeTag({ mode }: { mode: "live" | "demonstration" }) {
  return mode === "live" ? (
    <span className="text-[10.5px] font-medium text-ink-faint">Live</span>
  ) : (
    <span className="rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber">Demo</span>
  );
}

export function AssuranceIndex() {
  const [rows, setRows] = useState<InvestigationSummary[] | null>(null);
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [created, setCreated] = useState<Investigation | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/assurance", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as {
        investigations?: InvestigationSummary[];
        error?: string;
      };
      if (!res.ok) {
        setFormError(body.error ?? `The list failed with status ${res.status}.`);
        return;
      }
      setRows(body.investigations ?? []);
    } catch (err) {
      setFormError(`Could not reach the server. ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-list when the signed-in identity changes: the scope of visible files follows the session.
  useEffect(() => {
    if (session.mode !== "loading") void refresh();
  }, [session.mode, session.address, refresh]);

  async function loadDemo() {
    setDemoBusy(true);
    setFormError(null);
    try {
      const res = await fetch("/api/assurance/demo", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { investigation?: Investigation; error?: string };
      if (!res.ok || !body.investigation) {
        setFormError(body.error ?? "The demonstration file could not be created.");
        return;
      }
      window.location.href = `/assurance/${body.investigation.id}`;
    } finally {
      setDemoBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch("/api/assurance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payerWallet: form.payerWallet,
          recipientWallet: form.recipientWallet,
          amountUsdc: Number(form.amountUsdc),
          tokenMint: form.tokenMint,
          jurisdiction: form.jurisdiction,
          approvedBeneficiary: form.approvedBeneficiary,
          counterpartyName: form.counterpartyName,
          registrationNumber: form.registrationNumber,
          contractRef: form.contractRef,
          memo: form.memo,
          ownershipRequired: form.ownershipRequired,
          spendLimitUsdCents: Math.round(Number(form.spendLimit || "0") * 100),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { investigation?: Investigation; error?: string };
      if (!res.ok || !body.investigation) {
        setFormError(body.error ?? `The file could not be opened (status ${res.status}).`);
        return;
      }
      setCreated(body.investigation);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-teal focus:outline-none";

  const signedIn = session.mode === "user" || session.mode === "operator";

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="max-w-[60ch]">
          <p className="x-eyebrow">Assurance</p>
          <h1 className="x-display-1 mt-3 text-balance text-ink">Verify before you settle.</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">
            Check a high-value Solana transfer before funds move. Scan any wallet free, then open a file: counterparty
            identity, sanctions exposure, filings and document integrity reconciled into one decision —{" "}
            <span className="font-semibold text-ink">CLEARED</span>, <span className="font-semibold text-ink">HOLD</span>{" "}
            or <span className="font-semibold text-ink">ESCALATE</span> — with every finding cited.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void loadDemo()} disabled={demoBusy} className="btn-quiet !min-h-10">
              {demoBusy ? <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> : <FileSearch size={14} aria-hidden />}
              Demo scenario
            </button>
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="btn-primary !min-h-10"
              title={signedIn ? undefined : "Sign in with your wallet first"}
            >
              <Plus size={14} aria-hidden /> New investigation
            </button>
          </div>
          <WalletSignIn onSession={setSession} compact />
        </div>
      </header>

      {!signedIn && session.mode !== "loading" && (
        <p className="mt-6 rounded-2xl border border-edge bg-panel-3 px-4 py-3 text-[12px] leading-relaxed text-ink-soft">
          Live files belong to the wallet that opened them.{" "}
          <span className="font-medium text-ink">Sign in with your wallet</span> (one signature, not a transaction) to
          open and run your own investigations. The demo scenario and the wallet scan are open to everyone.
        </p>
      )}

      {/* Free scan — the tool that works for everyone right now */}
      <section aria-label="Wallet scan" className="mt-8">
        <ScanCard />
      </section>

      {formError && (
        <p role="alert" className="mt-6 rounded-lg border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk">
          {formError}
        </p>
      )}

      {created && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-teal/40 bg-teal/5 px-4 py-3">
          <p className="text-[12.5px] text-ink-soft">
            File <span className="tabular font-medium text-ink">{created.reference}</span> opened for{" "}
            {created.counterparty.legalName}. Next: run the free Solana inspection on the file.
          </p>
          <Link href={`/assurance/${created.id}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-teal">
            Open the investigation <ArrowRight size={13} aria-hidden />
          </Link>
        </div>
      )}

      {/* New investigation form */}
      {showForm && (
        <section aria-label="New investigation" className="mt-8 overflow-hidden rounded-3xl border border-edge bg-panel">
          <div className="border-b border-edge px-5 py-4 sm:px-6">
            <p className="text-[14px] font-semibold text-ink">Transaction under review</p>
            <p className="mt-0.5 text-[11.5px] text-ink-faint">
              The file is owned by your wallet. Solana inspection is free; paid intelligence always stops at an
              approval you sign off on.
            </p>
          </div>
          <form
            className="grid gap-4 px-5 py-5 sm:grid-cols-2 sm:px-6"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="x-label sm:col-span-2">The transfer</p>
            <label className="block">
              <span className="x-label mb-1 block">Payer wallet</span>
              <input className={`${field} tabular`} value={form.payerWallet} onChange={(e) => setForm({ ...form, payerWallet: e.target.value })} placeholder="Solana address" spellCheck={false} />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Recipient wallet</span>
              <input className={`${field} tabular`} value={form.recipientWallet} onChange={(e) => setForm({ ...form, recipientWallet: e.target.value })} placeholder="Solana address" spellCheck={false} />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Amount (USDC)</span>
              <input className={`${field} tabular`} value={form.amountUsdc} onChange={(e) => setForm({ ...form, amountUsdc: e.target.value.replace(/[^0-9.]/g, "") })} inputMode="decimal" placeholder="2400000" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Token mint</span>
              <input className={`${field} tabular`} value={form.tokenMint} onChange={(e) => setForm({ ...form, tokenMint: e.target.value })} spellCheck={false} />
            </label>

            <p className="x-label mt-2 sm:col-span-2">The counterparty</p>
            <label className="block">
              <span className="x-label mb-1 block">Legal name (as supplied)</span>
              <input className={field} value={form.counterpartyName} onChange={(e) => setForm({ ...form, counterpartyName: e.target.value })} placeholder="Northstar Capital Holdings Ltd" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Approved beneficiary (per approval)</span>
              <input className={field} value={form.approvedBeneficiary} onChange={(e) => setForm({ ...form, approvedBeneficiary: e.target.value })} placeholder="Northstar Capital Holdings Ltd" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Registration number</span>
              <input className={`${field} tabular`} value={form.registrationNumber} onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} placeholder="UK-09876543" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Jurisdiction</span>
              <input className={`${field} tabular`} value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })} placeholder="GB" />
            </label>

            <p className="x-label mt-2 sm:col-span-2">Controls</p>
            <label className="block">
              <span className="x-label mb-1 block">Contract reference</span>
              <input className={field} value={form.contractRef} onChange={(e) => setForm({ ...form, contractRef: e.target.value })} placeholder="MSA-2026-0417 / drawdown 3" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Settlement memo</span>
              <input className={field} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="Northstar drawdown 3 settlement" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Intelligence ceiling (USD)</span>
              <input className={`${field} tabular`} value={form.spendLimit} onChange={(e) => setForm({ ...form, spendLimit: e.target.value.replace(/[^0-9.]/g, "") })} inputMode="decimal" />
            </label>
            <label className="flex items-end gap-2 pb-2">
              <input type="checkbox" checked={form.ownershipRequired} onChange={(e) => setForm({ ...form, ownershipRequired: e.target.checked })} className="size-4 accent-teal" />
              <span className="text-[12px] leading-snug text-ink-soft">
                Beneficial ownership is material to this transfer
              </span>
            </label>

            <div className="flex items-center justify-between gap-3 border-t border-edge pt-4 sm:col-span-2">
              <p className="text-[11px] leading-snug text-ink-faint">
                Nothing is spent until the plan on this file is approved by you.
              </p>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? "Opening…" : "Open investigation"}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Files */}
      <section aria-label="Investigations" className="mt-12">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="x-label">Files on record</h2>
          <span className="tabular text-[11px] text-ink-faint">{rows?.length ?? 0}</span>
        </div>

        {rows === null ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 rounded-2xl bg-panel-2 motion-safe:animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-4 rounded-3xl border border-dashed border-edge bg-panel/40 px-6 py-12 text-center">
            <ShieldCheck size={20} aria-hidden className="mx-auto text-ink-faint" />
            <p className="mt-3 text-[13.5px] font-medium text-ink">No investigation on file yet.</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-faint">
              Scan a wallet above for a free instant read, load the demo scenario to see the full workflow, or sign in
              and open your own file.
            </p>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/assurance/${row.id}`}
                  className="group flex h-full flex-col rounded-2xl border border-edge bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_12px_30px_-22px_rgba(22,24,29,0.4)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="tabular text-[12.5px] font-semibold text-ink group-hover:text-teal">{row.reference}</span>
                    <DecisionChip value={row.decision} />
                  </div>
                  <p className="mt-2.5 truncate text-[14px] font-medium text-ink">{row.counterparty}</p>
                  <p className="mt-0.5 text-[12px] text-ink-soft">
                    <span className="tabular">{row.amountUsdc.toLocaleString("en-US")}</span> USDC ·{" "}
                    <span className="tabular">{row.evidenceCount}</span> evidence ·{" "}
                    <span className="tabular">{row.findingCount}</span> findings
                  </p>
                  <p className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-ink-faint">
                    {new Date(row.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                    <ModeTag mode={row.dataMode} />
                    <ArrowRight size={12} aria-hidden className="ml-auto transition-transform group-hover:translate-x-0.5 group-hover:text-amber" />
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-10 text-[11px] leading-relaxed text-ink-faint">
        NIGHTSHIFT inspects Solana state read-only, reuses the shared approval and spend controls, and never signs or
        broadcasts a settlement. Every decision cites its evidence; missing evidence stays missing.
      </p>
    </div>
  );
}
