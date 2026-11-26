"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, ScanSearch, ShieldCheck } from "lucide-react";

import type { Investigation, InvestigationSummary } from "@/lib/assurance/types";
import { USDC_MINT_MAINNET } from "@/lib/assurance/types";
import { friendlyNetworkError } from "@/lib/api/client-errors";
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
/* Free wallet check — instant, read-only, demoted to a quiet tool.     */
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
      setError(friendlyNetworkError(err));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "min-h-11 w-full rounded-lg border border-edge bg-panel-2 px-3.5 text-[13.5px] text-ink placeholder:text-ink-faint focus:border-teal focus:outline-none";

  return (
    <div className="rounded-2xl border border-edge bg-panel p-5">
      <p className="text-[13px] font-semibold text-ink">Free wallet check</p>
      <p className="mt-0.5 text-[11.5px] text-ink-faint">
        Any Solana address, read live on-chain. Nothing stored, nothing spent.
      </p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void scan();
        }}
      >
        <input
          className={`${field} tabular flex-1`}
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
          placeholder="Paste a Solana address"
          spellCheck={false}
          aria-label="Solana address to check"
        />
        <button type="submit" disabled={busy || !address.trim()} className="btn-primary !min-h-11 shrink-0 !px-5">
          {busy ? <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> : <ScanSearch size={14} aria-hidden />}
          {busy ? "Reading…" : "Check"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-edge bg-panel-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tabular break-all text-[12px] font-medium text-ink">{result.wallet.address}</p>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold ${
                result.wallet.exists ? "border-teal/40 bg-teal/10 text-teal" : "border-edge bg-panel-3 text-ink-faint"
              }`}
            >
              {result.wallet.exists ? "On-chain" : "No state found"}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <div>
              <dt className="x-label">SOL</dt>
              <dd className="tabular mt-1 text-[13.5px] font-semibold text-ink">
                {result.wallet.solBalance === null ? "—" : result.wallet.solBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </dd>
            </div>
            <div>
              <dt className="x-label">USDC</dt>
              <dd className="tabular mt-1 text-[13.5px] font-semibold text-ink">
                {result.wallet.mintBalance === null || result.wallet.mintBalance.uiAmount === null
                  ? "0"
                  : result.wallet.mintBalance.uiAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })}
              </dd>
            </div>
            <div>
              <dt className="x-label">Token accounts</dt>
              <dd className="tabular mt-1 text-[13.5px] font-semibold text-ink">{result.wallet.tokenAccountCount}</dd>
            </div>
            <div>
              <dt className="x-label">Recent activity</dt>
              <dd className="tabular mt-1 text-[13.5px] font-semibold text-ink">
                {result.wallet.historyUnavailable ? "—" : `${result.wallet.recentSignatures} sig`}
              </dd>
            </div>
          </dl>
          <p className="mt-3 border-t border-edge pt-2.5 text-[10.5px] text-ink-faint">
            Read at slot {result.provenance.slot ?? "—"} · {result.provenance.rpcUrl}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The Deal Desk index                                                  */
/* ------------------------------------------------------------------ */

const DEPTHS = [
  { key: "0.05", label: "Quick screen", hint: "identity + sanctions" },
  { key: "0.15", label: "Standard", hint: "registry, sanctions, filings" },
  { key: "0.40", label: "Extended", hint: "adds documents & contract" },
];

const EMPTY_FORM = {
  counterpartyName: "",
  jurisdiction: "GB",
  registrationNumber: "",
  amountUsdc: "",
  payerWallet: "",
  recipientWallet: "",
  memo: "",
  spendLimit: "0.15",
  ownershipRequired: true,
};

/** A realistic worked example for the "Fill sample values" button. The
 * wallets are this deployment's own deterministic demo fixtures (the same
 * derivation the assurance demo files use) — sample data, not real
 * counterparties. */
const SAMPLE_FORM = {
  counterpartyName: "Northstar Capital Holdings Ltd",
  jurisdiction: "GB",
  registrationNumber: "UK-09876543",
  amountUsdc: "2400000",
  payerWallet: "GsTtTi66ktp3Db9ehm5eF3bpaTEbAXVkdwzyZsbnXXyT",
  recipientWallet: "GfdQGZhQ2gqoDZDsV8JNmDvWRWMVKLwoqmQcrQN485ss",
  memo: "MSA-2026-0417 · drawdown 3",
  spendLimit: "0.15",
  ownershipRequired: true,
};

export function AssuranceIndex() {
  const router = useRouter();
  const [rows, setRows] = useState<InvestigationSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch("/api/assurance", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as {
        investigations?: InvestigationSummary[];
        error?: string;
      };
      if (!res.ok) {
        setRows([]);
        setListError(
          body.error === "storage unavailable"
            ? "Storage was briefly unavailable (it sleeps between requests). One moment — then retry."
            : (body.error ?? `The list failed with status ${res.status}.`),
        );
        return;
      }
      // Demonstration fixtures stay API-readable but never clutter the desk.
      setRows((body.investigations ?? []).filter((r) => r.dataMode !== "demonstration"));
    } catch (err) {
      setRows([]);
      setListError(friendlyNetworkError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-list when the signed-in identity changes: the scope of visible files follows the session.
  useEffect(() => {
    if (session.mode !== "loading") void refresh();
  }, [session.mode, session.address, refresh]);

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
          tokenMint: USDC_MINT_MAINNET,
          jurisdiction: form.jurisdiction,
          approvedBeneficiary: form.counterpartyName,
          counterpartyName: form.counterpartyName,
          registrationNumber: form.registrationNumber,
          memo: form.memo,
          ownershipRequired: form.ownershipRequired,
          spendLimitUsdCents: Math.round(Number(form.spendLimit || "0.15") * 100),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { investigation?: Investigation; error?: string };
      if (!res.ok || !body.investigation) {
        setFormError(body.error ?? `The file could not be opened (status ${res.status}).`);
        return;
      }
      router.push(`/desk/${body.investigation.id}`);
    } catch (err) {
      setFormError(friendlyNetworkError(err));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full min-h-10 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-teal focus:outline-none";

  const signedIn = session.mode === "user" || session.mode === "operator";
  const liveRows = rows ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-[56ch]">
          <p className="x-eyebrow">Settlement assurance · deal files</p>
          <h2 className="x-display-2 mt-3 text-balance text-ink">Investigate before you settle.</h2>
          <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">
            Open a file on a high-value payment: who you are paying, their standing, the rails the money moves on —
            one <span className="font-semibold text-ink">CLEARED</span> /{" "}
            <span className="font-semibold text-ink">HOLD</span> /{" "}
            <span className="font-semibold text-ink">ESCALATE</span> decision, every finding cited.
          </p>
        </div>
        <WalletSignIn onSession={setSession} compact />
      </header>

      {/* Primary: the deal file, front and center — no toggle, no demo */}
      <section aria-label="New deal file" className="mt-8 overflow-hidden rounded-3xl border border-edge bg-panel">
        <form
          className="grid gap-4 px-5 py-6 sm:grid-cols-2 sm:px-7"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="x-label sm:col-span-2">1 · Who are you paying?</p>
          <label className="block sm:col-span-2">
            <span className="x-label mb-1 block">Legal name</span>
            <input
              className={field}
              value={form.counterpartyName}
              onChange={(e) => setForm({ ...form, counterpartyName: e.target.value })}
              placeholder="Northstar Capital Holdings Ltd"
              required
            />
          </label>
          <label className="block">
            <span className="x-label mb-1 block">Jurisdiction</span>
            <input
              className={`${field} tabular`}
              value={form.jurisdiction}
              onChange={(e) => setForm({ ...form, jurisdiction: e.target.value.toUpperCase().slice(0, 2) })}
              placeholder="GB"
            />
          </label>
          <label className="block">
            <span className="x-label mb-1 block">Registration no. (optional)</span>
            <input
              className={`${field} tabular`}
              value={form.registrationNumber}
              onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })}
              placeholder="UK-09876543"
            />
          </label>

          <p className="x-label mt-2 sm:col-span-2">2 · The payment</p>
          <label className="block">
            <span className="x-label mb-1 block">Amount (USDC)</span>
            <input
              className={`${field} tabular`}
              value={form.amountUsdc}
              onChange={(e) => setForm({ ...form, amountUsdc: e.target.value.replace(/[^0-9.]/g, "") })}
              inputMode="decimal"
              placeholder="2400000"
              required
            />
          </label>
          <label className="block">
            <span className="x-label mb-1 block">Reference (optional)</span>
            <input
              className={field}
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              placeholder="MSA-2026-0417 · drawdown 3"
            />
          </label>
          <label className="block">
            <span className="x-label mb-1 block">Payer wallet (Solana)</span>
            <input
              className={`${field} tabular`}
              value={form.payerWallet}
              onChange={(e) => setForm({ ...form, payerWallet: e.target.value.trim() })}
              placeholder="Sender address"
              spellCheck={false}
              required
            />
          </label>
          <label className="block">
            <span className="x-label mb-1 block">Recipient wallet (Solana)</span>
            <input
              className={`${field} tabular`}
              value={form.recipientWallet}
              onChange={(e) => setForm({ ...form, recipientWallet: e.target.value.trim() })}
              placeholder="Receiver address"
              spellCheck={false}
              required
            />
          </label>

          <p className="x-label mt-2 sm:col-span-2">3 · How deep should the file go?</p>
          <div role="radiogroup" aria-label="Investigation depth" className="grid grid-cols-3 gap-2 sm:col-span-2">
            {DEPTHS.map((d) => (
              <button
                key={d.key}
                type="button"
                role="radio"
                aria-checked={form.spendLimit === d.key}
                onClick={() => setForm({ ...form, spendLimit: d.key })}
                className={`rounded-xl border px-3 py-2.5 text-left transition-all ${
                  form.spendLimit === d.key
                    ? "border-teal bg-teal/10 shadow-[0_1px_2px_rgba(22,24,29,0.08)]"
                    : "border-edge bg-panel-2 hover:border-edge-strong"
                }`}
              >
                <span className={`block text-[12.5px] font-semibold ${form.spendLimit === d.key ? "text-teal" : "text-ink"}`}>
                  {d.label}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-ink-faint">{d.hint}</span>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.ownershipRequired}
              onChange={(e) => setForm({ ...form, ownershipRequired: e.target.checked })}
              className="size-4 accent-teal"
            />
            <span className="text-[12px] leading-snug text-ink-soft">Ownership behind the counterparty is material</span>
          </label>

          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button
              type="button"
              onClick={() => {
                setFormError(null);
                setForm({ ...SAMPLE_FORM });
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal/40 bg-teal/10 px-3 py-1.5 text-[11.5px] font-medium text-teal transition-colors hover:bg-teal/15"
            >
              Fill sample values
            </button>
            {JSON.stringify(form) !== JSON.stringify(EMPTY_FORM) && (
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setForm({ ...EMPTY_FORM });
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-[11.5px] text-ink-soft transition-colors hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>

          {formError && (
            <p role="alert" className="rounded-lg border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk sm:col-span-2">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4 sm:col-span-2">
            <p className="text-[11px] leading-snug text-ink-faint">
              Nothing is spent until you approve the plan on the file.
            </p>
            <button type="submit" className="btn-primary !min-h-10" disabled={busy || !signedIn} title={signedIn ? undefined : "Connect your wallet first"}>
              {busy ? (
                <>
                  <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> Opening…
                </>
              ) : (
                <>
                  Open deal file <ArrowRight size={14} aria-hidden />
                </>
              )}
            </button>
          </div>
          {!signedIn && session.mode !== "loading" && (
            <p className="text-[11.5px] leading-relaxed text-ink-soft sm:col-span-2">
              Files belong to your wallet: connect it above (one signature, not a transaction) to open one.
            </p>
          )}
        </form>
      </section>

      {/* Free tools, demoted */}
      <details className="group mt-4 rounded-2xl border border-edge bg-panel/60 px-5 py-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink">
          Free wallet check — instant, read-only, no file needed
          <span aria-hidden className="transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="mt-4">
          <ScanCard />
        </div>
      </details>

      {/* Files */}
      <section aria-label="Your files" className="mt-12">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="x-label">Your files</h2>
          <button type="button" onClick={() => void refresh()} className="text-[11px] text-ink-faint transition-colors hover:text-ink">
            Refresh
          </button>
        </div>

        {listError && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber/40 bg-amber/5 px-4 py-3">
            <p className="text-[12.5px] text-amber">{listError}</p>
            <button type="button" onClick={() => void refresh()} className="btn-quiet !min-h-9 !px-3">
              Retry
            </button>
          </div>
        )}

        {rows === null && !listError ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 rounded-2xl bg-panel-2 motion-safe:animate-pulse" />
            ))}
          </div>
        ) : liveRows.length === 0 && !listError ? (
          <div className="mt-4 rounded-2xl border border-dashed border-edge bg-panel/40 px-6 py-10 text-center">
            <ShieldCheck size={20} aria-hidden className="mx-auto text-ink-faint" />
            <p className="mt-3 text-[13.5px] font-medium text-ink">No files yet.</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-faint">
              Open your first deal file above — the Solana inspection runs free before anything is paid.
            </p>
          </div>
        ) : (
          liveRows.length > 0 && (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {liveRows.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/desk/${row.id}`}
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
                    <p className="mt-auto flex items-center pt-3 text-[11px] text-ink-faint">
                      {new Date(row.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                      <ArrowRight size={12} aria-hidden className="ml-auto transition-transform group-hover:translate-x-0.5 group-hover:text-teal" />
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )
        )}
      </section>

      <p className="mt-10 text-[11px] leading-relaxed text-ink-faint">
        Read-only on chain state, shared approval and spend controls, and it never signs or broadcasts a settlement.
        Missing evidence stays missing — it is never inferred.
      </p>
    </div>
  );
}
