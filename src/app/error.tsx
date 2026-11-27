"use client";

/**
 * Route error boundary — the app-wide catch for client render exceptions.
 *
 * Why this exists: the app had NO error.tsx, so a single render exception
 * (e.g. an API payload with an unexpected shape reaching a `.map`) killed
 * the whole page with Next's default dead-end screen. The boundary now says
 * what happened, what it is NOT (a transaction problem — chain state lives
 * on Base and nothing here moves money), and offers real recovery.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, CircleAlert } from "lucide-react";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    console.error("route error boundary:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
      <div className="rounded-xl border border-risk/30 bg-panel px-4 py-5 sm:px-6" role="alert">
        <p className="flex items-start gap-2 text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
          <CircleAlert size={13} aria-hidden className="mt-0.5 shrink-0 text-risk" />
          Something broke
        </p>
        <h1 className="mt-1.5 text-[20px] font-semibold leading-tight text-ink">This view hit an unexpected error</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
          It is a rendering problem in this page, not a transaction problem: your wallet, your funds and anything already signed on Base are untouched.
        </p>
        <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={reset} className="btn-primary !min-h-9 sm:w-auto">
            Try again
          </button>
          <Link href="/buyer" className="btn-quiet !min-h-9 sm:w-auto">
            Back to the storefront
          </Link>
        </div>
        <details className="mt-3.5">
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
          {open && (
            <p className="mt-1.5 break-words [overflow-wrap:anywhere] rounded-md border border-edge bg-panel-3 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-faint">
              {error.message}
              {error.digest ? ` · digest ${error.digest}` : ""}
            </p>
          )}
        </details>
      </div>
    </div>
  );
}
