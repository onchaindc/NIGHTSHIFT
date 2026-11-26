"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, FileSearch, Plus } from "lucide-react";

import type { Investigation, InvestigationSummary } from "@/lib/assurance/types";
import { USDC_MINT_MAINNET } from "@/lib/assurance/types";

const DECISION_STYLE: Record<string, string> = {
  CLEARED: "border-teal/40 bg-teal/10 text-teal",
  HOLD: "border-amber/40 bg-amber/10 text-amber",
  ESCALATE: "border-risk/40 bg-risk/10 text-risk",
};

function DecisionChip({ value }: { value: string | null }) {
  if (!value) return <span className="text-[11px] text-ink-faint">Not assessed</span>;
  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10.5px] font-semibold tracking-wide ${DECISION_STYLE[value] ?? DECISION_STYLE.HOLD}`}>
      {value}
    </span>
  );
}

function ModeTag({ mode }: { mode: "live" | "demonstration" }) {
  return mode === "live" ? (
    <span className="text-[10.5px] font-medium text-ink-faint">Live</span>
  ) : (
    <span className="rounded-sm border border-edge-strong bg-panel-3 px-1.5 py-0.5 text-[10px] font-medium text-ink-soft">
      Demonstration
    </span>
  );
}

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

export function AssuranceIndex() {
  const [rows, setRows] = useState<InvestigationSummary[] | null>(null);
  const [scope, setScope] = useState<"operator" | "demonstration" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<Investigation | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/assurance", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as {
        investigations?: InvestigationSummary[];
        scope?: "operator" | "demonstration";
        error?: string;
      };
      if (!res.ok) {
        setLoadError(body.error ?? `The list failed with status ${res.status}.`);
        return;
      }
      setRows(body.investigations ?? []);
      setScope(body.scope ?? null);
      setLoadError(null);
    } catch (err) {
      setLoadError(`Could not reach the server. ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadDemo() {
    setBusy(true);
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
      setBusy(false);
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

  const field = "w-full rounded-md border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none";

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <header className="max-w-[62ch]">
          <p className="x-eyebrow">Institutional operations</p>
          <h1 className="x-display-1 mt-3 text-ink">Settlement assurance</h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
            Investigate a high-value Solana transaction before funds are authorized to move. Counterparty identity,
            ownership evidence, sanctions exposure, document integrity and asset restrictions are reconciled against
            one decision: <span className="font-semibold text-ink">CLEARED</span>,{" "}
            <span className="font-semibold text-ink">HOLD</span> or <span className="font-semibold text-ink">ESCALATE</span>.
          </p>
        </header>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void loadDemo()} disabled={busy} className="btn-quiet !min-h-10">
            <FileSearch size={14} aria-hidden /> Demonstration scenario
          </button>
          <button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary !min-h-10">
            <Plus size={14} aria-hidden /> New investigation
          </button>
        </div>
      </div>

      {loadError && (
        <p role="alert" className="mt-6 rounded-md border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk">
          {loadError}
        </p>
      )}

      {scope === "demonstration" && (
        <p className="mt-6 rounded-md border border-edge bg-panel-3 px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-soft">
          Demonstration preview: this list shows the synthetic sample file only. Live files and every action require
          the operator token (<span className="tabular">NIGHTSHIFT_API_TOKEN</span>).
        </p>
      )}

      {created && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-teal/40 bg-teal/5 px-4 py-3">
          <p className="text-[12.5px] text-ink-soft">
            File <span className="tabular">{created.reference}</span> opened. Next: inspect the wallets on Solana.
          </p>
          <Link href={`/assurance/${created.id}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-teal">
            Open the investigation <ArrowRight size={13} aria-hidden />
          </Link>
        </div>
      )}

      {showForm && (
        <section aria-label="New investigation" className="mt-7 rounded-md border border-edge bg-panel">
          <div className="border-b border-edge px-4 py-3 sm:px-5">
            <p className="text-[13px] font-semibold text-ink">Transaction under review</p>
            <p className="mt-0.5 text-[11.5px] text-ink-faint">
              Enter the settlement facts. Nothing is spent until an operator approves a paid plan on the file.
            </p>
          </div>
          <form
            className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
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
            <label className="block">
              <span className="x-label mb-1 block">Approved beneficiary (as named in the approval)</span>
              <input className={field} value={form.approvedBeneficiary} onChange={(e) => setForm({ ...form, approvedBeneficiary: e.target.value })} placeholder="Northstar Capital Holdings Ltd" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Counterparty legal name (as supplied)</span>
              <input className={field} value={form.counterpartyName} onChange={(e) => setForm({ ...form, counterpartyName: e.target.value })} placeholder="Northstar Capital Holdings Ltd" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Registration number</span>
              <input className={`${field} tabular`} value={form.registrationNumber} onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} placeholder="UK-09876543" />
            </label>
            <label className="block">
              <span className="x-label mb-1 block">Jurisdiction</span>
              <input className={`${field} tabular`} value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })} placeholder="GB" />
            </label>
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

            {formError && (
              <p role="alert" className="sm:col-span-2 rounded-md border border-risk/40 bg-risk/5 px-3 py-2 text-[12.5px] text-risk">
                {formError}
              </p>
            )}
            <div className="flex items-center justify-between gap-3 sm:col-span-2">
              <p className="text-[11px] leading-snug text-ink-faint">
                Solana inspection is free. Paid intelligence always stops at the operator approval gate.
              </p>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? "Opening…" : "Open investigation"}
              </button>
            </div>
          </form>
        </section>
      )}

      <section aria-label="Investigations" className="mt-10">
        <div className="flex items-baseline justify-between gap-3 border-b border-edge pb-2">
          <h2 className="x-label">Files</h2>
          <span className="tabular text-[11px] text-ink-faint">{rows?.length ?? 0} on record</span>
        </div>

        {rows === null ? (
          <div className="mt-3 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 rounded-md bg-panel-2 motion-safe:animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed border-edge bg-panel/40 px-5 py-12 text-center">
            <p className="text-[13px] text-ink-soft">No investigation on file.</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12px] text-ink-faint">
              Open a live file with a real transaction, or load the labelled demonstration scenario to see the full
              workflow from inspection to a held decision.
            </p>
          </div>
        ) : (
          <table className="mt-1 w-full">
            <thead>
              <tr className="text-left">
                <th className="x-label py-2 font-medium">File</th>
                <th className="x-label hidden py-2 font-medium sm:table-cell">Counterparty</th>
                <th className="x-label py-2 text-right font-medium">Amount</th>
                <th className="x-label py-2 text-right font-medium">Decision</th>
                <th className="x-label hidden py-2 text-right font-medium md:table-cell">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-edge align-middle transition-colors hover:bg-panel-3">
                  <td className="py-3 pr-3">
                    <Link href={`/assurance/${row.id}`} className="group block">
                      <span className="tabular text-[12px] font-medium text-ink group-hover:text-teal">{row.reference}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-faint">
                        {new Date(row.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                        <ModeTag mode={row.dataMode} />
                      </span>
                    </Link>
                  </td>
                  <td className="hidden py-3 pr-3 text-[12.5px] text-ink-soft sm:table-cell">{row.counterparty}</td>
                  <td className="tabular py-3 text-right text-[12.5px] text-ink">
                    {row.amountUsdc.toLocaleString("en-US")}
                  </td>
                  <td className="py-3 text-right">
                    <DecisionChip value={row.decision} />
                  </td>
                  <td className="tabular hidden py-3 text-right text-[12px] text-ink-faint md:table-cell">
                    {row.evidenceCount} records · {row.findingCount} findings
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="mt-10 text-[11px] leading-relaxed text-ink-faint">
        NIGHTSHIFT inspects Solana state read-only, reuses the shared Telegraph approval and spend controls, and never
        signs or broadcasts a settlement. Every decision cites the evidence behind it; missing evidence stays missing.
      </p>
    </div>
  );
}
