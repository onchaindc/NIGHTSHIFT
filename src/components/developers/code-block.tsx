"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copyable code block for the Developer Centre. Static, no execution, no
 * playground: copy plus readable rendering is all it does.
 */
export function CodeBlock({ code, title, lang }: { code: string; title?: string; lang?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable; the code remains selectable by hand */
    }
  };

  return (
    <figure className="overflow-hidden rounded-lg border border-edge bg-night">
      <figcaption className="flex items-center justify-between gap-3 border-b border-edge bg-panel px-3.5 py-2">
        <span className="x-label !mt-0 truncate">
          {title ?? (lang ? lang.toUpperCase() : "SHELL")}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-panel-2 px-2 py-1 text-[11px] text-ink-soft transition-colors hover:border-edge-strong hover:text-ink"
        >
          {copied ? <Check size={12} strokeWidth={2.2} className="text-teal" /> : <Copy size={12} strokeWidth={1.8} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre className="max-h-[26rem] overflow-auto px-4 py-3.5 text-[12.5px] leading-relaxed text-ink-soft">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
