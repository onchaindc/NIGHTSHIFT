"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle } from "lucide-react";

import type { DeskWorkflowSummary } from "@/lib/desk/workflows";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";

/**
 * The guided investigation form for one specialised workflow. Fields come
 * from the workflow definition (server-rendered props, no client matrix);
 * optional fields that unlock capabilities carry an explicit unlock note so
 * the caller knows what a filled field will buy.
 */
export function DeskForm({ workflow }: { workflow: DeskWorkflowSummary }) {
  const router = useRouter();
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [subject, setSubject] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedIn = session.mode === "user" || session.mode === "operator";
  const required = workflow.fields.filter((f) => f.required);
  const optional = workflow.fields.filter((f) => !f.required);

  const field =
    "w-full min-h-10 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-teal focus:outline-none";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: workflow.type, subject }),
      });
      const body = (await res.json().catch(() => ({}))) as { investigation?: { id: string }; error?: string };
      if (!res.ok || !body.investigation) {
        setError(body.error ?? `The file could not be opened (status ${res.status}).`);
        return;
      }
      router.push(`/desk/i/${body.investigation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function renderField(f: (typeof workflow.fields)[number]) {
    const value = subject[f.name] ?? "";
    const set = (v: string) => setSubject((s) => ({ ...s, [f.name]: v }));
    return (
      <label key={f.name} className="block">
        <span className="x-label mb-1 block">
          {f.label}
          {f.unlocks?.length ? (
            <span className="ml-2 rounded border border-teal/30 bg-teal/5 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-teal">
              unlocks {f.unlocks.join(", ")}
            </span>
          ) : null}
        </span>
        {f.kind === "select" ? (
          <select className={field} value={value} onChange={(e) => set(e.target.value)}>
            <option value="">Select…</option>
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : f.kind === "textarea" ? (
          <textarea className={`${field} min-h-20`} value={value} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />
        ) : (
          <input
            className={`${field}${f.kind === "number" ? " tabular" : ""}`}
            value={value}
            onChange={(e) => set(f.kind === "number" ? e.target.value.replace(/[^0-9]/g, "") : e.target.value)}
            placeholder={f.placeholder}
            inputMode={f.kind === "number" ? "numeric" : undefined}
            spellCheck={false}
          />
        )}
        {f.help && <span className="mt-1 block text-[11px] leading-snug text-ink-faint">{f.help}</span>}
      </label>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/desk" className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-soft transition-colors hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Deal Desk
      </Link>

      <header className="mt-5 flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-[56ch]">
          <p className="x-eyebrow">{workflow.kicker}</p>
          <h1 className="x-display-1 mt-3 text-balance text-ink">{workflow.name}</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">{workflow.summary}</p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">Scope: {workflow.scope}</p>
        </div>
        <WalletSignIn onSession={setSession} compact />
      </header>

      <section aria-label="Guided form" className="mt-8 overflow-hidden rounded-3xl border border-edge bg-panel">
        <form
          className="grid gap-4 px-5 py-6 sm:grid-cols-2 sm:px-7"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="x-label sm:col-span-2">Required</p>
          {required.map(renderField)}

          <p className="x-label mt-2 sm:col-span-2">Optional — the routes they unlock</p>
          {optional.map(renderField)}

          {error && (
            <p role="alert" className="rounded-lg border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[12.5px] text-risk sm:col-span-2">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4 sm:col-span-2">
            <p className="text-[11px] leading-snug text-ink-faint">
              Nothing is spent until you approve the exact plan on the file. The free pre-flight never signs.
            </p>
            <button type="submit" className="btn-primary !min-h-10" disabled={busy || !signedIn} title={signedIn ? undefined : "Connect your wallet first"}>
              {busy ? (
                <>
                  <LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" /> Opening…
                </>
              ) : (
                <>
                  Open investigation file <ArrowRight size={14} aria-hidden />
                </>
              )}
            </button>
          </div>
          {!signedIn && session.mode !== "loading" && (
            <p className="text-[11.5px] leading-relaxed text-ink-soft sm:col-span-2">
              Files belong to your wallet: connect it above (one signature, not a transaction) to open one.
            </p>
          )}
        </form>
      </section>

      <details className="group mt-4 rounded-2xl border border-edge bg-panel/60 px-5 py-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink">
          What this workflow cannot do — named before you open the file
          <span aria-hidden className="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <ul className="mt-3 space-y-2">
          {workflow.unsupported.map((g) => (
            <li key={g.label} className="rounded-xl border border-edge bg-panel-2 px-3.5 py-3">
              <p className="flex items-start gap-1.5 text-[12.5px] font-medium text-ink">
                <CircleAlert size={13} aria-hidden className="mt-0.5 shrink-0 text-amber" />
                {g.label} — unsupported
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{g.reason}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">Resolution: {g.resolution}</p>
            </li>
          ))}
          {workflow.honestyNotes.map((note) => (
            <li key={note} className="px-1 text-[11.5px] leading-relaxed text-ink-faint">
              {note}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
