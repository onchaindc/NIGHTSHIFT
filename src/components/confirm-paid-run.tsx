"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, ShieldAlert } from "lucide-react";

/**
 * The one confirmation gate before any surface starts a PAID run.
 *
 * Paid runs stop at the approval gate — nothing is ever signed before the
 * reader approves the exact priced plan — but the run itself is one tap away
 * on a scrolling phone, so it asks first. The modal states plainly that the
 * run is paid, carries the cost when it is known (a hard ceiling; never an
 * invented number), and offers a real Cancel. Only Confirm starts the run.
 */
export interface ConfirmPaidRunProps {
  open: boolean;
  title: string;
  /** One sentence: what happens between Confirm and the approval gate. */
  body: string;
  /** The cost line as the surface knows it — ceiling or per-ask, or null when the price is set later by the live offer. */
  cost: string | null;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPaidRun({ open, title, body, cost, confirmLabel, busy, onConfirm, onCancel }: ConfirmPaidRunProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Cancel — close without starting the paid run"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-ink/45 backdrop-blur-[2px]"
      />
      <div className="x-modal-panel relative w-full max-w-md rounded-t-2xl border border-edge bg-panel p-4 shadow-[0_-12px_48px_-16px_rgba(0,0,0,0.45)] sm:rounded-2xl sm:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.5)] sm:p-5">
        <p className="flex items-center gap-2 text-[14.5px] font-semibold text-ink">
          <ShieldAlert size={15} aria-hidden className="shrink-0 text-amber-deep" />
          {title}
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{body}</p>
        <p className="mt-2.5 rounded-lg border border-amber/40 bg-amber/5 px-3 py-2.5 text-[12px] leading-relaxed text-amber-deep">
          {cost ?? "This run is paid. The exact amount is fixed by the live offer at the approval gate — nothing is signed until you approve it."}
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} disabled={busy} className="btn-quiet !min-h-10 w-full sm:w-auto">
            Cancel
          </button>
          <button type="button" ref={confirmRef} onClick={onConfirm} disabled={busy} className="btn-primary !min-h-10 w-full sm:w-auto">
            {busy && <LoaderCircle size={13} aria-hidden className="motion-safe:animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  , document.body)
);
}
