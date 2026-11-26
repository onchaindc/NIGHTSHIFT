"use client";

import { useState } from "react";
import { Wand2 } from "lucide-react";

/**
 * The little wand. A quiet inline control that sits at the bottom of a
 * form's primary input: one tap fills every field with the workflow's
 * worked example, and the wand gives a small pop so the tap reads.
 * Deliberately not a dialog, not a panel, not a filled button — one small
 * icon where the samples are needed, exactly where the hand already is.
 * Samples are recorded like typed answers: declared inputs, never facts.
 */
export function SampleFill({ onFill, label = "Fill sample values" }: { onFill: () => void; label?: string }) {
  const [popped, setPopped] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        onFill();
        setPopped(true);
        window.setTimeout(() => setPopped(false), 700);
      }}
      title="One tap fills every field with a worked example — safe sample values; replace them with the real subject before running."
      className="group inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-faint transition-colors hover:text-teal focus-visible:text-teal focus:outline-none"
    >
      <Wand2
        size={12}
        aria-hidden
        className={`transition-transform duration-300 group-hover:-rotate-12 ${popped ? "wand-pop" : ""}`}
      />
      <span>{label}</span>
    </button>
  );
}
