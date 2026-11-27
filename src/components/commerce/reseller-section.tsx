"use client";

/**
 * Reseller — package purchased specialist services into one higher-value
 * offering. The margin over the components' standalone prices is computed
 * live in the form and enforced server-side: a package that is not worth more
 * than its parts does not list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { friendlyNetworkError } from "@/lib/api/client-errors";
import { formatUsdc, usdcBaseUnits } from "@/lib/acp/buyer-browser";
import type { ResellerPackage } from "@/lib/commerce/types";
import { ActionError, EmptyNote, Field, FormRow, MicroHeading, Panel, StateChip, TextArea, TextInput } from "./ui-bits";

const STATUS_TONE: Record<string, "teal" | "faint"> = {
  listed: "teal",
  draft: "faint",
  retired: "faint",
};

export function ResellerSection({ buyerAddress }: { buyerAddress: string | null }) {
  const [packages, setPackages] = useState<ResellerPackage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ name: "", summary: "", components: "", packagePriceUsdCents: "" });

  const load = useCallback(async () => {
    if (!buyerAddress) return;
    setLoadError(null);
    try {
      const res = await fetch("/api/commerce/reseller", { cache: "no-store" });
      const body = (await res.json()) as { packages?: ResellerPackage[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `your packages could not be read (${res.status})`);
      setPackages(body.packages ?? []);
    } catch (err) {
      setLoadError(friendlyNetworkError(err));
    }
  }, [buyerAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setActionError(null);
    try {
      const res = await fetch("/api/commerce/reseller", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setActionError(body.error ?? `the action failed (${res.status})`);
        return false;
      }
      await load();
      return true;
    } catch (err) {
      setActionError(friendlyNetworkError(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const ok = await act({ action: "create", ...form }, "create");
    if (ok) {
      setForm({ name: "", summary: "", components: "", packagePriceUsdCents: "" });
      setFormOpen(false);
    }
  }

  // Live margin preview from the components textarea — the same arithmetic the
  // server enforces, shown before the write so the refusal is never a surprise.
  const preview = useMemo(() => {
    const lines = form.components.split("\n").map((l) => l.trim()).filter(Boolean);
    let sum = 0;
    let valid = lines.length > 0;
    for (const line of lines) {
      const price = Number(line.split("|")[1]?.trim());
      if (!line.split("|")[0]?.trim() || !Number.isFinite(price) || price <= 0) valid = false;
      else sum += price;
    }
    const pkgPrice = Number(form.packagePriceUsdCents);
    const margin = valid && Number.isFinite(pkgPrice) && pkgPrice > 0 ? pkgPrice - sum : null;
    return { valid, sum, margin, ok: margin !== null && margin > 0 };
  }, [form.components, form.packagePriceUsdCents]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MicroHeading>Your packages — each one must be worth more than its parts</MicroHeading>
        {buyerAddress && (
          <button type="button" onClick={() => setFormOpen((v) => !v)} className="btn-primary !min-h-9 !text-[12px]">
            {formOpen ? "Close" : "Build a package"}
          </button>
        )}
      </div>
      {!buyerAddress && <EmptyNote>Sign in with your wallet above to build and list reseller packages.</EmptyNote>}

      {formOpen && buyerAddress && (
        <Panel className="space-y-3">
          <MicroHeading>New package — components on separate lines: Label | price in USD cents</MicroHeading>
          <Field label="Package name">
            <TextInput value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} maxLength={200} />
          </Field>
          <Field label="What the package delivers">
            <TextArea value={form.summary} onChange={(e) => setForm((p) => ({ ...p, summary: e.target.value }))} />
          </Field>
          <Field label="Components" help="e.g. “Counterparty DD | 200” — the standalone price each component sells for on its own.">
            <TextArea value={form.components} onChange={(e) => setForm((p) => ({ ...p, components: e.target.value }))} />
          </Field>
          <Field label="Your package price (USD cents)">
            <TextInput inputMode="numeric" value={form.packagePriceUsdCents} onChange={(e) => setForm((p) => ({ ...p, packagePriceUsdCents: e.target.value.replace(/[^0-9]/g, "") }))} />
          </Field>
          {form.components.trim() !== "" && form.packagePriceUsdCents !== "" && (
            <p className={`text-[12px] leading-relaxed ${preview.ok ? "text-teal" : "text-amber-deep"}`}>
              {preview.valid && preview.margin !== null
                ? `Components sum ${preview.sum}¢ → your margin ${preview.margin}¢${preview.ok ? " — this package can list." : " — below the parts, it will not list."}`
                : "Check the component lines: each needs a label and a positive price in USD cents."}
            </p>
          )}
          <FormRow>
            <button type="button" disabled={busy !== null} onClick={() => void create()} className="btn-primary !min-h-9 !text-[12px]">
              {busy === "create" ? "Listing…" : "List package"}
            </button>
          </FormRow>
        </Panel>
      )}

      <ActionError error={actionError} onRetry={() => setActionError(null)} />
      <ActionError error={loadError} onRetry={() => void load()} />

      {packages === null && buyerAddress && !loadError && <EmptyNote>Loading your packages…</EmptyNote>}
      {buyerAddress && packages !== null && packages.length === 0 && <EmptyNote>No packages yet — bundle what the specialists sell into something bigger.</EmptyNote>}

      {(packages ?? []).map((p) => (
        <Panel key={p.id} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip tone={STATUS_TONE[p.status] ?? "faint"}>{p.status}</StateChip>
            <span className="tabular text-[11px] text-ink-faint">{p.reference}</span>
            <span className="tabular ml-auto text-[12px] font-semibold text-teal">
              {formatUsdc(usdcBaseUnits(p.packagePriceUsdCents))} · margin {formatUsdc(usdcBaseUnits(p.marginUsdCents))}
            </span>
          </div>
          <h3 className="text-[14px] font-semibold leading-snug text-ink">{p.name}</h3>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">{p.summary}</p>
          <ul className="space-y-0.5">
            {p.components.map((c, i) => (
              <li key={i} className="tabular text-[11.5px] text-ink-faint">
                {c.label} — {formatUsdc(usdcBaseUnits(c.unitPriceUsdCents))} standalone
              </li>
            ))}
          </ul>
          <FormRow>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                const next = window.prompt("New package price in USD cents", String(p.packagePriceUsdCents));
                if (next) void act({ action: "update", id: p.id, packagePriceUsdCents: next }, `price:${p.id}`);
              }}
              className="btn-quiet !min-h-8 !text-[11.5px]"
            >
              {busy === `price:${p.id}` ? "Saving…" : "Reprice"}
            </button>
            {p.status === "listed" && (
              <button type="button" disabled={busy !== null} onClick={() => void act({ action: "retire", id: p.id }, `retire:${p.id}`)} className="btn-quiet !min-h-8 !text-[11.5px]">
                {busy === `retire:${p.id}` ? "Retiring…" : "Retire"}
              </button>
            )}
          </FormRow>
        </Panel>
      ))}
    </div>
  );
}
