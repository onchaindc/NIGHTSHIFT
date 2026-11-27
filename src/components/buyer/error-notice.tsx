"use client";

/**
 * The buyer's error block — the replacement for raw RPC dumps.
 *
 * Structure (from tx-errors.ts): a short human title, one clear
 * explanation, specific recovery actions, and the raw detail ONLY inside
 * an expandable technical section. The signed payload and the RPC
 * internals never appear in the normal interface.
 */

import { useState } from "react";
import { ChevronDown, CircleAlert } from "lucide-react";

import type { TxErrorView } from "@/lib/acp/tx-errors";

export function ErrorNotice({ error, onRetry, tone = "error" }: { error: TxErrorView; onRetry?: () => void; tone?: "error" | "attention" }) {
  const [open, setOpen] = useState(false);
  const border = tone === "error" ? "border-risk/30" : "border-amber/40";
  const titleColor = tone === "error" ? "text-risk" : "text-amber-deep";

  return (
    <div className={`rounded-lg border ${border} bg-panel-2 px-3.5 py-3`} role="alert">
      <p className={`flex items-start gap-2 text-[13.5px] font-semibold leading-snug ${titleColor}`}>
        <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0" />
        {error.title}
      </p>
      <p className="mt-1 pl-[23px] text-[12.5px] leading-relaxed text-ink-soft">{error.explanation}</p>
      {error.actions.length > 0 && (
        <ul className="mt-2 space-y-1 pl-[23px]">
          {error.actions.map((a, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[12px] leading-relaxed text-ink">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-faint" />
              {a}
            </li>
          ))}
        </ul>
      )}
      {onRetry && error.code !== "user_rejected" && (
        <div className="mt-2.5 pl-[23px]">
          <button type="button" onClick={onRetry} className="btn-quiet !min-h-8 !text-[12px]">
            Try again
          </button>
        </div>
      )}
      <details className="mt-2.5 pl-[23px]">
        <summary
          onClick={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
          className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-ink-faint hover:text-ink-soft"
        >
          Technical details
          <ChevronDown size={12} aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </summary>
        {open && <p className="mt-1.5 break-words [overflow-wrap:anywhere] rounded-md border border-edge bg-panel-3 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-faint">{error.technical ?? "no detail"}</p>}
      </details>
    </div>
  );
}
