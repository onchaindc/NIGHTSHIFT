"use client";

/**
 * The Agent Commerce desk — the four internal Buyer Desk sections
 * (Marketplace, Capacity, Workflows, Reseller) plus the intro storefront that
 * carries their $0.01 offerings on the internal credit rail.
 *
 * Deliberately separate from the ACP purchase journey: the six-stage ACP flow
 * above runs on the REAL Virtuals protocol with the buyer's wallet; commerce
 * purchases settle internally during the intro period and never request a
 * signature. The two rails share the page, not the money.
 */

import { useCallback, useEffect, useState } from "react";

import { friendlyNetworkError } from "@/lib/api/client-errors";
import { formatUsdc, usdcBaseUnits } from "@/lib/acp/buyer-browser";
import { COMMERCE_OFFERINGS } from "@/lib/commerce/catalog";
import type { CommerceJob, CommerceOffering, CommerceSection } from "@/lib/commerce/types";
import { COMMERCE_SECTIONS, COMMERCE_SECTION_LABEL } from "@/lib/commerce/types";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";
import { SampleFill } from "@/components/sample-fill";
import { ActionError, EmptyNote, Field, FormRow, MicroHeading, Panel, StateChip, TextArea, TextInput, SelectField } from "./ui-bits";
import { MarketplaceSection } from "./marketplace-section";
import { CapacitySection } from "./capacity-section";
import { WorkflowsSection } from "./workflows-section";
import { ResellerSection } from "./reseller-section";
import { CommerceJobs } from "./commerce-jobs";

type Tab = "intro" | CommerceSection;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "intro", label: "Intro offerings" },
  ...COMMERCE_SECTIONS.map((s) => ({ id: s as Tab, label: COMMERCE_SECTION_LABEL[s] })),
];

export function CommerceDesk({
  buyerAddress,
  signedIn,
  onSession,
}: {
  buyerAddress: string | null;
  signedIn: boolean;
  onSession: (session: SessionState) => void;
}) {
  const [tab, setTab] = useState<Tab>("intro");
  const [openOffering, setOpenOffering] = useState<string | null>(null);
  const [purchaseInput, setPurchaseInput] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<CommerceJob[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastFulfilled, setLastFulfilled] = useState<CommerceJob | null>(null);

  const loadJobs = useCallback(async () => {
    if (!signedIn) {
      setJobs(null);
      return;
    }
    try {
      const res = await fetch("/api/commerce/jobs", { cache: "no-store" });
      if (!res.ok) {
        setJobs([]);
        return;
      }
      const body = (await res.json()) as { jobs?: CommerceJob[] };
      setJobs(body.jobs ?? []);
    } catch {
      setJobs([]);
    }
  }, [signedIn]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  async function purchase(offering: CommerceOffering) {
    if (!signedIn) return;
    setBusy(offering.id);
    setActionError(null);
    try {
      const res = await fetch("/api/commerce/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offeringId: offering.id, input: purchaseInput }),
      });
      const body = (await res.json()) as { job?: CommerceJob; error?: string };
      if (!res.ok || !body.job) {
        setActionError(body.error ?? `the purchase could not be fulfilled (${res.status})`);
        return;
      }
      setLastFulfilled(body.job);
      setOpenOffering(null);
      setPurchaseInput({});
      await loadJobs();
    } catch (err) {
      setActionError(friendlyNetworkError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Sign-in — one personal_sign proves the wallet; never a transaction */}
      {!signedIn && (
        <Panel className="space-y-2.5">
          <MicroHeading>Your commerce wallet</MicroHeading>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            Publishing, listing, running workflows and building packages bind to your wallet session. One signature proves the wallet is yours — it is
            not a transaction; no funds move, no gas.
          </p>
          <WalletSignIn onSession={onSession} />
        </Panel>
      )}

      {/* Section rail */}
      <nav aria-label="Agent Commerce sections" className="rounded-xl border border-edge bg-panel px-2 py-2">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                tab === t.id ? "bg-teal/10 text-teal" : "text-ink-faint hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="px-1.5 pt-1.5 text-[11px] leading-relaxed text-ink-faint">
          Introductory price $0.01 per offering — settled internally by NIGHTSHIFT. No wallet signature, no escrow, no on-chain movement. The published
          ACP services above are untouched and keep running on the real protocol.
        </p>
      </nav>

      <ActionError error={actionError} onRetry={() => setActionError(null)} />

      {lastFulfilled && tab === "intro" && (
        <Panel className="space-y-1.5 border-teal/30 bg-teal/5">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip tone="teal">{lastFulfilled.status}</StateChip>
            <span className="tabular text-[11px] text-ink-faint">{COMMERCE_SECTION_LABEL[lastFulfilled.section]}</span>
          </div>
          <p className="text-[12.5px] font-medium leading-snug text-ink">{lastFulfilled.deliverable?.title}</p>
          <p className="text-[12px] leading-relaxed text-ink-soft">{lastFulfilled.deliverable?.detail}</p>
          <button
            type="button"
            onClick={() => {
              setTab(lastFulfilled.section);
              setLastFulfilled(null);
            }}
            className="btn-signal !min-h-8 !text-[11.5px]"
          >
            Open the {COMMERCE_SECTION_LABEL[lastFulfilled.section]} section
          </button>
        </Panel>
      )}

      {tab === "intro" && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {COMMERCE_OFFERINGS.map((o) => (
              <Panel key={o.id} className="flex flex-col space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="rounded-md border border-teal/30 bg-teal/5 px-2 py-0.5 tabular text-[11.5px] font-semibold text-teal">
                    {formatUsdc(usdcBaseUnits(o.priceUsdCents))} intro
                  </span>
                  <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">{COMMERCE_SECTION_LABEL[o.section]}</span>
                </div>
                <div>
                  <h3 className="text-[14.5px] font-semibold leading-snug text-ink">{o.name}</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{o.description}</p>
                </div>
                <p className="text-[11.5px] leading-relaxed text-ink-faint">You receive: {o.deliverable}</p>
                {openOffering === o.id ? (
                  <div className="space-y-2.5 border-t border-edge pt-2.5">
                    {o.inputs.map((f) => (
                      <Field key={f.name} label={f.label} help={f.help}>
                        {f.kind === "textarea" ? (
                          <TextArea
                            value={purchaseInput[f.name] ?? ""}
                            onChange={(e) => setPurchaseInput((p) => ({ ...p, [f.name]: e.target.value }))}
                          />
                        ) : f.kind === "select" ? (
                          <SelectField value={purchaseInput[f.name] ?? ""} onChange={(e) => setPurchaseInput((p) => ({ ...p, [f.name]: e.target.value }))}>
                            <option value="">Select…</option>
                            {(f.options ?? []).map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </SelectField>
                        ) : (
                          <TextInput
                            inputMode={f.kind === "number" ? "numeric" : undefined}
                            value={purchaseInput[f.name] ?? ""}
                            onChange={(e) =>
                              setPurchaseInput((p) => ({ ...p, [f.name]: f.kind === "number" ? e.target.value.replace(/[^0-9]/g, "") : e.target.value }))
                            }
                          />
                        )}
                      </Field>
                    ))}
                    <FormRow>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void purchase(o)}
                        className="btn-primary !min-h-9 !text-[12px]"
                      >
                        {busy === o.id ? "Fulfilling…" : `Purchase for ${formatUsdc(usdcBaseUnits(o.priceUsdCents))}`}
                      </button>
                      <button type="button" onClick={() => setOpenOffering(null)} className="btn-quiet !min-h-9 !text-[12px]">
                        Cancel
                      </button>
                      <SampleFill onFill={() => setPurchaseInput({ ...(o.samples ?? {}) })} />
                    </FormRow>
                  </div>
                ) : (
                  <FormRow>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenOffering(o.id);
                        setPurchaseInput({});
                      }}
                      disabled={!signedIn}
                      className="btn-quiet w-full !min-h-9 !text-[12px] sm:w-auto"
                    >
                      {signedIn ? "Configure & purchase" : "Sign in to purchase"}
                    </button>
                  </FormRow>
                )}
              </Panel>
            ))}
          </div>
          {jobs !== null && (
            <div className="pt-1">
              <CommerceJobs jobs={jobs} />
            </div>
          )}
        </div>
      )}

      {tab === "marketplace" && <MarketplaceSection buyerAddress={buyerAddress} />}
      {tab === "capacity" && <CapacitySection buyerAddress={buyerAddress} />}
      {tab === "workflows" && <WorkflowsSection buyerAddress={buyerAddress} />}
      {tab === "reseller" && <ResellerSection buyerAddress={buyerAddress} />}
    </div>
  );
}
