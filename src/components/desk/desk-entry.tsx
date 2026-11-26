"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";

import type { DeskInvestigationSummary } from "@/lib/desk/types";
import { DESK_TYPE_LABEL } from "@/lib/desk/types";
import type { DeskWorkflowSummary } from "@/lib/desk/workflows";
import { friendlyNetworkError } from "@/lib/api/client-errors";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";

const CONFIDENCE_TONE: Record<string, string> = {
  signal_verified: "border-teal/40 bg-teal/10 text-teal",
  partially_verified: "border-amber/40 bg-amber/10 text-amber",
  route_verified_only: "border-edge bg-panel-3 text-ink-faint",
  unverified: "border-edge bg-panel-3 text-ink-faint",
};

const CONFIDENCE_WORD: Record<string, string> = {
  signal_verified: "Signal verified",
  partially_verified: "Partially verified",
  route_verified_only: "Route verified only",
  unverified: "Unverified",
};

const TYPE_ACCENT: Record<string, string> = {
  counterparty_due_diligence: "bg-teal/10 text-teal border-teal/30",
  asset_intelligence: "bg-amber/10 text-amber border-amber/30",
  trade_supplier_intelligence: "bg-[--accent]/10 text-[--accent] border-[--accent]/30",
  listing_underwriter: "bg-teal/10 text-teal border-teal/30",
};

function TypeCard({ workflow }: { workflow: DeskWorkflowSummary }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-edge bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_12px_30px_-22px_rgba(22,24,29,0.4)]">
      <span className={`w-fit rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] ${TYPE_ACCENT[workflow.type] ?? "border-edge bg-panel-2 text-ink-faint"}`}>
        {workflow.kicker}
      </span>
      <h3 className="mt-3 text-[16px] font-semibold text-ink">{workflow.name}</h3>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{workflow.summary}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {workflow.sections.map((s) => (
          <span key={s.id} className="rounded-md border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] text-ink-faint">
            {s.title}
          </span>
        ))}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        <span className="tabular">{workflow.capabilityCount}</span> verified network route(s) ·{" "}
        <span className="tabular">{workflow.gapCount}</span> named unsupported requirement(s)
      </p>

      <Link
        href={`/desk/new?type=${workflow.type}`}
        className="btn-primary mt-4 inline-flex w-fit items-center !min-h-9 !px-4"
      >
        Start {workflow.name.split(" ")[0].toLowerCase() === "counterparty" ? "due diligence" : "investigation"} <ArrowRight size={14} aria-hidden />
      </Link>
    </div>
  );
}

export function DeskEntry({ workflows }: { workflows: DeskWorkflowSummary[] }) {
  const [rows, setRows] = useState<DeskInvestigationSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>({ mode: "loading" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/desk", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { investigations?: DeskInvestigationSummary[]; error?: string };
      if (!res.ok) {
        setListError(body.error ?? `The list could not be read (status ${res.status}).`);
        return;
      }
      setRows(body.investigations ?? []);
      setListError(null);
    } catch (err) {
      setListError(friendlyNetworkError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-[56ch]">
          <p className="x-eyebrow">Deal Desk</p>
          <h1 className="x-display-1 mt-3 text-balance text-ink">Investigate the deal, not just the payment.</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">
            Three specialised investigation workflows on one evidence engine: every verified fact carries its signal,
            every gap is named, and nothing is presented as data that the network did not answer.
          </p>
        </div>
        <WalletSignIn onSession={setSession} compact />
      </header>

      <section aria-label="Investigation types" className="mt-8">
        <h2 className="x-label">Start a specialised investigation</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-1">
          {workflows.map((w) => (
            <TypeCard key={w.type} workflow={w} />
          ))}
        </div>
      </section>

      <section aria-label="Specialised investigation files" className="mt-12">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="x-label">Investigation files</h2>
          <button type="button" onClick={() => void refresh()} className="text-[11px] text-ink-faint transition-colors hover:text-ink">
            Refresh
          </button>
        </div>

        {listError && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber/40 bg-amber/5 px-4 py-3">
            <p className="text-[12.5px] text-amber">{listError}</p>
            <button type="button" onClick={() => void refresh()} className="btn-quiet !min-h-9 !px-3">
              Retry
            </button>
          </div>
        )}

        {rows === null && !listError ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 rounded-2xl bg-panel-2 motion-safe:animate-pulse" />
            ))}
          </div>
        ) : rows !== null && rows.length === 0 && !listError ? (
          <div className="mt-4 rounded-2xl border border-dashed border-edge bg-panel/40 px-6 py-10 text-center">
            <ShieldCheck size={20} aria-hidden className="mx-auto text-ink-faint" />
            <p className="mt-3 text-[13.5px] font-medium text-ink">No specialised investigation files yet.</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-faint">
              Pick a workflow above. The free pre-flight probes every route without spending anything.
            </p>
          </div>
        ) : rows !== null && rows.length > 0 ? (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {rows.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/desk/i/${row.id}`}
                    className="group flex h-full flex-col rounded-2xl border border-edge bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_12px_30px_-22px_rgba(22,24,29,0.4)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="tabular text-[12.5px] font-semibold text-ink group-hover:text-teal">{row.reference}</span>
                      {row.confidence ? (
                        <span className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold tracking-wide ${CONFIDENCE_TONE[row.confidence] ?? "border-edge bg-panel-3 text-ink-faint"}`}>
                          {CONFIDENCE_WORD[row.confidence] ?? row.confidence}
                        </span>
                      ) : (
                        <span className="rounded-full border border-edge bg-panel-3 px-2.5 py-0.5 text-[10.5px] font-semibold text-ink-faint">Draft</span>
                      )}
                    </div>
                    <p className="mt-2.5 truncate text-[14px] font-medium text-ink">{row.subject}</p>
                    <p className="mt-0.5 text-[11.5px] text-ink-soft">{DESK_TYPE_LABEL[row.type]}</p>
                    <p className="mt-1 text-[12px] text-ink-soft">
                      <span className="tabular">{row.verifiedCount}</span> verified · <span className="tabular">{row.missingCount}</span> missing ·{" "}
                      <span className="tabular">{row.findingCount}</span> findings · <span className="tabular">{row.runs}</span> run(s)
                    </p>
                    <p className="mt-auto flex items-center pt-3 text-[11px] text-ink-faint">
                      {new Date(row.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                      <ArrowRight size={12} aria-hidden className="ml-auto transition-transform group-hover:translate-x-0.5 group-hover:text-teal" />
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
        ) : null}
        {session.mode === "anonymous" && (
          <p className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-soft">
            <CircleAlert size={13} aria-hidden className="mt-0.5 shrink-0 text-amber" />
            Files belong to your wallet. Sign in above to open and read yours.
          </p>
        )}
      </section>

      <p className="mt-10 text-[11px] leading-relaxed text-ink-faint">
        One engine behind all three: the same approval gate, spend ledger, drift checks and signal verification as every
        Mind on this deployment. Missing evidence stays missing — it is never inferred.
      </p>

      <div className="mt-6 flex items-center gap-2 text-[11px] text-ink-faint">
        <LoaderCircle size={12} aria-hidden className={rows === null ? "motion-safe:animate-spin" : "hidden"} />
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}
