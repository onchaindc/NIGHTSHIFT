"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Eraser, LoaderCircle, Sparkles } from "lucide-react";

import type { DeskWorkflowSummary } from "@/lib/desk/workflows";
import { friendlyNetworkError } from "@/lib/api/client-errors";
import { SampleFill } from "@/components/sample-fill";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";

/**
 * The guided investigation form for one specialised workflow. Fields come
 * from the workflow definition (server-rendered props, no client matrix);
 * optional fields that unlock capabilities carry an explicit unlock note so
 * the caller knows what a filled field will buy, and the plan meter up top
 * counts the optional routes the answers so far have unlocked.
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

  /** Optional routes (capability names) unlocked by the answers filled so far. */
  const unlockedRoutes = useMemo(() => {
    const set = new Set<string>();
    for (const f of workflow.fields) {
      if (!f.required && (subject[f.name] ?? "").trim().length > 0) {
        for (const u of f.unlocks ?? []) set.add(u);
      }
    }
    return [...set];
  }, [subject, workflow.fields]);
  const requiredFilled = required.every((f) => (subject[f.name] ?? "").trim().length > 0);

  const field =
    "w-full min-h-10 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-teal focus:outline-none";

  async function submit() {
    setError(null);
    const missing = required.filter((f) => !(subject[f.name] ?? "").trim());
    if (missing.length > 0) {
      setError(`Fill in ${missing.map((f) => f.label).join(" and ")} to open the file.`);
      return;
    }
    setBusy(true);
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
      setError(friendlyNetworkError(err));
    } finally {
      setBusy(false);
    }
  }

  function fillSamples() {
    setError(null);
    setSubject({ ...workflow.samples });
  }

  function clearForm() {
    setError(null);
    setSubject({});
  }

  function renderField(f: (typeof workflow.fields)[number]) {
    const value = subject[f.name] ?? "";
    const set = (v: string) => setSubject((s) => ({ ...s, [f.name]: v }));
    return (
      <label key={f.name} className="block">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="x-label">{f.label}</span>
          {f.unlocks?.length ? (
            <span className="inline-flex max-w-full items-center rounded-full border border-teal/30 bg-teal/5 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-teal">
              unlocks {f.unlocks.join(", ")}
            </span>
          ) : null}
        </span>
        {f.kind === "select" ? (
          <select className={`${field} mt-1`} value={value} onChange={(e) => set(e.target.value)}>
            <option value="">Select…</option>
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : f.kind === "textarea" ? (
          <textarea className={`${field} mt-1 min-h-20`} value={value} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />
        ) : (
          <input
            className={`${field} mt-1${f.kind === "number" ? " tabular" : ""}`}
            value={value}
            onChange={(e) => set(f.kind === "number" ? e.target.value.replace(/[^0-9]/g, "") : e.target.value)}
            placeholder={f.placeholder}
            inputMode={f.kind === "number" ? "numeric" : undefined}
            spellCheck={false}
          />
        )}
        {f === required[0] && (
          <span className="mt-1 flex justify-end">
            <SampleFill onFill={fillSamples} />
          </span>
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

      {/* The plan meter: what the answers so far have unlocked. Counted from
          the workflow's own unlock notes — no invented routes, no fake plan. */}
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-edge bg-panel px-4 py-3 text-[12px]">
        <span className="flex items-center gap-1.5 font-medium text-ink">
          <Sparkles size={13} aria-hidden className="text-teal" />
          The file
        </span>
        <span className="text-ink-soft">
          <span className={`tabular font-semibold ${requiredFilled ? "text-teal" : "text-ink"}`}>{requiredFilled ? "Ready" : "Waiting on required answers"}</span>
        </span>
        <span className="text-ink-faint">
          <span className="tabular font-semibold text-ink">{unlockedRoutes.length}</span> optional route(s) unlocked by what you filled
        </span>
        <span className="text-ink-faint">
          <span className="tabular font-semibold text-ink">{workflow.capabilityCount}</span> verified route(s) in this workflow in total
        </span>
        {Object.keys(subject).length > 0 && (
          <button
            type="button"
            onClick={clearForm}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-[11.5px] text-ink-soft transition-colors hover:text-ink"
          >
            <Eraser size={12} aria-hidden /> Clear
          </button>
        )}
      </div>

      <section aria-label="Guided form" className="mt-4 overflow-hidden rounded-3xl border border-edge bg-panel">
        <form
          className="grid gap-4 px-5 py-6 sm:grid-cols-2 sm:px-7"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="x-label sm:col-span-2">Required — the subject of the file</p>
          {required.map(renderField)}

          <p className="x-label mt-2 sm:col-span-2">Optional — every route each answer unlocks</p>
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

      {/* The report shape, up front: the sections this file's report carries,
          exactly as the workflow defines them — a preview of what you get,
          not a promise of findings. */}
      <section aria-label="Report sections preview" className="mt-4">
        <p className="x-label">The report this file produces — {workflow.sections.length} fixed sections</p>
        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          {workflow.sections.map((s, i) => (
            <li key={s.id} className="flex gap-3 rounded-xl border border-edge bg-panel px-3.5 py-3">
              <span
                aria-hidden
                className="tabular grid h-6 w-6 shrink-0 place-items-center rounded-full border border-teal/30 bg-teal/5 text-[11px] font-semibold text-teal"
              >
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-ink">{s.title}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">{s.description}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <details className="group mt-4 rounded-2xl border border-edge bg-panel/60 px-5 py-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink">
          Scope and limits — what this workflow verifies, and what stays named
          <span aria-hidden className="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <ul className="mt-3 space-y-2">
          {workflow.unsupported.map((g) => (
            <li key={g.label} className="rounded-xl border border-edge bg-panel-2 px-3.5 py-3">
              <p className="text-[12.5px] font-medium text-ink">{g.label}</p>
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
