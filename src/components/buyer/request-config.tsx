"use client";

/**
 * The request configuration — the selected offering's OWN form, separate
 * from the storefront: only this service's fields, with labels,
 * descriptions, required markers, per-field validation, and the
 * "Fill sample values" wand whose samples come from the workflow's worked
 * example (they satisfy the schema — pinned by tests).
 */

import { useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { SampleFill } from "@/components/sample-fill";
import type { AcpServiceOffering } from "@/lib/acp/types";
import { formatUsdc, usdcBaseUnits } from "@/lib/acp/buyer-browser";
import { missingRequired, usableSamples } from "@/lib/acp/buyer-stages";

export function RequestConfig({
  offering,
  subject,
  onChange,
  onBack,
  onContinue,
  onFillSamples,
}: {
  offering: AcpServiceOffering;
  subject: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onBack: () => void;
  onContinue: () => void;
  onFillSamples: () => void;
}) {
  const missing = missingRequired(offering, subject);
  const canContinue = missing.length === 0;
  // Validation is quiet until the buyer interacts: a clean form shows no
  // red; a field shows its error once touched, and everything shows on a
  // blocked Continue attempt.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const showFieldError = (name: string) => touched[name] === true || attempted;

  return (
    <section aria-label={`Configure your request for ${offering.name}`} className="space-y-3">
      <header className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
        <p className="x-label !mt-0">Configure · {offering.name}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          Only the fields this service actually runs. Everything here is submitted as the job&apos;s structured requirement — the investigation executes exactly what you write.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <SampleFill onFill={onFillSamples} />
          <span className="text-[11px] text-ink-faint">— fills a worked example you can edit; replace it with your real subject.</span>
        </div>
      </header>

      <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
        <div className="space-y-4">
          {offering.inputs.map((f) => {
            const value = subject[f.name] ?? "";
            const invalid = f.required && !value.trim() && showFieldError(f.name);
            const stray = value.trim() !== "" && f.kind === "select" && f.options && !f.options.some((o) => o.value === value) && showFieldError(f.name);
            return (
              <div key={f.name}>
                <label className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] font-medium text-ink" htmlFor={`bf-${f.name}`}>
                  {f.label}
                  {f.required && (
                    <span className="text-risk" title="Required">
                      *
                    </span>
                  )}
                </label>
                {f.help && <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">{f.help}</p>}
                {f.kind === "textarea" ? (
                  <textarea
                    id={`bf-${f.name}`}
                    value={value}
                    onChange={(e) => {
                      setTouched((p) => ({ ...p, [f.name]: true }));
                      onChange(f.name, e.target.value);
                    }}
                    placeholder={f.help ?? ""}
                    rows={3}
                    aria-invalid={invalid ? true : undefined}
                    className="mt-1.5 w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge aria-invalid:border-risk/50"
                  />
                ) : f.kind === "select" ? (
                  <select
                    id={`bf-${f.name}`}
                    value={value}
                    onChange={(e) => {
                      setTouched((p) => ({ ...p, [f.name]: true }));
                      onChange(f.name, e.target.value);
                    }}
                    aria-invalid={stray || invalid ? true : undefined}
                    className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13px] text-ink outline-none focus:ring-1 focus:ring-edge aria-invalid:border-risk/50"
                  >
                    <option value="">Choose…</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`bf-${f.name}`}
                    type="text"
                    inputMode={f.kind === "number" ? "decimal" : undefined}
                    value={value}
                    onChange={(e) => {
                      setTouched((p) => ({ ...p, [f.name]: true }));
                      onChange(f.name, e.target.value);
                    }}
                    placeholder={f.help ?? ""}
                    aria-invalid={invalid ? true : undefined}
                    className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge aria-invalid:border-risk/50"
                  />
                )}
                {invalid && <p className="mt-1 text-[11.5px] text-risk">{f.label} is required.</p>}
                {stray && <p className="mt-1 text-[11.5px] text-risk">Pick one of the listed options.</p>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-edge bg-panel px-4 py-3.5 sm:px-5">
        <details>
          <summary className="cursor-pointer list-none">
            <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Execution policy — what runs, and what needs whose approval</span>
          </summary>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{offering.executionPolicy}</p>
        </details>
      </div>

      {/* Actions — full-width on mobile, inline on desktop */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button type="button" onClick={onBack} className="btn-quiet order-2 w-full !min-h-9 sm:order-1 sm:w-auto">
          <ArrowLeft size={13} aria-hidden /> Storefront
        </button>
        <button
          type="button"
          onClick={() => {
            if (!canContinue) {
              setAttempted(true);
              return;
            }
            onContinue();
          }}
          className="btn-primary order-1 w-full !min-h-9 sm:order-2 sm:w-auto"
        >
          Review request <ArrowRight size={13} aria-hidden />
        </button>
      </div>
      {!canContinue && <p className="text-[11.5px] text-ink-faint">Fill {missing.join(", ")} to continue — the price is {formatUsdc(usdcBaseUnits(offering.priceUsdCents))} USDC.</p>}
    </section>
  );
}
