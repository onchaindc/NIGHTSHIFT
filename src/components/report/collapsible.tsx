import type { ReactNode } from "react";

/**
 * A closed-by-default disclosure for a report's secondary sections.
 *
 * Native <details>/<summary>: no client JavaScript, no hydration cost, and no
 * state to clean up. The summary row always carries a count, so a collapsed
 * section still says how much it holds before the reader commits to opening
 * it. The result surfaces use this to keep the answer first and the machinery
 * one tap away.
 */
const TONE_DOT: Record<string, string> = {
  neutral: "bg-edge-strong",
  amber: "bg-amber",
  risk: "bg-risk",
  teal: "bg-teal",
};

export function ReportDisclosure({
  title,
  count,
  tone = "neutral",
  children,
}: {
  title: string;
  count?: number;
  tone?: "neutral" | "amber" | "risk" | "teal";
  children: ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-edge bg-panel-2/60">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone] ?? TONE_DOT.neutral}`} />
          <span className="min-w-0 truncate">{title}</span>
          {count !== undefined && (
            <span className="tabular shrink-0 rounded-full border border-edge bg-panel px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-faint">
              {count}
            </span>
          )}
        </span>
        <span aria-hidden className="shrink-0 text-[11px] text-ink-faint transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="border-t border-edge px-3.5 py-3">{children}</div>
    </details>
  );
}
