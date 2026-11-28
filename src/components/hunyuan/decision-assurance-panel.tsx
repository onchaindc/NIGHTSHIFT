"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, BrainCircuit, Check, Loader2, RefreshCw, ShieldQuestion, X } from "lucide-react";

import type { AssuranceSeverity, DecisionAssuranceReview, HunyuanAssuranceRecord } from "@/lib/hunyuan/types";

/**
 * Mission #01 — the Enterprise Decision Assurance panel.
 *
 * Renders the persisted Hunyuan review ON the investigation it analysed
 * (assurance settlement files and desk files), with every claim traced to the
 * evidence ids it cites. Runs are operator-gated server-side: a non-operator
 * viewer sees nothing (401), a missing provider key shows the exact gap, and
 * rejected model citations are listed rather than hidden.
 */

const SEVERITY_CHIP: Record<AssuranceSeverity, string> = {
  critical: "border-risk/40 bg-risk/5 text-risk",
  material: "border-amber/40 bg-amber/10 text-amber",
  minor: "border-edge bg-panel-2 text-ink-soft",
  info: "border-edge bg-panel-2 text-ink-faint",
};

const CONFIDENCE_CHIP: Record<string, string> = {
  high: "border-teal/40 bg-teal/10 text-teal",
  medium: "border-amber/40 bg-amber/10 text-amber",
  low: "border-risk/40 bg-risk/10 text-risk",
};

const BASIS_LABEL: Record<string, string> = {
  established_fact: "established fact",
  inference: "inference",
};

function EvidenceChips({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {ids.map((id) => (
        <span key={id} className="rounded-sm border border-edge bg-panel-2 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-faint" title="cited evidence or continuum event id">
          {id}
        </span>
      ))}
    </div>
  );
}

function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{title}</h4>
      <div className="mt-1.5 space-y-1.5">{children}</div>
    </div>
  );
}

export function DecisionAssurancePanel({ scope, id }: { scope: "assurance" | "desk"; id: string }) {
  const [review, setReview] = useState<HunyuanAssuranceRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** False when the viewer is not the operator: the panel renders nothing. */
  const [visible, setVisible] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/hunyuan/decision-assurance?scope=${scope}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setVisible(false); // operator-only panel
        setLoaded(true);
        return;
      }
      const body = (await res.json()) as { review?: HunyuanAssuranceRecord | null };
      setReview(body.review ?? null);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [scope, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/hunyuan/decision-assurance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, id }),
      });
      const body = (await res.json().catch(() => ({}))) as { review?: HunyuanAssuranceRecord; error?: string };
      if (!res.ok) {
        setError(body.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      setReview(body.review ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setRunning(false);
    }
  };

  if (!loaded || !visible) return null;

  if (!review) {
    return (
      <section className="mt-6 rounded-2xl border border-edge bg-panel-2 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11.5px] text-ink-soft">
            <BrainCircuit size={14} aria-hidden className="text-ink-faint" />
            <span className="font-semibold text-ink">Enterprise Decision Assurance</span>
            <span className="text-ink-faint">· Hunyuan review not run for this file yet</span>
          </div>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-md border border-edge-strong bg-panel-3 px-2.5 py-1.5 text-[11px] font-semibold text-ink transition-colors hover:bg-panel-2 disabled:opacity-60"
          >
            {running ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
            Run decision assurance
          </button>
        </div>
        {error && <p className="mt-2 text-[11px] text-risk">{error}</p>}
      </section>
    );
  }

  const r = review.review;
  return (
    <section className="mt-6 rounded-2xl border border-edge bg-panel-2 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <BrainCircuit size={14} aria-hidden className="text-ink-faint" />
          <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">Enterprise Decision Assurance</h3>
          <span className="rounded-sm border border-edge bg-panel-3 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-ink-faint">Tencent Hunyuan · analysis</span>
          <span className={`rounded-sm border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${CONFIDENCE_CHIP[r.confidence.level] ?? ""}`}>confidence {r.confidence.level}</span>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-edge-strong bg-panel-3 px-2.5 py-1.5 text-[11px] font-semibold text-ink transition-colors hover:bg-panel-2 disabled:opacity-60"
        >
          {running ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
          Re-run
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{r.headline}</p>
      <p className="mt-1 text-[10.5px] text-ink-faint">Confidence basis: {r.confidence.basis}</p>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <SubSection title={`Material findings (${r.materialFindings.length})`}>
          {r.materialFindings.length === 0 && <p className="text-[11px] text-ink-faint">None recorded by the review.</p>}
          {r.materialFindings.map((f, i) => (
            <div key={i} className="rounded-lg border border-edge bg-panel-3 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`rounded-sm border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${SEVERITY_CHIP[f.severity]}`}>{f.severity}</span>
                <span className="rounded-sm border border-edge bg-panel-2 px-1.5 py-0.5 text-[9.5px] text-ink-faint">{BASIS_LABEL[f.basis] ?? f.basis}</span>
                <span className="text-[11.5px] font-semibold text-ink">{f.title}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">{f.explanation}</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-faint">Significance: {f.significance}</p>
              <EvidenceChips ids={f.evidenceIds} />
            </div>
          ))}
        </SubSection>

        <SubSection title={`Conflicts (${r.conflicts.length})`}>
          {r.conflicts.length === 0 && <p className="text-[11px] text-ink-faint">No conflicting records named by the review.</p>}
          {r.conflicts.map((c, i) => (
            <div key={i} className="rounded-lg border border-amber/30 bg-amber/[0.05] px-2.5 py-2">
              <p className="text-[11.5px] font-semibold text-ink">{c.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">{c.detail}</p>
              <EvidenceChips ids={c.evidenceIds} />
            </div>
          ))}
        </SubSection>

        <SubSection title={`Unknowns (${r.unknowns.length})`}>
          {r.unknowns.length === 0 && <p className="text-[11px] text-ink-faint">None named.</p>}
          {r.unknowns.map((u, i) => (
            <div key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-soft">
              <ShieldQuestion size={12} aria-hidden className="mt-0.5 shrink-0 text-ink-faint" />
              <span>
                <span className="font-medium text-ink">{u.question}</span> — {u.whyMaterial}
              </span>
            </div>
          ))}
        </SubSection>

        <SubSection title={`Missing evidence (${r.missingEvidence.length})`}>
          {r.missingEvidence.length === 0 && <p className="text-[11px] text-ink-faint">None named.</p>}
          {r.missingEvidence.map((m, i) => (
            <div key={i} className="text-[11px] leading-relaxed text-ink-soft">
              <span className="font-medium text-ink">{m.requirement}</span> — {m.whyMaterial} <span className="text-ink-faint">(capability: {m.suggestedCapability})</span>
            </div>
          ))}
        </SubSection>

        <SubSection title={`Risks (${r.risks.length})`}>
          {r.risks.length === 0 && <p className="text-[11px] text-ink-faint">None named.</p>}
          {r.risks.map((k, i) => (
            <div key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-soft">
              <AlertTriangle size={12} aria-hidden className={`mt-0.5 shrink-0 ${k.severity === "critical" || k.severity === "material" ? "text-amber" : "text-ink-faint"}`} />
              <span>
                <span className="font-medium text-ink">{k.title}</span> — {k.detail}
              </span>
            </div>
          ))}
        </SubSection>

        <SubSection title={`Recommended verification (${r.recommendedVerification.length})`}>
          {r.recommendedVerification.length === 0 && <p className="text-[11px] text-ink-faint">None named.</p>}
          {r.recommendedVerification.map((v, i) => (
            <div key={i} className="text-[11px] leading-relaxed text-ink-soft">
              <span className="font-medium text-ink">{i + 1}. {v.step}</span> <span className="text-ink-faint">· capability {v.capability} · traces to {v.tracesTo}</span>
            </div>
          ))}
        </SubSection>

        <SubSection title={`Established facts (${r.establishedFacts.length})`}>
          {r.establishedFacts.map((f, i) => (
            <div key={i} className="text-[11px] leading-relaxed text-ink-soft">
              <Check size={12} aria-hidden className="mr-1 inline text-teal" />
              {f.statement}
              <EvidenceChips ids={f.evidenceIds} />
            </div>
          ))}
        </SubSection>

        <SubSection title={`Inferences (${r.inferences.length})`}>
          {r.inferences.map((f, i) => (
            <div key={i} className="text-[11px] leading-relaxed text-ink-soft">
              <span className="font-medium text-ink">{f.statement}</span> — {f.reasoning}
              <EvidenceChips ids={f.evidenceIds} />
            </div>
          ))}
        </SubSection>
      </div>

      {(r.limitations.length > 0 || review.rejectedClaims.length > 0) && (
        <div className="mt-3 rounded-lg border border-edge bg-panel-3 px-2.5 py-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Limitations &amp; rejected claims</h4>
          <ul className="mt-1 space-y-0.5">
            {r.limitations.map((l, i) => (
              <li key={i} className="text-[10.5px] leading-relaxed text-ink-faint">· {l}</li>
            ))}
            {review.rejectedClaims.map((c, i) => (
              <li key={`rc-${i}`} className="flex gap-1 text-[10.5px] leading-relaxed text-amber">
                <X size={11} aria-hidden className="mt-0.5 shrink-0" />
                <span>
                  {c.location}: {c.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2.5 text-[9.5px] text-ink-faint">
        {review.provider} · model {review.model} · {new Date(review.runAt).toISOString().slice(0, 16).replace("T", " ")} UTC
        {review.usage?.totalTokens ? ` · ${review.usage.totalTokens} tokens` : ""} · stored as analysis on this record; never an evidence class and never a settlement authorization.
      </p>
      {error && <p className="mt-1 text-[11px] text-risk">{error}</p>}
    </section>
  );
}
