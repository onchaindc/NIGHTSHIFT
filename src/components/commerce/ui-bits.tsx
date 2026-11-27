"use client";

/**
 * Shared form and record primitives for the Agent Commerce sections — the same
 * design language as the Buyer Desk (panel cards, x-label micro-headings,
 * quiet buttons, 16px+ inputs on phones via the global guard).
 */

import type { ReactNode } from "react";

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5 ${className}`}>{children}</div>;
}

export function MicroHeading({ children }: { children: ReactNode }) {
  return <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">{children}</p>;
}

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[12px] font-medium text-ink">{label}</span>
      {children}
      {help && <span className="block text-[11px] leading-relaxed text-ink-faint">{help}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint/60 focus:border-teal/50 focus:outline-none";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} !min-h-10 ${props.className ?? ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} min-h-20 ${props.className ?? ""}`} />;
}

export function SelectField(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} !min-h-10 ${props.className ?? ""}`} />;
}

export function StateChip({ tone, children }: { tone: "teal" | "amber" | "risk" | "faint"; children: ReactNode }) {
  const tones = {
    teal: "border-teal/30 bg-teal/5 text-teal",
    amber: "border-amber/40 bg-amber-soft/40 text-amber-deep",
    risk: "border-risk/40 bg-risk/5 text-risk",
    faint: "border-edge bg-panel-2 text-ink-faint",
  } as const;
  return <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-edge bg-panel-2 px-4 py-5 text-center text-[12px] leading-relaxed text-ink-faint">{children}</p>
  );
}

export function ActionError({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-risk/40 bg-risk/5 px-3 py-2.5">
      <p className="text-[12px] leading-relaxed text-risk">{error}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-quiet mt-2 !min-h-8 !text-[11.5px]">
          Retry
        </button>
      )}
    </div>
  );
}

export function FormRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">{children}</div>;
}
