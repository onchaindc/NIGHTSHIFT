"use client";

/**
 * The storefront — four distinct, designed service cards. Choosing one
 * moves the buyer into that service's dedicated request flow; the request
 * forms never stack underneath the catalogue.
 */

import { ArrowRight, FileText, Fingerprint, Landmark, Ship } from "lucide-react";

import type { AcpServiceOffering } from "@/lib/acp/types";
import { formatUsdc, usdcBaseUnits } from "@/lib/acp/buyer-browser";

const ICONS = [Fingerprint, Landmark, FileText, Ship];

export function Storefront({ offerings, onPick, busy }: { offerings: AcpServiceOffering[]; onPick: (o: AcpServiceOffering) => void; busy: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {offerings.map((o, i) => {
        const Icon = ICONS[i % ICONS.length];
        const price = formatUsdc(usdcBaseUnits(o.priceUsdCents));
        const requiredCount = o.inputs.filter((f) => f.required).length;
        return (
          <article key={o.id} className="flex flex-col rounded-xl border border-edge bg-panel transition-colors hover:border-edge-strong">
            <div className="flex-1 space-y-2.5 px-4 py-4">
              <div className="flex items-start justify-between gap-2">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-edge bg-panel-3 text-teal">
                  <Icon size={15} strokeWidth={1.7} aria-hidden />
                </span>
                <span className="rounded-md border border-teal/30 bg-teal/5 px-2 py-0.5 tabular text-[11.5px] font-semibold text-teal">{price} USDC</span>
              </div>
              <div>
                <h3 className="text-[15px] font-semibold leading-snug text-ink">{o.name}</h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{clamp(o.description, 190)}</p>
              </div>
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                You receive: {clamp(o.outputs, 130)}
              </p>
              <p className="tabular text-[11px] text-ink-faint">
                {o.inputs.length} inputs · {requiredCount} required · runs on Base
              </p>
            </div>
            <div className="border-t border-edge px-4 py-3">
              <button
                type="button"
                onClick={() => onPick(o)}
                disabled={busy}
                className="btn-primary w-full !min-h-9 !text-[12.5px] sm:w-auto"
                aria-label={`Configure a request for ${o.name}`}
              >
                Configure request <ArrowRight size={13} aria-hidden />
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  // Cut at a word boundary — "provenance. S…" reads broken; "provenance…" reads intentional.
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).replace(/[,.;:]$/, "").trimEnd()}…`;
}
