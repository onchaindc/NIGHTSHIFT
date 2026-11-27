"use client";

/**
 * Capacity — the provider directory. Every listed service with its price,
 * availability and matrix-verification verdict; a signed-in provider lists,
 * reprices, pauses and retires their own services.
 */

import { useCallback, useEffect, useState } from "react";

import { friendlyNetworkError } from "@/lib/api/client-errors";
import { formatUsdc, usdcBaseUnits } from "@/lib/acp/buyer-browser";
import { MARKETPLACE_CATEGORIES, type CapacityService } from "@/lib/commerce/types";
import { ActionError, EmptyNote, Field, FormRow, MicroHeading, Panel, SelectField, StateChip, TextArea, TextInput } from "./ui-bits";

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(MARKETPLACE_CATEGORIES.map((c) => [c, c.replace(/_/g, " ")]));

const AVAILABILITY_TONE: Record<string, "teal" | "amber" | "faint"> = {
  available: "teal",
  busy: "amber",
  paused: "faint",
};

export function CapacitySection({ buyerAddress }: { buyerAddress: string | null }) {
  const [services, setServices] = useState<CapacityService[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ name: "", category: "counterparty", summary: "", priceUsdCents: "", delivery: "", slaHours: "", capabilities: "" });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/commerce/capacity", { cache: "no-store" });
      const body = (await res.json()) as { services?: CapacityService[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `the directory could not be read (${res.status})`);
      setServices(body.services ?? []);
    } catch (err) {
      setLoadError(friendlyNetworkError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setActionError(null);
    try {
      const res = await fetch("/api/commerce/capacity", {
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

  async function listService() {
    const ok = await act({ action: "list", ...form }, "list");
    if (ok) {
      setForm({ name: "", category: form.category, summary: "", priceUsdCents: "", delivery: "", slaHours: "", capabilities: "" });
      setFormOpen(false);
    }
  }

  const mine = buyerAddress ? (services ?? []).filter((s) => s.providerWallet === buyerAddress) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MicroHeading>Provider services — {services?.length ?? 0} listed</MicroHeading>
        {buyerAddress && (
          <button type="button" onClick={() => setFormOpen((v) => !v)} className="btn-primary !min-h-9 !text-[12px]">
            {formOpen ? "Close" : "List a service"}
          </button>
        )}
      </div>
      {!buyerAddress && <EmptyNote>Sign in with your wallet above to list your own services — browsing the directory needs no session.</EmptyNote>}

      {formOpen && buyerAddress && (
        <Panel className="space-y-3">
          <MicroHeading>New service listing — capability keys are checked against the verified matrix</MicroHeading>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Service name">
              <TextInput value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} maxLength={200} />
            </Field>
            <Field label="Category" help="Which requirements get matched against this listing.">
              <SelectField value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}>
                {MARKETPLACE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </SelectField>
            </Field>
          </div>
          <Field label="What you deliver">
            <TextArea value={form.summary} onChange={(e) => setForm((p) => ({ ...p, summary: e.target.value }))} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Price (USD cents)" help="150 = $1.50 per delivery.">
              <TextInput inputMode="numeric" value={form.priceUsdCents} onChange={(e) => setForm((p) => ({ ...p, priceUsdCents: e.target.value.replace(/[^0-9]/g, "") }))} />
            </Field>
            <Field label="Turnaround (hours, optional)">
              <TextInput inputMode="numeric" value={form.slaHours} onChange={(e) => setForm((p) => ({ ...p, slaHours: e.target.value.replace(/[^0-9]/g, "") }))} />
            </Field>
          </div>
          <Field label="What the buyer receives (optional)">
            <TextArea value={form.delivery} onChange={(e) => setForm((p) => ({ ...p, delivery: e.target.value }))} />
          </Field>
          <Field label="Capability keys (optional)" help='Comma-separated mind:dimension keys, e.g. "bitcoin-mining:hashrate". Unresolvable keys keep the listing unverified and are named on it.'>
            <TextInput value={form.capabilities} onChange={(e) => setForm((p) => ({ ...p, capabilities: e.target.value }))} />
          </Field>
          <FormRow>
            <button type="button" disabled={busy !== null} onClick={() => void listService()} className="btn-primary !min-h-9 !text-[12px]">
              {busy === "list" ? "Listing…" : "List this service"}
            </button>
          </FormRow>
        </Panel>
      )}

      <ActionError error={actionError} onRetry={() => setActionError(null)} />
      <ActionError error={loadError} onRetry={() => void load()} />

      {services === null && !loadError && <EmptyNote>Loading the directory…</EmptyNote>}
      {services !== null && services.length === 0 && <EmptyNote>No services listed yet — register the first one.</EmptyNote>}

      {(services ?? []).map((s) => {
        const own = buyerAddress !== null && s.providerWallet === buyerAddress;
        return (
          <Panel key={s.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StateChip tone={AVAILABILITY_TONE[s.availability] ?? "faint"}>{s.availability}</StateChip>
              {s.verified ? <StateChip tone="teal">matrix-verified</StateChip> : s.capabilities.length > 0 ? <StateChip tone="amber">unverified capabilities</StateChip> : null}
              <StateChip tone="faint">{CATEGORY_LABEL[s.category] ?? s.category}</StateChip>
              <span className="tabular text-[11px] text-ink-faint">{s.reference}</span>
              <span className="tabular ml-auto text-[12px] font-semibold text-teal">{formatUsdc(usdcBaseUnits(s.priceUsdCents))}</span>
            </div>
            <h3 className="text-[14px] font-semibold leading-snug text-ink">{s.name}</h3>
            <p className="text-[12.5px] leading-relaxed text-ink-soft">{s.summary}</p>
            {s.delivery && <p className="text-[11.5px] leading-relaxed text-ink-faint">You receive: {s.delivery}</p>}
            <p className="tabular text-[11px] text-ink-faint">
              by {s.providerWallet}
              {s.slaHours ? ` · turnaround ~${s.slaHours}h` : ""}
              {s.capabilities.length > 0 ? ` · ${s.capabilities.length} declared capability(ies)` : ""}
            </p>
            {own && (
              <FormRow>
                {(["available", "busy", "paused"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    disabled={busy !== null || s.availability === a}
                    onClick={() => void act({ action: "update", id: s.id, availability: a }, `avail:${s.id}:${a}`)}
                    className="btn-quiet !min-h-8 !text-[11.5px]"
                  >
                    {a}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    const next = window.prompt("New price in USD cents", String(s.priceUsdCents));
                    if (next) void act({ action: "update", id: s.id, priceUsdCents: next }, `price:${s.id}`);
                  }}
                  className="btn-quiet !min-h-8 !text-[11.5px]"
                >
                  {busy === `price:${s.id}` ? "Saving…" : "Reprice"}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void act({ action: "retire", id: s.id }, `retire:${s.id}`)} className="btn-quiet !min-h-8 !text-[11.5px]">
                  {busy === `retire:${s.id}` ? "Retiring…" : "Retire"}
                </button>
              </FormRow>
            )}
          </Panel>
        );
      })}

      {mine.length === 0 && buyerAddress && services !== null && services.length > 0 && (
        <EmptyNote>You have no services listed yet — your listings would appear here with their management controls.</EmptyNote>
      )}
    </div>
  );
}
