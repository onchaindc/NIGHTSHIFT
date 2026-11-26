"use client";

/**
 * The Index Reconstitution Desk client. A strict, honest sequence:
 *
 *   define (universe + methodology) → run (the task engine plans: free
 *   baseline → [approval gate → paid asks] → deterministic report) → read
 *   (proposal with per-asset evidence, declared-vs-verified provenance and the
 *   missing-dimension ledger).
 *
 * The active investigation id lives in the URL (?task=…), so a refresh or a
 * trip to Activity does not lose progress. Approval happens here, inline,
 * through the engine's action route — never through a retired console page.
 * Nothing on this page invents a constituent, a price or a success.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BadgeCheck,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Layers,
  Loader2,
  Lock,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";

import type { IndexDeskReport } from "@/lib/indexdesk/report";
import { openTaskStream } from "@/components/minds/task-stream";
import { useRunWatchdog } from "@/components/minds/run-watchdog";
import RunFlow from "@/components/minds/run-flow";
import { ConfirmPaidRun } from "@/components/confirm-paid-run";
import type { TaskRecord } from "@/lib/engine/types";
import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";
import {
  deskHrefWithTask,
  deskSessionMode,
  deskSnapshot,
  deskTaskParam,
  dimensionLabel,
  displayMissingDimensions,
  friendlyDeskError,
  parseCustomWeights,
  parseSpendLimitUsd,
  sanitizeDeskMessage,
  type DeskEvidence,
  type DeskSession,
  type DeskTaskSnapshot,
} from "@/lib/indexdesk/desk-ui";
import {
  addAssetRow,
  createAssetRow,
  removeAssetRow,
  rowFieldName,
  updateAssetRow,
  type AssetRow,
} from "@/lib/indexdesk/desk-rows";

export interface IndexDeskGuarantees {
  nodeUrl: string;
  coverage: Array<{ dimension: string; intent: string; miner: string; price: string }>;
  notCovered: string[];
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function shortHash(h: string): string {
  return h.length > 22 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function fmtNumber(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

const STATUS_TONE: Record<string, string> = {
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
  const [rows, setRows] = useState<AssetRow[]>(() => [createAssetRow(), createAssetRow()]);
  const [session, setSession] = useState<DeskSession>("loading");
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [mode, setMode] = useState<"free" | "intel">("free");
  const [paidConfirmOpen, setPaidConfirmOpen] = useState(false);
  const [spendLimit, setSpendLimit] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [taskId, setTaskId] = useState<string | null>(null);
  const [snap, setSnap] = useState<DeskTaskSnapshot | null>(null);
  // The raw engine task drives the shared RunFlow panel; the snapshot drives
  // the desk's own report rendering. Both come from the same poll/stream.
  const [rawTask, setRawTask] = useState<TaskRecord | null>(null);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const signedIn = session === "operator" || session === "user";
  // Approval authority: the operator, or the wallet that owns THIS run. The
  // server enforces the same rule; this keeps the UI honest up front.
  const canAct =
    session === "operator" ||
    (session === "user" && !!sessionAddress && !!snap?.owner && snap.owner.toLowerCase() === sessionAddress);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // Approval resumes in the background (after()), so the first poll or two can
  // still show awaiting_approval. Without this grace the client would stop
  // polling and show the gate again immediately after the user approved it.
  const approveGraceUntil = useRef(0);

  // WalletSignIn reports the session it loads; both wallet users and the
  // operator unlock the paid path, anonymous keeps the public view.
  const handleSession = useCallback((next: SessionState) => {
    setSession(next.mode === "operator" ? "operator" : next.mode === "user" ? "user" : next.mode === "unavailable" ? "unavailable" : next.mode === "loading" ? "loading" : "anonymous");
    setSessionAddress(next.address ?? null);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Operator session state drives the sign-in panel and approval wording.
  const apply = useCallback((body: unknown) => {
    const payload = body as { task?: unknown };
    if (!payload || !payload.task) return undefined;
    setRawTask(payload.task as TaskRecord);
    let next = deskSnapshot(body);
    if (next.terminal === "awaiting_approval" && Date.now() < approveGraceUntil.current) {
      next = { ...next, state: "executing", terminal: null, stopPolling: false, plan: next.plan };
    }
    setSnap(next);
    if (next.stopPolling) stopPolling();
    return next;
  }, [stopPolling]);

  const load = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(65_000) });
      if (!res.ok) {
        if (res.status === 404) {
          setSnap(deskSnapshot({ task: null, redacted: true }));
          setRawTask(null);
          setError("That investigation could not be found. Start a new one.");
        }
        return;
      }
      return apply((await res.json()) as unknown);
    } catch {
      /* transient: the next poll retries */
      return undefined;
    }
  }, [apply]);

  // SSE live stream with the 3s poll as fallback; both funnel through apply().
  useEffect(() => {
    if (!taskId) return;
    return openTaskStream(taskId, (body) => void apply(body));
  }, [taskId, apply]);

  const poll = useCallback(
    (id: string) => {
      stopPolling();
      void load(id);
      pollRef.current = setInterval(() => {
        void load(id);
      }, 3000);
    },
    [load, stopPolling],
  );

  const [resuming, setResuming] = useState(false);
  const resumeRun = useCallback(async () => {
    if (!taskId || resuming) return;
    setResuming(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(70_000),
      });
      const body = (await res.json()) as { task?: { id?: string }; error?: string };
      if (!res.ok || !body.task?.id) {
        setError(body.error ?? "resume failed; start a new investigation instead");
        return;
      }
      setTaskId(body.task.id);
      poll(body.task.id);
    } catch {
      setError("resume failed; start a new investigation instead");
    } finally {
      setResuming(false);
    }
  }, [taskId, resuming, poll]);


  // Restore an investigation from the URL on mount (refresh / back / Activity).
  useEffect(() => {
    const id = deskTaskParam(typeof window === "undefined" ? "" : window.location.search);
    if (!id) return;
    setTaskId(id);
    poll(id);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writeUrl = (id: string | null) => {
    if (typeof window === "undefined") return;
    window.history.replaceState(null, "", deskHrefWithTask(id));
  };

  // Address rows by their stable id, never by array index: index edits are
  // what let one asset inherit another's issuer fields after a removal.
  const updateRow = (id: string, patch: Partial<Omit<AssetRow, "id">>) => {
    setRows((rs) => updateAssetRow(rs, id, patch));
  };

  const buildDefinition = useCallback(() => {
    const num = (v: string): number | undefined => {
      if (!v.trim()) return undefined;
      if (!/^\d+(\.\d+)?$/.test(v.trim())) return NaN;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : NaN;
    };
    const assets: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if (!r.symbol.trim() && !r.company.trim()) continue;
      const declared: Record<string, number> = {};
      const s = num(r.declaredSupply);
      const p = num(r.declaredPrice);
      const v = num(r.declaredVolume);
      if (Number.isNaN(s) || Number.isNaN(p) || Number.isNaN(v)) {
        return { error: `Asset ${r.symbol.trim().toUpperCase() || "(unnamed)"}: declared inputs must be non-negative numbers.` };
      }
      if (s !== undefined) declared.circulatingSupply = s;
      if (p !== undefined) declared.priceUsd = p;
      if (v !== undefined) declared.volume30dUsd = v;
      assets.push({
        symbol: r.symbol.trim().toUpperCase(),
        issuer: { company: r.company.trim(), jurisdiction: r.jurisdiction.trim() },
        ...(r.chain.trim() ? { chain: r.chain.trim().toLowerCase() } : {}),
        ...(r.pool.trim() ? { pool: r.pool.trim() } : {}),
        ...(Object.keys(declared).length ? { declared } : {}),
      });
    }

    let weights: Record<string, number> | undefined;
    if (scheme === "custom") {
      const parsed = parseCustomWeights(
        customWeights,
        assets.map((a) => String(a.symbol)),
      );
      if (!parsed.ok) return { error: parsed.error };
      weights = parsed.weights;
    }

    return {
      definition: {
        name: indexName.trim(),
        methodology: {
          scheme,
          ...(weights ? { customWeights: weights } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
        assets,
      },
    };
  }, [rows, scheme, customWeights, notes, indexName]);

  const runDesk = useCallback(async () => {
    setError(null);
    setActionError(null);
    const built = buildDefinition();
    if ("error" in built && built.error) {
      setError(built.error);
      return;
    }
    if (!("definition" in built)) return;

    const limit = parseSpendLimitUsd(spendLimit);
    if (!limit.ok) {
      setError(limit.error);
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/mind/index-desk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(70_000),
        body: JSON.stringify({
          index: built.definition,
          mode,
          ...(limit.cents !== undefined ? { spendLimitUsdCents: limit.cents } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { task?: { id?: string }; error?: string };
      if (!res.ok || !body.task?.id) {
        setError(friendlyDeskError(res.status, body.error));
        if (res.status === 401) setSession("anonymous");
        return;
      }
      setTaskId(body.task.id);
      setSnap(null);
      writeUrl(body.task.id);
      poll(body.task.id);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    } catch {
      setError(friendlyDeskError(0));
    } finally {
      setCreating(false);
    }
  }, [buildDefinition, mode, spendLimit, poll]);

  const act = useCallback(
    async (action: "approve" | "reject") => {
      if (!taskId) return;
      setActing(action);
      setActionError(null);
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setActionError(friendlyDeskError(res.status, body.error));
          if (res.status === 401) setSession("anonymous");
          return;
        }
        if (action === "approve") {
          approveGraceUntil.current = Date.now() + 8000;
          setSnap((s) => (s ? { ...s, state: "executing", terminal: null, stopPolling: false } : s));
          poll(taskId);
        } else {
          stopPolling();
          await load(taskId);
        }
      } catch {
        setActionError(friendlyDeskError(0));
      } finally {
        setActing(null);
      }
    },
    [taskId, poll, load, stopPolling],
  );

  const reset = () => {
    stopPolling();
    setTaskId(null);
    setSnap(null);
    setActionError(null);
    writeUrl(null);
  };

  const completeAssets = rows.filter(
    (r) => r.symbol.trim() && r.company.trim() && r.jurisdiction.trim(),
  ).length;
  const canRun = indexName.trim().length >= 2 && completeAssets >= 2 && !creating;

  const state = snap?.state ?? null;
  const watchdog = useRunWatchdog(snap);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
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

      {/* how it works */}
      <div className="mt-6 grid gap-px overflow-hidden rounded-xl border border-edge bg-edge sm:grid-cols-3">
        {[
          { n: "1", title: "Define", body: "Name the universe and choose how it should be weighted." },
          { n: "2", title: "Review", body: "Free probes price every ask; paid asks wait for your approval." },
          { n: "3", title: "Read", body: "A reproducible proposal with evidence and stated gaps." },
        ].map((step) => (
          <div key={step.n} className="bg-panel px-4 py-3">
            <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              <span className="grid size-5 place-items-center rounded-full bg-panel-3 text-[10px] font-semibold text-ink-soft">{step.n}</span>
              {step.title}
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{step.body}</p>
          </div>
        ))}
      </div>

      {/* operator access: the one place sign-in lives, always reachable */}
      <section id="operator-access" className="mt-6 scroll-mt-20 overflow-hidden rounded-xl border border-edge bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label">Operator access</p>
          <WalletSignIn onSession={handleSession} />
        </div>
      </section>

      {/* 1 · define */}
      <section className="mt-8 overflow-hidden rounded-xl border border-edge bg-panel">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label">1 · Define the index</p>
        </div>
        <div className="space-y-5 px-4 py-4 sm:px-5">
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <div>
              <label htmlFor="ix-name" className="x-label">Index name</label>
              <input
                id="ix-name"
                value={indexName}
                onChange={(e) => setIndexName(e.target.value)}
                placeholder="e.g. September Digital Large Cap"
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
              />
            </div>
            <div>
              <label htmlFor="ix-scheme" className="x-label">Weighting</label>
              <select
                id="ix-scheme"
                value={scheme}
                onChange={(e) => setScheme(e.target.value as typeof scheme)}
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none focus:ring-1 focus:ring-edge"
              >
                <option value="equal">Equal weight</option>
                <option value="market_cap">Market cap (supply × price)</option>
                <option value="custom">Custom weights</option>
              </select>
            </div>
          </div>

          {scheme === "custom" && (
            <div>
              <label htmlFor="ix-custom" className="x-label">
                Custom weights <span className="text-ink-faint">— SYMBOL: percent, comma or newline separated</span>
              </label>
              <input
                id="ix-custom"
                value={customWeights}
                onChange={(e) => setCustomWeights(e.target.value)}
                placeholder="WBTC: 40, ETH: 35, SOL: 25"
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
              />
              <p className="mt-1.5 text-[11.5px] text-ink-faint">
                Weights are normalized to 100. Invalid or missing weights are reported, never treated as zero.
              </p>
            </div>
          )}

          <div className="space-y-3">
            <p className="x-label">Universe <span className="text-ink-faint">— at least two assets</span></p>
            {rows.map((r, i) => (
              <div key={r.id} className="rounded-lg border border-edge bg-panel-2 p-2.5">
                <div className="flex items-center justify-between">
                  <p className="x-label">Asset {i + 1}</p>
                  {rows.length > 2 && (
                    <button
                      type="button"
                      onClick={() => setRows((rs) => removeAssetRow(rs, r.id))}
                      className="text-ink-faint transition-colors hover:text-risk"
                      aria-label={`Remove asset ${i + 1}`}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  )}
                </div>
                <div className="mt-1.5 grid gap-2 sm:grid-cols-[92px_1fr_92px]">
                  <input
                    value={r.symbol}
                    name={rowFieldName(r.id, "symbol")}
                    autoComplete="off"
                    onChange={(e) => updateRow(r.id, { symbol: e.target.value.toUpperCase() })}
                    placeholder="SYMBOL"
                    aria-label={`Asset ${i + 1} symbol`}
                    className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                  />
                  <input
                    value={r.company}
                    name={rowFieldName(r.id, "company")}
                    autoComplete="off"
                    onChange={(e) => updateRow(r.id, { company: e.target.value })}
                    placeholder="Issuer registered legal name"
                    aria-label={`Asset ${i + 1} issuer company`}
                    className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                  />
                  <input
                    value={r.jurisdiction}
                    name={rowFieldName(r.id, "jurisdiction")}
                    autoComplete="off"
                    onChange={(e) => updateRow(r.id, { jurisdiction: e.target.value })}
                    placeholder="ISO, e.g. US"
                    aria-label={`Asset ${i + 1} jurisdiction`}
                    className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                  />
                </div>

                <details className="group mt-2">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
                    <ChevronRight size={12} aria-hidden className="transition-transform group-open:rotate-90" />
                    Advanced inputs (chain, pool, declared figures)
                  </summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <input
                      value={r.chain}
                      name={rowFieldName(r.id, "chain")}
                      autoComplete="off"
                      onChange={(e) => updateRow(r.id, { chain: e.target.value })}
                      placeholder="chain (default ethereum)"
                      aria-label={`Asset ${i + 1} chain`}
                      className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                    />
                    <input
                      value={r.pool}
                      name={rowFieldName(r.id, "pool")}
                      autoComplete="off"
                      onChange={(e) => updateRow(r.id, { pool: e.target.value })}
                      placeholder="DEX pool (needed for liquidity)"
                      aria-label={`Asset ${i + 1} pool`}
                      className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                    />
                    <input
                      value={r.declaredSupply}
                      name={rowFieldName(r.id, "declaredSupply")}
                      autoComplete="off"
                      onChange={(e) => updateRow(r.id, { declaredSupply: e.target.value })}
                      placeholder="declared circulating supply"
                      aria-label={`Asset ${i + 1} declared supply`}
                      className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                    />
                    <input
                      value={r.declaredPrice}
                      name={rowFieldName(r.id, "declaredPrice")}
                      autoComplete="off"
                      onChange={(e) => updateRow(r.id, { declaredPrice: e.target.value })}
                      placeholder="declared price USD"
                      aria-label={`Asset ${i + 1} declared price`}
                      className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                    />
                    <input
                      value={r.declaredVolume}
                      name={rowFieldName(r.id, "declaredVolume")}
                      autoComplete="off"
                      onChange={(e) => updateRow(r.id, { declaredVolume: e.target.value })}
                      placeholder="declared 30d volume USD"
                      aria-label={`Asset ${i + 1} declared volume`}
                      className="h-9 rounded-md border border-edge bg-panel px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge sm:col-span-2"
                    />
                    <p className="text-[11px] text-ink-faint sm:col-span-2">
                      Declared figures are labelled <span className="text-ink-soft">declared</span> — never presented as network-verified.
                    </p>
                  </div>
                </details>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRows((rs) => addAssetRow(rs))}
              className="inline-flex items-center gap-1.5 text-[12.5px] text-teal hover:underline"
            >
              <Plus size={13} aria-hidden /> Add asset
            </button>
          </div>

          <details className="group rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-ink-soft">
              <ChevronRight size={12} aria-hidden className="transition-transform group-open:rotate-90" />
              Methodology notes (optional)
            </summary>
            <input
              id="ix-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. quarterly rebalance, capped at 30% per constituent"
              className="mt-2 h-9 w-full rounded-md border border-edge bg-panel px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
            />
            <p className="mt-1 text-[11px] text-ink-faint">Recorded verbatim in the proposal.</p>
          </details>

          <div className="grid gap-4 border-t border-edge pt-4 sm:grid-cols-2">
            <div>
              <label htmlFor="ix-mode" className="x-label">Mode</label>
              <select
                id="ix-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none focus:ring-1 focus:ring-edge"
              >
                <option value="free">Free — probes only, no purchases</option>
                <option value="intel">Intel — paid asks after you approve</option>
              </select>
              <p className="mt-1.5 text-[11px] text-ink-faint">
                {mode === "intel" && !signedIn
                  ? "Paid intel needs the operator session above; running it anonymously is refused."
                  : mode === "intel"
                    ? "Plans one paid ask per verified dimension and waits for approval."
                    : "Probes and declared inputs only; nothing is purchased."}
              </p>
            </div>
            {mode === "intel" && (
              <div>
                <label htmlFor="ix-limit" className="x-label">Maximum spend (USD)</label>
                <input
                  id="ix-limit"
                  value={spendLimit}
                  onChange={(e) => setSpendLimit(e.target.value)}
                  placeholder="e.g. 0.30"
                  inputMode="decimal"
                  className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                />
                <p className="mt-1.5 text-[11.5px] text-ink-faint">Optional. Nothing is signed before your approval.</p>
              </div>
            )}
          </div>

          <button type="button" onClick={() => (mode === "intel" && !creating ? setPaidConfirmOpen(true) : void runDesk())} disabled={!canRun} className="btn-primary inline-flex items-center gap-2">
            {creating ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Play size={14} aria-hidden />}
            {creating ? "Starting the investigation…" : "Run the desk"}
          </button>

          <ConfirmPaidRun
            open={paidConfirmOpen}
            title="Start a paid desk run?"
            body="The desk plans every routable dimension against the live network, then stops at the approval gate — you see the exact priced plan before anything is signed."
            cost={(() => {
              const parsed = parseSpendLimitUsd(spendLimit);
              return parsed.ok && parsed.cents
                ? `Paid from the deployment's payer wallet, hard-capped at $${(parsed.cents / 100).toFixed(2)} for this run.`
                : "This run is paid from the deployment's payer wallet. Set a maximum spend above, or let the approval gate fix the exact amount — nothing is signed until you approve.";
            })()}
            confirmLabel="Start the paid run"
            busy={creating}
            onConfirm={() => {
              setPaidConfirmOpen(false);
              void runDesk();
            }}
            onCancel={() => setPaidConfirmOpen(false)}
          />
          {!canRun && !creating && (
            <p className="text-[11.5px] text-ink-faint">
              Add an index name and at least two complete assets (symbol, registered legal name, jurisdiction) to run.
            </p>
          )}
          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            The pre-flight probes are free. Intel mode plans one paid ask per asset per verified dimension and
            stops at the approval gate; each ask runs once, drift-checked and budget-guarded.
          </p>
        </div>
      </section>

      {error && (
        <section className="mt-5 rounded-xl border border-risk/40 bg-risk/5 p-4 text-[13px] break-words [overflow-wrap:anywhere] text-risk" role="alert">
          <p className="flex items-center gap-1.5 font-medium"><XCircle size={14} aria-hidden /> {sanitizeDeskMessage(error)}</p>
        </section>
      )}

      {/* technical coverage — collapsed by default */}
      <details className="group mt-5 rounded-xl border border-edge bg-panel">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[12.5px] text-ink-soft sm:px-5">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Layers size={13} aria-hidden /> Network coverage &amp; technical details
          </span>
          <span className="text-[11px] text-ink-faint">
            {guarantees.coverage.length} dimensions · {guarantees.nodeUrl.replace(/^https?:\/\//, "")}
          </span>
        </summary>
        <div className="border-t border-edge px-4 py-3 sm:px-5">
          <div className="divide-y divide-edge">
            {guarantees.coverage.map((c) => (
              <div key={c.intent} className="grid gap-x-4 gap-y-0.5 py-2 text-[12px] sm:grid-cols-[180px_1fr_auto]">
                <span className="text-ink">{c.dimension}</span>
                <span className="break-words text-ink-faint">
                  {c.intent} <span className="text-ink-soft">@ {c.miner}</span>
                </span>
                <span className="tabular text-ink-soft">{c.price}</span>
              </div>
            ))}
          </div>
          <ul className="mt-2 space-y-1 border-t border-edge pt-2">
            {guarantees.notCovered.map((n) => (
              <li key={n} className="flex items-start gap-2 text-[11.5px] text-amber-deep">
                <CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      </details>

      {/* 2 · investigation */}
      <div ref={resultRef}>
        {taskId && (
          <div className="mt-6 space-y-4">
            {rawTask && (
              <RunFlow
                task={rawTask}
                mode={rawTask.permissions.requiresApproval ? "intel" : "free"}
                routableCount={guarantees.coverage.length}
                ceilingUsdCents={rawTask.spend.limitUsdCents}
                canAct={canAct}
                signedIn={signedIn}
                acting={acting}
                actionError={actionError}
                onApprove={() => void act("approve")}
                onReject={() => void act("reject")}
                onResume={() => void resumeRun()}
                resuming={resuming}
                onRunAgain={reset}
                onSignIn={() => {
                  document.getElementById("operator-access")?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                onReadReport={() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                redacted={snap?.redacted ?? false}
                watchdog={watchdog}
              />
            )}

            {/* completed — the desk's own proposal view, driven by the same task */}
            {state === "completed" && snap?.report && (
              <IndexReportView report={snap.report} spendUsdCents={snap.spendUsdCents ?? 0} evidence={snap.evidence} />
            )}
            {state === "completed" && !snap?.report && !snap?.redacted && (
              <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3.5 text-[12.5px] text-ink-soft">
                <p className="flex items-center gap-1.5 font-medium text-amber-deep">
                  <CircleAlert size={13} aria-hidden /> Completed without a readable report
                </p>
                <p className="mt-1.5">The task finished but carries no proposal. Open it from Activity to inspect the full record.</p>
              </div>
            )}

            {state === "completed" && (
              <button type="button" onClick={reset} className="text-[12.5px] font-medium text-teal hover:underline">
                Start a new investigation
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The report view                                                     */
/* ------------------------------------------------------------------ */

const INPUT_LABELS: Record<string, string> = {
  marketCap: "Market cap",
  supply: "Supply",
  price: "Price (USD)",
  liquidityUsd: "Liquidity (USD)",
  holders: "Holders",
  filings: "Filings",
  volume30dUsd: "30d volume (USD)",
};

function IndexReportView({ report, spendUsdCents, evidence }: { report: IndexDeskReport; spendUsdCents: number; evidence: DeskEvidence[] }) {
  const p = report.methodology.proposal;
  const missing = displayMissingDimensions(report.missingDimensions);
  const portfolioMissing = missing.filter((m) => m.scope === "portfolio");
  const assetMissing = missing.filter((m) => m.scope === "asset");

  return (
    <div className="space-y-5">
      {/* proposal */}
      {p ? (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-teal">
              <BadgeCheck size={14} aria-hidden /> Constituent proposal
            </p>
            <span className="text-[11.5px] text-ink-soft">
              {p.scheme === "market_cap" ? "Market-cap weighted" : p.scheme === "custom" ? "Custom-weighted" : "Equal-weighted"}
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {p.weights.map((w) => (
              <div key={w.symbol}>
                <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="font-medium text-ink">{w.symbol}</span>
                  <span className="tabular text-ink">{w.weightPct.toFixed(2)}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-3">
                  <div className="h-full rounded-full bg-teal" style={{ width: `${Math.min(100, Math.max(0, w.weightPct))}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-1 border-t border-teal/20 pt-2.5 text-[11.5px] text-ink-soft sm:grid-cols-2">
            <span>Sum {p.weightSumPct.toFixed(2)}%{p.normalizedFrom !== undefined ? ` (normalized from ${p.normalizedFrom.toFixed(2)}%)` : ""}</span>
            <span className="tabular">HHI {p.concentration.hhi.toFixed(4)} · effective N {p.concentration.effectiveN.toFixed(2)}</span>
            <span className="tabular">Top-1 {p.concentration.top1Pct.toFixed(2)}% · top-3 {p.concentration.top3Pct.toFixed(2)}%</span>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3.5 text-[12.5px] text-ink-soft">
          <p className="flex items-center gap-1.5 font-medium text-amber-deep"><AlertTriangle size={13} aria-hidden /> No weighting proposed</p>
          <p className="mt-1">{report.methodology.proposalBlocker}</p>
        </div>
      )}

      {/* per-asset */}
      <div>
        <p className="x-label">Per-asset evidence <span className="text-ink-faint">— every dimension carries its honest status</span></p>
        <div className="mt-2 space-y-3">
          {report.assets.map((a) => {
            const inputs = (
              Object.entries(a.inputs ?? {}) as Array<[string, { value: number; provenance: string } | undefined]>
            ).filter(([, v]) => v !== undefined);
            const probes = dedupeProbes(report.baseline.probes.filter((pr) => pr.symbol === a.symbol));
            const receipts = assetReceipts(evidence, a.symbol);
            return (
              <div key={a.symbol} className="overflow-hidden rounded-lg border border-edge bg-panel-2">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-ink">{a.symbol}</span>
                      <Chip label={a.status} tone={STATUS_TONE[a.status] ?? "border-edge bg-panel text-ink-soft"} />
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-ink-faint">{a.issuer} · {a.issuerJurisdiction}</p>
                  </div>
                  {a.weightPct !== undefined && <span className="tabular text-[13px] font-medium text-ink">{a.weightPct.toFixed(2)}%</span>}
                </div>

                {(a.exclusionReason || a.provisionalReason) && (
                  <p className="border-b border-edge bg-panel px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
                    {a.exclusionReason ?? a.provisionalReason}
                  </p>
                )}

                {inputs.length > 0 && (
                  <div className="grid gap-2 px-3 py-2.5 sm:grid-cols-2">
                    {inputs.map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-2 rounded-md border border-edge bg-panel px-2.5 py-1.5">
                        <span className="text-[11.5px] text-ink-faint">{INPUT_LABELS[key] ?? dimensionLabel(key)}</span>
                        <span className="flex items-center gap-1.5">
                          <span className="tabular text-[12px] text-ink">{fmtNumber(value!.value)}</span>
                          <Chip
                            label={value!.provenance === "telegraph-verified" ? "verified" : "declared"}
                            tone={STATUS_TONE[value!.provenance === "telegraph-verified" ? "verified" : "declared"]}
                          />
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="border-t border-edge px-3 py-2 text-[11.5px] text-ink-faint">
                  Registry fields {a.dataQuality.registryFieldsKnown}/{a.dataQuality.registryFieldsTotal} · dimensions
                  verified {a.dataQuality.dimensionsVerified}/{a.dataQuality.dimensionsTotal} · conflicts{" "}
                  {a.dataQuality.disagreements} · quality score {a.dataQuality.score}/100
                </div>

                {(probes.length > 0 || receipts.length > 0) && (
                  <details className="group border-t border-edge">
                    <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
                      <span className="inline-flex items-center gap-1">
                        <ChevronRight size={12} aria-hidden className="transition-transform group-open:rotate-90" />
                        Probe &amp; receipt details ({probes.length + receipts.length})
                      </span>
                    </summary>
                    <div className="space-y-1.5 border-t border-edge px-3 py-2">
                      {probes.map((pr) => (
                        <div key={pr.dimension} className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
                          <span className="w-32 shrink-0 text-ink-faint">{dimensionLabel(pr.dimension)}</span>
                          <span className="text-ink-soft">
                            {pr.status === "challenge"
                              ? `routable at ${money(pr.priceUsdCents ?? 0)}`
                              : pr.status === "not_askable"
                                ? "needs more input"
                                : pr.status}
                          </span>
                        </div>
                      ))}
                      {receipts.map((r, i) => (
                        <div key={`${r.dimension}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
                          <span className="w-32 shrink-0 text-ink-faint">{dimensionLabel(r.dimension)}</span>
                          {r.signalHash && HASH_RE.test(r.signalHash) ? (
                            <Link href={`/signals/${r.signalHash}`} className="inline-flex items-center gap-0.5 break-all text-teal hover:underline">
                              {shortHash(r.signalHash)} <ExternalLink size={10} aria-hidden />
                            </Link>
                          ) : (
                            <span className="break-all text-ink-soft">{r.signalHash ?? "—"}</span>
                          )}
                          {typeof r.costUsdCents === "number" && <span className="tabular text-ink-soft">{money(r.costUsdCents)}</span>}
                          {r.value !== undefined && <span className="tabular text-ink">→ {fmtValue(r.value)}</span>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* spend */}
      <p className="text-[11.5px] text-ink-faint">
        Total spent on this investigation: <span className="tabular text-ink-soft">{money(spendUsdCents)}</span>
        {report.mode === "free" ? " · free mode: no purchases were made" : ""}
      </p>

      {/* missing dimensions */}
      <div>
        <p className="x-label">Missing-dimension ledger <span className="text-ink-faint">— identified, never fabricated</span></p>
        {missing.length === 0 ? (
          <p className="mt-2 rounded-lg border border-teal/30 bg-teal/5 px-3 py-2 text-[12px] text-ink-soft">
            No missing dimensions — every declared dimension verified in this run.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {portfolioMissing.map((m) => (
              <div key={m.key} className="rounded-lg border border-amber/40 bg-amber-soft/40 px-3 py-2 text-[12px] text-ink-soft">
                <span className="font-medium text-amber-deep">Portfolio-wide · {m.dimension}</span> — {m.reason}
              </div>
            ))}
            {assetMissing.length > 0 && (
              <details className="group rounded-lg border border-amber/40 bg-amber-soft/40">
                <summary className="cursor-pointer list-none px-3 py-2 text-[12px] text-ink-soft">
                  Per-asset gaps ({assetMissing.length})
                </summary>
                <div className="space-y-1.5 border-t border-amber/30 px-3 py-2">
                  {assetMissing.map((m) => (
                    <p key={m.key} className="text-[11.5px] text-ink-soft">
                      <span className="font-medium text-amber-deep">{m.symbol}</span> · {m.dimension} — {m.reason}
                    </p>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {/* reasoning */}
      <div>
        <p className="x-label">Reasoning <span className="text-ink-faint">— every step cites its evidence</span></p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12.5px] text-ink-soft">
          {report.reasoning.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
      </div>

      <details className="group rounded-lg border border-edge bg-panel-2">
        <summary className="cursor-pointer list-none px-3 py-2 text-[12px] text-ink-soft">
          Methodology rules ({report.methodology.methodologyRules.length})
        </summary>
        <ol className="list-decimal space-y-1.5 border-t border-edge px-3 py-2 pl-7 text-[12px] text-ink-soft">
          {report.methodology.methodologyRules.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
      </details>

      <p className="text-[11.5px] text-ink-faint">
        Confidence: {report.confidence}. The proposal is deterministic: rerun with the same definition and the same
        network answers and the weights reproduce exactly.
      </p>
    </div>
  );
}

function dedupeProbes<T extends { dimension: string }>(probes: T[]): T[] {
  const seen = new Map<string, T>();
  for (const p of probes) if (!seen.has(p.dimension)) seen.set(p.dimension, p);
  return [...seen.values()];
}

function assetReceipts(evidence: DeskEvidence[], symbol: string) {
  const ev = evidence.find((e) => e.symbol === symbol);
  if (!ev) return [];
  return ev.dimensions.filter((d) => d.signalHash);
}
