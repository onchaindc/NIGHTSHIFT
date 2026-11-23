"use client";

/**
 * The Index Reconstitution Desk client. A strict, honest sequence:
 *
 *   define (universe + methodology, verbatim) → create (the task engine
 *   plans: free baseline → [approval gate → paid asks] → deterministic
 *   report) → poll (the shared task store; the same Activity infrastructure)
 *   → read (the proposal with per-asset evidence, declared-vs-verified
 *   provenance and the missing-dimension ledger).
 *
 * Nothing here invents a constituent, a price or a success. A redacted task
 * (anonymous viewer) is shown as the restricted view, exactly like the rest
 * of the console.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BadgeCheck,
  CircleAlert,
  ExternalLink,
  Layers,
  Loader2,
  Lock,
  Play,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";

import type { IndexDeskReport } from "@/lib/indexdesk/report";
import type { Evidence } from "@/lib/engine/types";

/** The index_asset_finding evidence rows the task result carries. */
type AssetEvidence = Extract<Evidence, { kind: "index_asset_finding" }>;

export interface IndexDeskGuarantees {
  nodeUrl: string;
  coverage: Array<{ dimension: string; intent: string; miner: string; price: string }>;
  notCovered: string[];
}

interface AssetRow {
  symbol: string;
  company: string;
  jurisdiction: string;
  chain: string;
  pool: string;
  declaredSupply: string;
  declaredPrice: string;
  declaredVolume: string;
}

const emptyRow = (): AssetRow => ({
  symbol: "",
  company: "",
  jurisdiction: "",
  chain: "ethereum",
  pool: "",
  declaredSupply: "",
  declaredPrice: "",
  declaredVolume: "",
});

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function shortHash(h: string): string {
  return h.length > 22 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes (active)" : "No (not active)";
  return String(v);
}

function assetEvidenceOf(evidence: AssetEvidence[], symbol: string): AssetEvidence | null {
  return evidence.find((e) => e.kind === "index_asset_finding" && e.symbol === symbol) ?? null;
}

const STATUS_CHIP: Record<string, string> = {
  verified: "border-teal/30 bg-teal/5 text-teal",
  recorded: "border-amber/40 bg-amber-soft/50 text-amber-deep",
  included: "border-teal/30 bg-teal/5 text-teal",
  provisional: "border-amber/40 bg-amber-soft/50 text-amber-deep",
  excluded: "border-risk/40 bg-risk/5 text-risk",
  missing: "border-risk/40 bg-risk/5 text-risk",
  declared: "border-edge bg-panel-2 text-ink-soft",
};

function Chip({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${tone}`}>
      {label}
    </span>
  );
}

export default function IndexDeskClient({ guarantees }: { guarantees: IndexDeskGuarantees }) {
  const [indexName, setIndexName] = useState("");
  const [scheme, setScheme] = useState<"equal" | "market_cap" | "custom">("equal");
  const [notes, setNotes] = useState("");
  const [customWeights, setCustomWeights] = useState("");
  const [rows, setRows] = useState<AssetRow[]>([emptyRow(), emptyRow()]);
  const [mode, setMode] = useState<"free" | "intel">("intel");
  const [spendLimit, setSpendLimit] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskState, setTaskState] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [redacted, setRedacted] = useState(false);
  const [report, setReport] = useState<IndexDeskReport | null>(null);
  const [evidence, setEvidence] = useState<AssetEvidence[]>([]);
  const [spendUsdCents, setSpendUsdCents] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    (id: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/tasks/${id}`, { cache: "no-store" });
          const body = (await res.json()) as { task?: { state?: string; error?: string | null; result?: { indexDeskReport?: IndexDeskReport; evidence?: unknown[] } | null }; redacted?: boolean; spend?: { spentUsdCents?: number } };
          const t = body.task;
          if (!t) return;
          setTaskState(t.state ?? null);
          setTaskError(t.error ?? null);
          setRedacted(body.redacted === true);
          if (typeof body.spend?.spentUsdCents === "number") setSpendUsdCents(body.spend.spentUsdCents);
          if (Array.isArray(t.result?.evidence)) setEvidence(t.result.evidence as AssetEvidence[]);
          if (t.state === "awaiting_approval") {
            setAwaitingApproval(true);
            stopPolling();
            return;
          }
          if (t.state === "completed" && t.result?.indexDeskReport) {
            setReport(t.result.indexDeskReport);
            if (Array.isArray(t.result.evidence)) setEvidence(t.result.evidence as AssetEvidence[]);
            stopPolling();
            return;
          }
          if (t.state === "failed" || t.state === "blocked" || t.state === "rejected") {
            stopPolling();
            return;
          }
        } catch {
          /* transient poll failure: keep polling */
        }
      }, 3000);
    },
    [stopPolling],
  );

  const updateRow = (i: number, patch: Partial<AssetRow>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const buildDefinition = useCallback(() => {
    const num = (v: string): number | undefined => {
      if (!v.trim()) return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : NaN;
    };
    const parsed: Array<{ invalid: true } | { invalid: false; asset: Record<string, unknown> }> = [];
    for (const r of rows) {
      if (!r.symbol.trim() && !r.company.trim()) continue;
      const declared: Record<string, number> = {};
      const s = num(r.declaredSupply);
      const p = num(r.declaredPrice);
      const v = num(r.declaredVolume);
      if (Number.isNaN(s) || Number.isNaN(p) || Number.isNaN(v)) {
        parsed.push({ invalid: true });
        continue;
      }
      if (s !== undefined) declared.circulatingSupply = s;
      if (p !== undefined) declared.priceUsd = p;
      if (v !== undefined) declared.volume30dUsd = v;
      parsed.push({
        invalid: false,
        asset: {
          symbol: r.symbol.trim().toUpperCase(),
          issuer: { company: r.company.trim(), jurisdiction: r.jurisdiction.trim() },
          ...(r.chain.trim() ? { chain: r.chain.trim().toLowerCase() } : {}),
          ...(r.pool.trim() ? { pool: r.pool.trim() } : {}),
          ...(Object.keys(declared).length ? { declared } : {}),
        },
      });
    }
    if (parsed.some((a) => a.invalid)) return { error: "Declared inputs must be non-negative numbers." };
    const custom: Record<string, number> | undefined =
      scheme === "custom"
        ? Object.fromEntries(
            customWeights
              .split(/[,\n]/)
              .map((pair) => pair.split(/[:=]/).map((x) => x.trim()))
              .filter((parts) => parts.length === 2 && parts[0] && parts[1])
              .map(([k, v]) => [k.toUpperCase(), Number(v)]),
          )
        : undefined;
    if (scheme === "custom" && (!custom || Object.keys(custom).length === 0)) {
      return { error: 'Scheme "custom" needs weights as "SYMBOL: percent" pairs (comma or newline separated).' };
    }
    return {
      definition: {
        name: indexName.trim(),
        methodology: {
          scheme,
          ...(custom ? { customWeights: custom } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
        assets: parsed.map((a) => (a as { invalid: false; asset: Record<string, unknown> }).asset),
      },
    };
  }, [rows, scheme, customWeights, notes, indexName]);

  const runDesk = useCallback(async () => {
    setError(null);
    setReport(null);
    setTaskError(null);
    setAwaitingApproval(false);
    setRedacted(false);
    setSpendUsdCents(0);
    const built = buildDefinition();
    if ("error" in built && built.error) {
      setError(built.error);
      return;
    }
    if ("definition" in built) {
      const limit = spendLimit.trim() ? Number(spendLimit) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        setError("The spend limit must be a positive number of USD cents.");
        return;
      }
      setCreating(true);
      try {
        const res = await fetch("/api/mind/index-desk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            index: built.definition,
            mode,
            ...(limit !== undefined ? { spendLimitUsdCents: Math.round(limit) } : {}),
          }),
        });
        const body = (await res.json()) as { task?: { id?: string; state?: string }; error?: string; note?: string };
        if (!res.ok || !body.task?.id) {
          setError(body.error ?? `The desk could not be created (HTTP ${res.status}).`);
          return;
        }
        setTaskId(body.task.id);
        setTaskState(body.task.state ?? null);
        if (body.task.state === "awaiting_approval") setAwaitingApproval(true);
        else poll(body.task.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    }
  }, [buildDefinition, mode, spendLimit, poll]);

  const canRun =
    indexName.trim().length >= 2 &&
    rows.filter((r) => r.symbol.trim() && r.company.trim() && r.jurisdiction.trim()).length >= 2 &&
    !creating;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link href="/minds" className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
        ← All Minds
      </Link>
      <p className="x-tag mt-4">MINDS · INDEX RECONSTITUTION DESK</p>
      <h1 className="x-display-1 mt-3 text-ink">Index Reconstitution Desk</h1>
      <p className="mt-4 max-w-[62ch] text-[14px] leading-relaxed text-ink-soft">
        Declare an index universe and its methodology; the desk investigates every asset across six
        verified dimensions — issuer registry, price, total supply, pool liquidity, holders and
        regulatory filings — and returns a deterministic constituent and weighting proposal with
        per-asset evidence, declared-vs-verified provenance and the missing-dimension ledger.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <Layers size={12} aria-hidden /> node: <span className="text-ink-soft">{guarantees.nodeUrl.replace(/^https?:\/\//, "")}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          verified coverage: <span className="text-ink-soft">{guarantees.coverage.length} dimensions</span>
        </span>
      </div>

      {/* verified coverage */}
      <section className="mt-6 overflow-hidden rounded-xl border border-edge bg-panel">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label">Verified network coverage <span className="text-ink-faint">— probed live before integration, never assumed</span></p>
        </div>
        <div className="divide-y divide-edge">
          {guarantees.coverage.map((c) => (
            <div key={c.intent} className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 text-[12.5px] sm:grid-cols-[190px_1fr_auto] sm:px-5">
              <span className="text-ink">{c.dimension}</span>
              <span className="break-words text-ink-faint">{c.intent} <span className="text-ink-soft">@ {c.miner}</span></span>
              <span className="tabular text-ink-soft">{c.price}</span>
            </div>
          ))}
          {guarantees.notCovered.map((n) => (
            <div key={n} className="flex items-start gap-2 px-4 py-2.5 text-[12.5px] text-amber-deep sm:px-5">
              <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span>{n}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 1 · define */}
      <section className="mt-8 overflow-hidden rounded-xl border border-edge bg-panel">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label">1 · Define the index universe and methodology</p>
        </div>
        <div className="space-y-4 px-4 py-4 sm:px-5">
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <div>
              <label htmlFor="ix-name" className="x-label">Index name</label>
              <input id="ix-name" value={indexName} onChange={(e) => setIndexName(e.target.value)} placeholder="e.g. September Digital Large Cap" className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
            </div>
            <div>
              <label htmlFor="ix-scheme" className="x-label">Weighting scheme</label>
              <select id="ix-scheme" value={scheme} onChange={(e) => setScheme(e.target.value as typeof scheme)} className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none focus:ring-1 focus:ring-edge">
                <option value="equal">equal — 1/N over kept assets</option>
                <option value="market_cap">market_cap — supply × price</option>
                <option value="custom">custom — declared weights</option>
              </select>
            </div>
          </div>
          {scheme === "custom" && (
            <div>
              <label htmlFor="ix-custom" className="x-label">Custom weights <span className="text-ink-faint">— SYMBOL: percent, comma or newline separated; normalized to 100</span></label>
              <input id="ix-custom" value={customWeights} onChange={(e) => setCustomWeights(e.target.value)} placeholder="WBTC: 40, ETH: 35, SOL: 25" className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
            </div>
          )}
          <div>
            <label htmlFor="ix-notes" className="x-label">Methodology notes <span className="text-ink-faint">— recorded verbatim in the proposal (optional)</span></label>
            <input id="ix-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. quarterly rebalance, capped at 30% per constituent" className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
          </div>

          <div className="space-y-3">
            {rows.map((r, i) => (
              <div key={i} className="rounded-lg border border-edge bg-panel-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="x-label">Asset {i + 1}</p>
                  {rows.length > 2 && (
                    <button type="button" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} className="text-ink-faint transition-colors hover:text-risk" aria-label={`Remove asset ${i + 1}`}>
                      <Trash2 size={14} aria-hidden />
                    </button>
                  )}
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-6">
                  <input value={r.symbol} onChange={(e) => updateRow(i, { symbol: e.target.value.toUpperCase() })} placeholder="SYMBOL" aria-label={`Asset ${i + 1} symbol`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge sm:col-span-1" />
                  <input value={r.company} onChange={(e) => updateRow(i, { company: e.target.value })} placeholder="Issuer legal name" aria-label={`Asset ${i + 1} issuer company`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge sm:col-span-2" />
                  <input value={r.jurisdiction} onChange={(e) => updateRow(i, { jurisdiction: e.target.value })} placeholder="Jurisdiction (ISO)" aria-label={`Asset ${i + 1} jurisdiction`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
                  <input value={r.chain} onChange={(e) => updateRow(i, { chain: e.target.value })} placeholder="chain" aria-label={`Asset ${i + 1} chain`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
                  <input value={r.pool} onChange={(e) => updateRow(i, { pool: e.target.value })} placeholder="DEX pool (opt.)" aria-label={`Asset ${i + 1} pool`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge sm:col-span-1" />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input value={r.declaredSupply} onChange={(e) => updateRow(i, { declaredSupply: e.target.value })} placeholder="declared circulating supply (opt.)" aria-label={`Asset ${i + 1} declared supply`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
                  <input value={r.declaredPrice} onChange={(e) => updateRow(i, { declaredPrice: e.target.value })} placeholder="declared price USD (opt.)" aria-label={`Asset ${i + 1} declared price`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
                  <input value={r.declaredVolume} onChange={(e) => updateRow(i, { declaredVolume: e.target.value })} placeholder="declared 30d volume USD (opt.)" aria-label={`Asset ${i + 1} declared volume`} className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
                </div>
                <p className="mt-1.5 text-[11px] text-ink-faint">
                  Declared figures are labelled <span className="text-ink-soft">declared</span> in the proposal — never presented as network-verified.
                </p>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setRows((rs) => [...rs, emptyRow()])} className="inline-flex items-center gap-1.5 text-[12.5px] text-teal hover:underline">
            <Plus size={13} aria-hidden /> Add asset
          </button>

          <div className="grid gap-4 border-t border-edge pt-4 sm:grid-cols-[1fr_1fr]">
            <div>
              <label htmlFor="ix-mode" className="x-label">Mode</label>
              <select id="ix-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none focus:ring-1 focus:ring-edge">
                <option value="intel">intel — paid asks after your approval</option>
                <option value="free">free — probes and pricing only, no purchases</option>
              </select>
            </div>
            <div>
              <label htmlFor="ix-limit" className="x-label">Spend limit <span className="text-ink-faint">— USD cents (optional)</span></label>
              <input id="ix-limit" value={spendLimit} onChange={(e) => setSpendLimit(e.target.value)} placeholder="e.g. 30 (= $0.30)" className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge" />
            </div>
          </div>

          <button type="button" onClick={runDesk} disabled={!canRun} className="btn-primary inline-flex items-center gap-2">
            {creating ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Play size={14} aria-hidden />}
            {creating ? "Creating the investigation…" : `Run the desk${mode === "intel" ? " (approval gate)" : ""}`}
          </button>
          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            The pre-flight probes are free. In intel mode every paid ask is one attempt, drift-checked
            against its approved offer and budget-guarded; a bare refusal after signing is terminal and
            never retried. Issuer jurisdiction is required — the registry intent rejects lookups without it.
          </p>
        </div>
      </section>

      {error && (
        <section className="mt-5 rounded-xl border border-risk/40 bg-risk/5 p-4 text-[13px] text-risk">
          <p className="flex items-center gap-1.5 font-medium"><XCircle /> {error}</p>
        </section>
      )}

      {/* 2 · investigation */}
      {taskId && (
        <section className="mt-5 overflow-hidden rounded-xl border border-edge bg-panel">
          <div className="border-b border-edge px-4 py-3 sm:px-5">
            <p className="x-label">2 · The investigation <span className="text-ink-faint">— task {shortHash(taskId)}</span></p>
          </div>
          <div className="space-y-3 px-4 py-4 sm:px-5">
            {awaitingApproval && taskState === "awaiting_approval" && (
              <div className="rounded-lg border border-amber/40 bg-amber-soft/50 p-3 text-[12.5px] leading-relaxed text-ink-soft">
                <p className="flex items-center gap-1.5 font-medium text-amber-deep"><Lock size={13} aria-hidden /> Awaiting your approval — nothing has been signed</p>
                <p className="mt-1.5">
                  The plan is at the engine&apos;s approval gate. Approve it from{" "}
                  <Link href="/approvals" className="text-teal hover:underline">Approvals</Link> (or{" "}
                  <Link href="/history" className="text-teal hover:underline">History</Link>) as the operator; the paid
                  asks start only then, one attempt each.
                </p>
              </div>
            )}
            {(taskState === "executing" || taskState === "verifying" || taskState === "planning") && (
              <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel-2 p-3 text-[12.5px] text-ink-soft">
                <Loader2 size={13} className="animate-spin" aria-hidden />
                {taskState === "verifying" ? "Verifying the evidence and reconciling the ledger…" : "Investigating — free probes first, paid asks after the gate…"}
              </div>
            )}
            {taskState === "failed" && (
              <div className="rounded-lg border border-risk/40 bg-risk/5 p-3 text-[12.5px] text-risk">
                <p className="font-medium">The investigation failed</p>
                {taskError && <p className="mt-1 break-words">{taskError}</p>}
              </div>
            )}
            {redacted && !report && (
              <div className="rounded-lg border border-amber/40 bg-amber-soft/50 p-3 text-[12.5px] leading-relaxed text-ink-soft">
                <p className="flex items-center gap-1.5 font-medium text-amber-deep"><Lock size={13} aria-hidden /> Restricted view</p>
                <p className="mt-1.5">
                  You are viewing anonymously, so objectives, proposals, evidence and spend entries do not
                  cross the public gate. <Link href="/settings" className="text-teal hover:underline">Sign in as the operator</Link>{" "}
                  to read the full desk report.
                </p>
              </div>
            )}
            {report && (
              <IndexReportView report={report} spendUsdCents={spendUsdCents} evidence={evidence} />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The report view                                                     */
/* ------------------------------------------------------------------ */

function IndexReportView({ report, spendUsdCents, evidence }: { report: IndexDeskReport; spendUsdCents: number; evidence: AssetEvidence[] }) {
  const p = report.methodology.proposal;
  const excluded = report.assets.filter((a) => a.status === "excluded");
  const provisional = report.assets.filter((a) => a.status === "provisional");
  return (
    <div className="space-y-5">
      {p ? (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-3.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-teal">
            <BadgeCheck size={14} aria-hidden /> Proposal — {p.scheme} rule
          </p>
          <div className="mt-2.5 divide-y divide-edge overflow-hidden rounded-lg border border-edge bg-panel-2">
            {p.weights.map((w) => (
              <div key={w.symbol} className="flex items-center justify-between px-3 py-2 text-[13px]">
                <span className="font-medium text-ink">{w.symbol}</span>
                <span className="tabular text-ink">{w.weightPct.toFixed(2)}%</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-ink-soft">
            Sum {p.weightSumPct.toFixed(2)}%{p.normalizedFrom !== undefined ? ` (normalized from ${p.normalizedFrom.toFixed(2)}%)` : ""} · HHI {p.concentration.hhi.toFixed(4)} · effective N {p.concentration.effectiveN.toFixed(2)} · top-1 {p.concentration.top1Pct.toFixed(2)}% · top-3 {p.concentration.top3Pct.toFixed(2)}%
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-amber/40 bg-amber-soft/50 p-3.5 text-[12.5px] text-ink-soft">
          <p className="flex items-center gap-1.5 font-medium text-amber-deep"><AlertTriangle size={13} aria-hidden /> No weighting proposed</p>
          <p className="mt-1">{report.methodology.proposalBlocker}</p>
        </div>
      )}

      {/* per-asset evidence */}
      <div>
        <p className="x-label">Per-asset evidence <span className="text-ink-faint">— every dimension carries its honest status</span></p>
        <div className="mt-2 space-y-3">
          {report.assets.map((a) => (
            <div key={a.symbol} className="overflow-hidden rounded-lg border border-edge bg-panel-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-ink">{a.symbol}</span>
                  <span className="text-[11.5px] text-ink-faint">{a.issuer} · {a.issuerJurisdiction}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Chip label={a.status} tone={STATUS_CHIP[a.status] ?? "border-edge bg-panel text-ink-soft"} />
                  {a.weightPct !== undefined && <span className="tabular text-[13px] font-medium text-ink">{a.weightPct.toFixed(2)}%</span>}
                </div>
              </div>
              {(a.exclusionReason || a.provisionalReason) && (
                <p className="border-b border-edge bg-panel px-3 py-2 text-[12px] text-ink-soft">
                  {a.exclusionReason ?? a.provisionalReason}
                </p>
              )}
              <div className="divide-y divide-edge">
                {report.baseline.probes.filter((pr) => pr.symbol === a.symbol).map((pr, i) => (
                  <div key={`${pr.dimension}-${i}`} className="grid gap-x-3 gap-y-0.5 px-3 py-1.5 text-[12px] sm:grid-cols-[170px_1fr]">
                    <span className="text-ink-faint">probe · {pr.dimension}</span>
                    <span className="text-ink-soft">
                      {pr.status === "challenge" ? `routable at $${((pr.priceUsdCents ?? 0) / 100).toFixed(2)}` : pr.status}
                      {pr.detail ? ` — ${pr.detail}` : ""}
                    </span>
                  </div>
                ))}
                {(a.inputs.supply || a.inputs.price || a.inputs.marketCap || a.inputs.liquidityUsd || a.inputs.holders || a.inputs.filings || a.inputs.volume30dUsd) && (
                  <div className="grid gap-x-3 gap-y-1 px-3 py-1.5 text-[12px] sm:grid-cols-[170px_1fr]">
                    <span className="text-ink-faint">weighting inputs</span>
                    <span className="space-y-0.5 text-ink-soft">
                      {(["marketCap", "supply", "price", "liquidityUsd", "holders", "filings", "volume30dUsd"] as const).map((k) => {
                        const inp = a.inputs[k];
                        if (!inp) return null;
                        return (
                          <div key={k} className="flex flex-wrap items-center gap-1.5">
                            <span className="tabular text-ink">{inp.value.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                            <Chip label={inp.provenance} tone={STATUS_CHIP[inp.provenance === "telegraph-verified" ? "verified" : "declared"]} />
                          </div>
                        );
                      })}
                    </span>
                  </div>
                )}
                <div className="grid gap-x-3 gap-y-0.5 px-3 py-1.5 text-[12px] sm:grid-cols-[170px_1fr]">
                  <span className="text-ink-faint">data quality</span>
                  <span className="text-ink-soft">
                    registry fields {a.dataQuality.registryFieldsKnown}/{a.dataQuality.registryFieldsTotal} · dimensions verified {a.dataQuality.dimensionsVerified}/{a.dataQuality.dimensionsTotal} · conflicts {a.dataQuality.disagreements} · score {a.dataQuality.score}/100
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* signal receipts */}
      {report.mode === "intel" && (
        <div>
          <p className="x-label">Signals &amp; receipts <span className="text-ink-faint">— ${(spendUsdCents / 100).toFixed(2)} spent, one receipt per ask</span></p>
          <div className="mt-2 space-y-2">
            {report.assets.map((a) => {
              const ev = assetEvidenceOf(evidence, a.symbol);
              const paid = ev?.dimensions.filter((d) => d.signalHash) ?? [];
              if (!ev || paid.length === 0) {
                return (
                  <div key={`rc-${a.symbol}`} className="rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[12px] text-ink-faint">
                    {a.symbol}: no settled asks recorded for this asset.
                  </div>
                );
              }
              return (
                <div key={`rc-${a.symbol}`} className="rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[12px]">
                  <p className="font-medium text-ink">{a.symbol} <span className="text-ink-faint">— {paid.length} ask(s), ${(ev.totalCostUsdCents / 100).toFixed(2)}</span></p>
                  <div className="mt-1 space-y-1">
                    {paid.map((d, i) => (
                      <div key={`${d.dimension}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="text-ink-faint">{d.dimension}</span>
                        {d.signalHash && HASH_RE.test(d.signalHash) ? (
                          <Link href={`/signals/${d.signalHash}`} className="inline-flex items-center gap-0.5 break-all text-teal hover:underline">
                            {shortHash(d.signalHash)} <ExternalLink size={10} aria-hidden />
                          </Link>
                        ) : (
                          <span className="break-all text-ink-soft">{d.signalHash ?? "—"}</span>
                        )}
                        {d.receiptHash && <span className="break-all text-ink-faint">receipt {shortHash(d.receiptHash)}</span>}
                        {typeof d.costUsdCents === "number" && <span className="tabular text-ink-soft">${(d.costUsdCents / 100).toFixed(2)}</span>}
                        {d.value !== undefined && <span className="tabular text-ink">→ {fmtValue(d.value)}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* methodology rules */}
      <div>
        <p className="x-label">Methodology rules <span className="text-ink-faint">— stated verbatim, reproducible</span></p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] text-ink-soft">
          {report.methodology.methodologyRules.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
      </div>

      {/* missing dimensions */}
      {report.missingDimensions.length > 0 && (
        <div>
          <p className="x-label">Missing-dimension ledger <span className="text-ink-faint">— identified, never fabricated</span></p>
          <div className="mt-2 space-y-1.5">
            {report.missingDimensions.map((m, i) => (
              <div key={i} className="rounded-lg border border-amber/40 bg-amber-soft/40 px-3 py-2 text-[12px] text-ink-soft">
                <span className="font-medium text-amber-deep">{m.scope === "portfolio" ? "Portfolio-wide" : m.symbol}</span>
                {" · "}
                {m.dimension} — {m.reason}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* reasoning */}
      <div>
        <p className="x-label">Reasoning <span className="text-ink-faint">— every step cites its evidence</span></p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] text-ink-soft">
          {report.reasoning.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
      </div>
      <p className="text-[11.5px] text-ink-faint">
        Confidence: {report.confidence}. The proposal is deterministic: rerun with the same definition and the same network answers and the weights reproduce exactly.
      </p>
    </div>
  );
}
