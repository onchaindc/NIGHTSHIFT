"use client";

/**
 * The purchase journey's visible rail: Storefront → Configure → Review →
 * Payment → Tracking → Deliverable. Desktop shows the six labels; mobile
 * keeps the same rail as compact dots plus the current step's name — a
 * deliberate mobile layout, not a squeezed desktop strip.
 */

import { Check } from "lucide-react";

import { JOURNEY_STEPS } from "@/lib/acp/buyer-stages";

export function StageNav({ current, livePhase }: { current: number; livePhase?: string | null }) {
  return (
    <nav aria-label="Purchase progress" className="rounded-xl border border-edge bg-panel px-3 py-2.5 sm:px-4">
      {/* Mobile: current step speaks, the rail stays compact */}
      <div className="flex items-center justify-between gap-2 sm:hidden">
        <div className="flex min-w-0 items-center gap-1.5">
          {JOURNEY_STEPS.map((_, i) => (
            <span
              key={i}
              aria-hidden
              className={`h-1.5 flex-1 rounded-full ${i + 1 < current ? "bg-teal/60" : i + 1 === current ? "bg-teal" : "bg-edge"}`}
            />
          ))}
        </div>
        <span className="shrink-0 text-[11px] font-medium text-ink">{JOURNEY_STEPS[current - 1]}</span>
      </div>
      {/* Desktop: the full rail */}
      <ol className="hidden items-center gap-1.5 sm:flex">
        {JOURNEY_STEPS.map((label, i) => {
          const step = i + 1;
          const state = step < current ? "done" : step === current ? "active" : "ahead";
          return (
            <li key={label} className="flex min-w-0 items-center gap-1.5" aria-current={state === "active" ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={`h-px w-3 shrink-0 ${step <= current ? "bg-teal/50" : "bg-edge"}`} />}
              <span
                className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold ${
                  state === "done"
                    ? "border-teal bg-teal text-panel"
                    : state === "active"
                      ? "border-teal bg-teal/10 text-teal"
                      : "border-edge bg-panel-2 text-ink-faint/70"
                }`}
                aria-hidden
              >
                {state === "done" ? <Check size={9} strokeWidth={3} /> : step}
              </span>
              <span className={`truncate text-[11px] tracking-wide ${state === "active" ? "font-medium text-ink" : state === "done" ? "text-ink-soft" : "text-ink-faint/80"}`}>{label}</span>
            </li>
          );
        })}
      </ol>
      {livePhase && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint sm:hidden">{livePhase}</p>}
    </nav>
  );
}
