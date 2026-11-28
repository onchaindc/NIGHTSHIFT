"use client";

/**
 * Marketplace — the board: buyer requirements published for providers, with
 * their offers. Anyone can browse; a wallet session is needed to publish,
 * offer, accept or close. Offers reference the provider's own Capacity listing
 * or a published NIGHTSHIFT offering; acceptance opens a coordination workflow.
 */

import { useCallback, useEffect, useState } from "react";

import { friendlyNetworkError } from "@/lib/api/client-errors";
import { formatUsdc, usdcBaseUnits } from "@/lib/acp/buyer-browser";
import { COMMERCE_OFFERINGS } from "@/lib/commerce/catalog";
import { MARKETPLACE_CATEGORIES, type CapacityService, type MarketplaceCategory, type MarketplaceRequirement, type ResellerPackage } from "@/lib/commerce/types";
import { ActionError, EmptyNote, Field, FormRow, MicroHeading, Panel, SelectField, StateChip, TextArea, TextInput } from "./ui-bits";

interface Board {
  requirements: MarketplaceRequirement[];
  packages: ResellerPackage[];
}

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(MARKETPLACE_CATEGORIES.map((c) => [c, c.replace(/_/g, " ")]));

const STATUS_TONE: Record<string, "teal" | "amber" | "faint"> = {
  open: "teal",
  matched: "amber",
  in_progress: "amber",
  delivered: "teal",
  closed: "faint",
};

export function MarketplaceSection({ buyerAddress }: { buyerAddress: string | null }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [myServices, setMyServices] = useState<Array<{ id: string; name: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [offerFor, setOfferFor] = useState<string | null>(null);
  const [offerServiceId, setOfferServiceId] = useState("");
  const [offerMessage, setOfferMessage] = useState("");
  const [offerPrice, setOfferPrice] = useState("");
  const [deliveryFor, setDeliveryFor] = useState<string | null>(null);
  const [deliveryNote, setDeliveryNote] = useState("");
  const [deliveryUrl, setDeliveryUrl] = useState("");
  const [form, setForm] = useState({ title: "", category: "counterparty", detail: "", budgetUsdCents: "", deadline: "" });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/commerce/marketplace", { cache: "no-store" });
      const body = (await res.json()) as Board & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `the board could not be read (${res.status})`);
      setBoard({ requirements: body.requirements ?? [], packages: body.packages ?? [] });
    } catch (err) {
      setLoadError(friendlyNetworkError(err));
    }
  }, []);

  // Own capacity services for the offer picker (best effort: the offer can
  // also ride a published offering, so a failure here must not block the board).
  useEffect(() => {
    if (!buyerAddress) return;
    void (async () => {
      try {
        const res = await fetch("/api/commerce/capacity", { cache: "no-store" });
        const body = (await res.json()) as { services?: CapacityService[] };
        setMyServices((body.services ?? []).filter((s) => s.providerWallet === buyerAddress && s.status === "listed").map((s) => ({ id: s.id, name: s.name })));
      } catch {
        /* the offer can still reference a published offering */
      }
    })();
  }, [buyerAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setActionError(null);
    try {
      const res = await fetch("/api/commerce/marketplace", {
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

  async function publish() {
    const ok = await act({ action: "publish", ...form }, "publish");
    if (ok) {
      setForm({ title: "", category: form.category, detail: "", budgetUsdCents: "", deadline: "" });
      setPublishOpen(false);
    }
  }

  async function offerOn(requirementId: string) {
    const ok = await act(
      {
        action: "offer",
        requirementId,
        ...(offerServiceId.startsWith("catalog:") ? { offeringRef: offerServiceId.slice(8) } : { serviceId: offerServiceId || undefined }),
        message: offerMessage,
        priceUsdCents: offerPrice,
      },
      `offer:${requirementId}`,
    );
    if (ok) {
      setOfferFor(null);
      setOfferMessage("");
      setOfferPrice("");
      setOfferServiceId("");
    }
  }

  async function submitDelivery(requirementId: string) {
    const ok = await act(
      { action: "submitDelivery", requirementId, note: deliveryNote, artifactUrl: deliveryUrl },
      `delivery:${requirementId}`,
    );
    if (ok) {
      setDeliveryFor(null);
      setDeliveryNote("");
      setDeliveryUrl("");
    }
  }

  async function reviewDelivery(requirementId: string, decision: "accept" | "reject") {
    await act({ action: "reviewDelivery", requirementId, decision }, `review:${requirementId}`);
  }

  const requirements = board?.requirements ?? [];
  const packages = board?.packages ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MicroHeading>Buyer requirements — {requirements.length} open on the board</MicroHeading>
        {buyerAddress && (
          <button type="button" onClick={() => setPublishOpen((v) => !v)} className="btn-primary !min-h-9 !text-[12px]">
            {publishOpen ? "Close" : "Publish a requirement"}
          </button>
        )}
      </div>
      {!buyerAddress && (
        <EmptyNote>Sign in with your wallet above to publish a requirement or offer on one — browsing the board needs no session.</EmptyNote>
      )}

      {publishOpen && buyerAddress && (
        <Panel className="space-y-3">
          <MicroHeading>New requirement — auto-matched against provider services and published offerings at intake</MicroHeading>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" help="One line a provider can scan.">
              <TextInput value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} placeholder="Verify a new supplier before first PO" maxLength={200} />
            </Field>
            <Field label="Category" help="Drives the matching.">
              <SelectField value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}>
                {MARKETPLACE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </SelectField>
            </Field>
          </div>
          <Field label="What you need" help="Scope and depth, recorded verbatim.">
            <TextArea value={form.detail} onChange={(e) => setForm((p) => ({ ...p, detail: e.target.value }))} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Budget (USD cents, optional)" help="200 = $2.00.">
              <TextInput inputMode="numeric" value={form.budgetUsdCents} onChange={(e) => setForm((p) => ({ ...p, budgetUsdCents: e.target.value.replace(/[^0-9]/g, "") }))} />
            </Field>
            <Field label="Deadline (optional)">
              <TextInput value={form.deadline} onChange={(e) => setForm((p) => ({ ...p, deadline: e.target.value }))} maxLength={120} />
            </Field>
          </div>
          <FormRow>
            <button type="button" disabled={busy !== null} onClick={() => void publish()} className="btn-primary !min-h-9 !text-[12px]">
              {busy === "publish" ? "Publishing…" : "Publish to the board"}
            </button>
          </FormRow>
        </Panel>
      )}

      <ActionError error={actionError} onRetry={() => setActionError(null)} />
      <ActionError error={loadError} onRetry={() => void load()} />

      {board === null && !loadError && <EmptyNote>Loading the board…</EmptyNote>}
      {board !== null && requirements.length === 0 && <EmptyNote>No requirements on the board yet — publish the first one.</EmptyNote>}

      {requirements.map((r) => {
        const isOwner = buyerAddress !== null && r.ownerWallet === buyerAddress;
        return (
          <Panel key={r.id} className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <StateChip tone={STATUS_TONE[r.status] ?? "faint"}>{r.status.replace(/_/g, " ")}</StateChip>
              <StateChip tone="faint">{CATEGORY_LABEL[r.category] ?? r.category}</StateChip>
              <span className="tabular text-[11px] text-ink-faint">{r.reference}</span>
              <span className="ml-auto tabular text-[11px] text-ink-faint">
                {r.budgetUsdCents ? `budget ${formatUsdc(usdcBaseUnits(r.budgetUsdCents))} · ` : ""}
                {r.offers.length} offer(s){r.matchedServiceIds.length > 0 ? ` · ${r.matchedServiceIds.length} matched service(s)` : ""}
              </span>
            </div>
            <h3 className="text-[14px] font-semibold leading-snug text-ink">{r.title}</h3>
            <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-ink-soft">{r.detail}</p>
            {r.deadline && <p className="text-[11.5px] text-ink-faint">Needed: {r.deadline}</p>}

            {r.offers.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
                <MicroHeading>Provider offers</MicroHeading>
                {r.offers.map((o) => (
                  <div key={o.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] leading-relaxed">
                    <span className="tabular font-semibold text-ink">{formatUsdc(usdcBaseUnits(o.priceUsdCents))}</span>
                    <span className="text-ink-soft">{o.message}</span>
                    <span className="text-[10.5px] text-ink-faint">
                      {o.providerWallet} · {o.status}
                      {o.offeringRef ? " · published offering" : o.serviceId ? " · capacity listing" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {r.delivery && (
              <div className="space-y-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <MicroHeading>Provider delivery</MicroHeading>
                  <StateChip tone={r.delivery.status === "accepted" ? "teal" : r.delivery.status === "submitted" ? "amber" : "faint"}>{r.delivery.status}</StateChip>
                </div>
                <p className="whitespace-pre-line text-[12px] leading-relaxed text-ink-soft">{r.delivery.note}</p>
                {r.delivery.artifactUrl && <a href={r.delivery.artifactUrl} target="_blank" rel="noreferrer" className="break-all text-[11.5px] text-teal underline">Open delivery artifact</a>}
                {r.delivery.reviewerNote && <p className="text-[11px] text-ink-faint">Review note: {r.delivery.reviewerNote}</p>}
              </div>
            )}

            {buyerAddress && r.offers.some((o) => o.status === "accepted" && o.providerWallet === buyerAddress) && r.status !== "delivered" && r.status !== "closed" && r.delivery?.status !== "submitted" && (
              <div className="space-y-2 rounded-lg border border-edge bg-panel-2 px-3 py-3">
                <MicroHeading>Submit delivery</MicroHeading>
                <Field label="Delivery summary" help="Visible on the public board. Describe the completed work and what the buyer should verify.">
                  <TextArea value={deliveryFor === r.id ? deliveryNote : ""} onChange={(e) => { setDeliveryFor(r.id); setDeliveryNote(e.target.value); }} />
                </Field>
                <Field label="Artifact URL (optional)" help="Link to a report, evidence bundle or deliverable.">
                  <TextInput value={deliveryFor === r.id ? deliveryUrl : ""} onChange={(e) => { setDeliveryFor(r.id); setDeliveryUrl(e.target.value); }} placeholder="https://…" />
                </Field>
                <FormRow>
                  <button type="button" disabled={busy !== null || deliveryFor !== r.id || deliveryNote.trim() === ""} onClick={() => void submitDelivery(r.id)} className="btn-primary !min-h-8 !text-[11.5px]">
                    {busy === `delivery:${r.id}` ? "Submitting…" : "Submit for buyer review"}
                  </button>
                </FormRow>
              </div>
            )}

            {isOwner && r.delivery?.status === "submitted" && (
              <FormRow>
                <button type="button" disabled={busy !== null} onClick={() => void reviewDelivery(r.id, "accept")} className="btn-primary !min-h-8 !text-[11.5px]">
                  {busy === `review:${r.id}` ? "Reviewing…" : "Accept delivery"}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void reviewDelivery(r.id, "reject")} className="btn-quiet !min-h-8 !text-[11.5px]">
                  Request changes
                </button>
              </FormRow>
            )}

            {buyerAddress && !isOwner && r.status !== "closed" && (
              <FormRow>
                <button
                  type="button"
                  onClick={() => setOfferFor(offerFor === r.id ? null : r.id)}
                  className="btn-quiet !min-h-8 !text-[11.5px]"
                >
                  {offerFor === r.id ? "Cancel offer" : "Offer on this"}
                </button>
              </FormRow>
            )}
            {offerFor === r.id && buyerAddress && (
              <div className="space-y-2.5 rounded-lg border border-edge bg-panel-2 px-3 py-3">
                <Field label="What you offer" help="Your own capacity listing or a published NIGHTSHIFT offering.">
                  <SelectField value={offerServiceId} onChange={(e) => setOfferServiceId(e.target.value)}>
                    <option value="">Select a service or offering…</option>
                    {myServices.map((s) => (
                      <option key={s.id} value={s.id}>My listing: {s.name}</option>
                    ))}
                    {COMMERCE_OFFERINGS.map((o) => (
                      <option key={o.id} value={`catalog:${o.id}`}>Published: {o.name}</option>
                    ))}
                  </SelectField>
                </Field>
                <Field label="What you will deliver">
                  <TextArea value={offerMessage} onChange={(e) => setOfferMessage(e.target.value)} />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Your price (USD cents)">
                    <TextInput inputMode="numeric" value={offerPrice} onChange={(e) => setOfferPrice(e.target.value.replace(/[^0-9]/g, ""))} />
                  </Field>
                </div>
                <FormRow>
                  <button
                    type="button"
                    disabled={busy !== null || offerServiceId === "" || offerMessage.trim() === "" || offerPrice === ""}
                    onClick={() => void offerOn(r.id)}
                    className="btn-primary !min-h-8 !text-[11.5px]"
                  >
                    {busy === `offer:${r.id}` ? "Sending…" : "Send offer"}
                  </button>
                </FormRow>
              </div>
            )}

            {isOwner && r.status !== "closed" && (
              <FormRow>
                {r.offers.some((o) => o.status === "pending") &&
                  r.offers
                    .filter((o) => o.status === "pending")
                    .map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void act({ action: "accept", requirementId: r.id, offerId: o.id }, `accept:${o.id}`)}
                        className="btn-signal !min-h-8 !text-[11.5px]"
                      >
                        {busy === `accept:${o.id}` ? "Accepting…" : `Accept ${formatUsdc(usdcBaseUnits(o.priceUsdCents))} offer`}
                      </button>
                    ))}
                <button type="button" disabled={busy !== null} onClick={() => void act({ action: "close", requirementId: r.id }, `close:${r.id}`)} className="btn-quiet !min-h-8 !text-[11.5px]">
                  {busy === `close:${r.id}` ? "Closing…" : "Close"}
                </button>
              </FormRow>
            )}
          </Panel>
        );
      })}

      {packages.length > 0 && (
        <div className="space-y-2 pt-1">
          <MicroHeading>Reseller packages on the board</MicroHeading>
          {packages.map((p) => (
            <Panel key={p.id} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular text-[11px] text-ink-faint">{p.reference}</span>
                <StateChip tone="teal">{formatUsdc(usdcBaseUnits(p.packagePriceUsdCents))}</StateChip>
                <span className="ml-auto text-[11px] text-ink-faint">by {p.ownerWallet}</span>
              </div>
              <h3 className="text-[14px] font-semibold text-ink">{p.name}</h3>
              <p className="text-[12.5px] leading-relaxed text-ink-soft">{p.summary}</p>
              <p className="tabular text-[11px] text-ink-faint">
                {p.components.length} component(s) · margin {formatUsdc(usdcBaseUnits(p.marginUsdCents))}
              </p>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
