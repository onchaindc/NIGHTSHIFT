"use client";

/**
 * The interactive payment terminal. A strict, human-checked sequence:
 *
 *   compose (guided or advanced JSON) → preview (the node's UNPAID verdict:
 *   either its pre-payment validation error or the live x402 challenge) →
 *   approval (the exact offer: scheme, network, asset, amount, payTo, payer)
 *   → execute (only with the approval box checked; the server refuses if the
 *   live challenge has drifted) → result (answer + receipt + settlement) →
 *   verify (or watch) the signal on the node.
 *
 * Nothing here invents a price, a provider, or a success: every value shown
 * comes from a real node answer, and every failure state is displayed as it
 * actually is.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, Loader2, Search, Terminal as TerminalIcon, XCircle } from "lucide-react";

export interface TerminalIntentSummary {
  intent: string;
  minerCount: number;
  description: string;
}

export interface TerminalWalletState {
  configured: boolean;
  address: string | null;
}

interface IntentParam {
  name: string;
  type: string;
  required?: boolean;
  enum?: unknown[];
  description?: string;
  min?: number;
  max?: number;
  pattern?: string;
}

interface IntentDetail {
  intent: string;
  minerCount: number;
  params: IntentParam[];
  schemaVersion?: number;
  responseFields: Array<Record<string, unknown>> | null;
  miners: Array<{ minerId: string; slug: string; name: string; description?: string }>;
}

interface Offer {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string; // atomic 6-decimal units
}

interface ChallengeInfo {
  x402Version: number | null;
  scheme: string;
  network: string;
  asset: string;
  assetName: string | null;
  assetVersion: string | null;
  amount: string;
  amountUsdCents: number;
  payTo: string;
  maxTimeoutSeconds: number | null;
  resource: unknown;
}

interface AnswerInfo {
  result: unknown;
  resultShape?: string;
  shapeError?: string;
  fieldStatus?: Record<string, unknown>;
  minerId?: string;
  minerName?: string;
  endpoint?: string;
  intent?: string;
  input?: unknown;
  costUsd?: number;
  durationMs?: number;
  timestamp?: string;
  warnings?: unknown;
}

interface ReceiptInfo {
  receipt_hash: string;
  rail: string;
  payer: string;
  miner: string;
  intent: string;
  amount_uusdc: string;
  epoch_id: number;
  settlement: string;
  chain: string;
  tx_hash?: string;
  timestamp: number;
}

type PipelineStage = "compose" | "preview" | "executing" | "result";

/** Renders the node's raw pre-payment verdict (error, problems, message). */
function NodeVerdict({ verdict }: { verdict: unknown }) {
  if (verdict == null) return null;
  if (typeof verdict === "string") {
    return <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{verdict}</p>;
  }
  const v = verdict as Record<string, unknown>;
  const problems = Array.isArray(v.problems) ? v.problems : null;
  return (
    <div className="mt-2 space-y-2">
      {typeof v.error === "string" && <p className="tabular text-[11.5px] text-risk">{v.error}</p>}
      {typeof v.message === "string" && v.message !== v.error && <p className="text-[12px] leading-relaxed text-ink-soft">{v.message}</p>}
      {Array.isArray(v.intents) && (
        <p className="tabular text-[11px] text-ink-faint">This miner serves: {(v.intents as string[]).join(", ").slice(0, 300)}</p>
      )}
      {problems && (
        <ul className="space-y-1">
          {(problems as Array<{ param?: string; code?: string; message?: string }>).map((p, i) => (
            <li key={i} className="tabular text-[11.5px] text-ink-soft">
              <span className="text-risk">{p.code ?? "problem"}</span>
              {p.param ? <span className="text-ink"> · {p.param}</span> : null}
              {p.message ? <span> — {p.message}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {!v.error && !v.message && !problems && (
        <pre className="overflow-x-auto rounded-lg bg-panel-2 p-2 font-mono text-[10.5px] leading-relaxed text-ink-soft">{JSON.stringify(v, null, 2).slice(0, 1200)}</pre>
      )}
    </div>
  );
}

export default function TerminalClient({
  intents,
  wallet,
  initialIntent,
  initialMiner,
  nodeUrl,
}: {
  intents: TerminalIntentSummary[];
  wallet: TerminalWalletState;
  initialIntent?: string;
  initialMiner?: string;
  nodeUrl: string;
}) {
  const [mode, setMode] = useState<"guided" | "advanced">("guided");

  // Guided state
  const [intentQuery, setIntentQuery] = useState("");
  const [selectedIntent, setSelectedIntent] = useState<string | null>(initialIntent?.toUpperCase() ?? null);
  const [intentDetail, setIntentDetail] = useState<IntentDetail | null>(null);
  const [intentDetailError, setIntentDetailError] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [queryText, setQueryText] = useState("");
  const [minerId, setMinerId] = useState<string | null>(null); // null = auto-route

  // Advanced state
  const [rawJson, setRawJson] = useState("");

  // Pipeline state
  const [stage, setStage] = useState<PipelineStage>("compose");
  const [previewStatus, setPreviewStatus] = useState<"challenge" | "refused" | "unavailable" | null>(null);
  const [nodeVerdict, setNodeVerdict] = useState<unknown>(null);
  const [previewHttp, setPreviewHttp] = useState<number | null>(null);
  const [bodyPlan, setBodyPlan] = useState<{ path: string; body: unknown } | null>(null);
  const [challenge, setChallenge] = useState<{ offer: Offer; payment: ChallengeInfo } | null>(null);
  const [approvedOffer, setApprovedOffer] = useState<Offer | null>(null);
  const [approvalBox, setApprovalBox] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [answer, setAnswer] = useState<{ answer: AnswerInfo; signalHash: string; receipt: ReceiptInfo; settlement: string | null } | null>(null);
  const [failure, setFailure] = useState<{ heading: string; detail: string; node?: unknown } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{ kind: "verified" | "recorded" | "unverified"; note: string } | null>(null);
  const [log, setLog] = useState<Array<{ ts: number; text: string; tone: "info" | "warn" | "bad" | "good" }>>([]);

  const pushLog = useCallback((text: string, tone: "info" | "warn" | "bad" | "good" = "info") => {
    setLog((l) => [...l.slice(-40), { ts: Date.now(), text, tone }]);
  }, []);

  /* ---- intent detail loading -------------------------------------- */

  useEffect(() => {
    if (mode !== "guided" || !selectedIntent) return;
    let alive = true;
    setIntentDetail(null);
    setIntentDetailError(null);
    setParamValues({});
    (async () => {
      try {
        const res = await fetch(`/api/terminal/intents/${encodeURIComponent(selectedIntent)}`);
        const body = (await res.json()) as { error?: string; detail?: string } & IntentDetail;
        if (!alive) return;
        if (!res.ok) {
          setIntentDetailError(body.error ?? body.detail ?? `HTTP ${res.status}`);
          pushLog(`Intent ${selectedIntent}: not available right now (${body.error ?? res.status}).`, "warn");
          return;
        }
        setIntentDetail({
          intent: body.intent,
          minerCount: body.minerCount,
          params: body.params ?? [],
          schemaVersion: body.schemaVersion,
          responseFields: body.responseFields ?? null,
          miners: body.miners ?? [],
        });
        if (initialMiner && (body.miners ?? []).some((m) => m.slug === initialMiner || m.minerId === initialMiner)) {
          setMinerId(initialMiner);
          pushLog(`Miner pre-selected: ${initialMiner}.`, "info");
        }
        pushLog(`Intent ${body.intent}: ${(body.params ?? []).length} input params, ${body.minerCount} supporting miners live.`, "good");
      } catch (err) {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : String(err);
        setIntentDetailError(msg);
        pushLog(`Intent ${selectedIntent} could not be read: ${msg}`, "bad");
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode, selectedIntent, pushLog]);

  /* ---- compose helpers --------------------------------------------- */

  const filteredIntents = useMemo(() => {
    const q = intentQuery.trim().toLowerCase();
    if (!q) return intents;
    return intents.filter((i) => i.intent.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  }, [intents, intentQuery]);

  /** The exact body the node would be paid for, from either mode. */
  const buildSpec = useCallback((): { body: unknown; error?: string } => {
    if (mode === "advanced") {
      const trimmed = rawJson.trim();
      if (!trimmed) return { body: null, error: "Paste the request JSON first." };
      try {
        return { body: JSON.parse(trimmed) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { body: null, error: `Not valid JSON: ${msg}` };
      }
    }
    if (!selectedIntent || !intentDetail) return { body: null, error: "Select an intent first." };
    if (intentDetail.params.length > 0) {
      const params: Record<string, unknown> = {};
      for (const p of intentDetail.params) {
        const raw = paramValues[p.name] ?? "";
        if (p.required && raw.trim().length === 0) {
          return { body: null, error: `Param "${p.name}" is required.` };
        }
        if (raw.trim().length === 0) continue;
        if (p.type === "number" || p.type === "integer") {
          const num = Number(raw);
          if (!Number.isFinite(num)) return { body: null, error: `Param "${p.name}" must be a ${p.type}.` };
          params[p.name] = num;
        } else {
          params[p.name] = raw.trim();
        }
      }
      return { body: { intent: selectedIntent, params } };
    }
    if (queryText.trim().length === 0) {
      return { body: null, error: "This intent has no input params — write the question for it instead." };
    }
    return { body: { query: queryText.trim() } };
  }, [mode, rawJson, selectedIntent, intentDetail, paramValues, queryText]);

  /* ---- preview ------------------------------------------------------ */

  const runPreview = useCallback(async () => {
    const spec = buildSpec();
    if (spec.error) {
      setPreviewStatus("refused");
      setPreviewHttp(null);
      setNodeVerdict({ error: "invalid request composition", message: spec.error });
      pushLog(`Compose is incomplete: ${spec.error}`, "warn");
      return;
    }
    setStage("preview");
    setFailure(null);
    setApprovalBox(false);
    setVerifyStatus(null);
    setAnswer(null);
    setPreviewStatus(null);
    setNodeVerdict(null);
    setPreviewHttp(null);
    try {
      const payload: Record<string, unknown> =
        mode === "advanced" ? { rawBody: spec.body } : { ...(spec.body as Record<string, unknown>) };
      if (minerId) payload.miner = minerId;
      pushLog(`Pre-flight (no payment) — same body execution would sign.`, "info");
      const res = await fetch("/api/terminal/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (body.status === "challenge") {
        setBodyPlan((body.request as { path: string; body: unknown }) ?? null);
        setChallenge({ offer: body.offer as Offer, payment: body.payment as ChallengeInfo });
        setApprovedOffer(body.offer as Offer);
        setPreviewStatus("challenge");
        const p = body.payment as ChallengeInfo;
        pushLog(`The node challenges this request: ${p.amount} atomic units of ${p.assetName ?? p.asset} on ${p.network} to ${p.payTo}. Nothing is signed yet.`, "good");
      } else if (body.status === "refused") {
        setPreviewHttp(typeof body.httpStatus === "number" ? body.httpStatus : null);
        setNodeVerdict(body.node ?? body.detail ?? null);
        setBodyPlan((body.request as { path: string; body: unknown }) ?? null);
        setPreviewStatus("refused");
        pushLog(`The node refused this request before payment (HTTP ${body.httpStatus ?? "?"}). Nothing was or will be charged.`, "bad");
      } else {
        setPreviewStatus("unavailable");
        setNodeVerdict(String(body.detail ?? "The node could not be probed."));
        pushLog(`Pre-flight unavailable: ${String(body.detail ?? "unknown")}`, "bad");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPreviewStatus("unavailable");
      setNodeVerdict(msg);
      pushLog(`Pre-flight failed: ${msg}`, "bad");
    }
  }, [buildSpec, mode, minerId, pushLog]);

  /* ---- execute ------------------------------------------------------ */

  const runExecute = useCallback(async () => {
    if (!challenge || !approvedOffer) return;
    setApprovalBox(false);
    setExecuting(true);
    setStage("executing");
    pushLog("Approval recorded for this exact offer. Executing the paid request…", "info");
    try {
      const payload: Record<string, unknown> =
        mode === "advanced" ? { rawBody: JSON.parse(rawJson) } : { ...(buildSpec().body as Record<string, unknown>) };
      if (minerId) payload.miner = minerId;
      payload.approved = true;
      payload.offer = approvedOffer;
      const res = await fetch("/api/terminal/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (body.status === "answered") {
        setAnswer({
          answer: body.answer as AnswerInfo,
          signalHash: body.signalHash as string,
          receipt: body.receipt as ReceiptInfo,
          settlement: (body.settlement as string | null) ?? null,
        });
        setChallenge(null);
        setStage("result");
        pushLog("Answer delivered with a receipt and a signal hash. Run verification before trusting it.", "good");
      } else if (body.status === "refused") {
        const freshOffer = (body.fresh as { offer?: Offer } | undefined)?.offer ?? null;
        const detail = String(body.detail ?? "The live offer drifted from the approved one.");
        setFailure({ heading: "Refused — nothing was signed", detail, node: body.node ?? null });
        if (freshOffer) {
          setChallenge({ offer: freshOffer, payment: { ...challenge.payment, ...freshOffer, amountUsdCents: Number(freshOffer.amount) / 10000 } });
        }
        pushLog(detail, "warn");
        setStage("preview");
      } else if (body.status === "payment_rejected") {
        setFailure({ heading: "Payment rejected", detail: String(body.detail ?? "") });
        pushLog("The signed payment did not verify; per the x402 flow nothing settled and the request was not re-sent.", "bad");
      } else if (body.status === "failed") {
        setFailure({ heading: `Request failed (HTTP ${body.httpStatus ?? "?"})`, detail: String(body.detail ?? "") });
        pushLog(`Paid request failed after settlement may have begun. ${String(body.detail ?? "")}`, "bad");
      } else if (body.status === "integrity") {
        setFailure({ heading: "Unaccountable response", detail: String(body.detail ?? "") });
        pushLog("The response cannot be reconciled against the network; it is NOT treated as a confirmed answer.", "bad");
      } else {
        setFailure({ heading: "Execution did not start", detail: String(body.detail ?? "unknown"), node: body.node ?? null });
        pushLog(`Execution did not start: ${String(body.detail ?? "unknown")}`, "bad");
        setStage("preview");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFailure({ heading: "Execution failed", detail: msg });
      pushLog(`Execution failed: ${msg}`, "bad");
    } finally {
      setExecuting(false);
    }
  }, [challenge, approvedOffer, mode, rawJson, minerId, buildSpec, pushLog]);

  /* ---- verify ------------------------------------------------------- */

  const runVerify = useCallback(async () => {
    if (!answer?.signalHash) return;
    setVerifying(true);
    try {
      const res = await fetch("/api/terminal/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalHash: answer.signalHash }),
      });
      const body = (await res.json()) as { status?: string; note?: string; detail?: string };
      if (body.status === "verified") {
        setVerifyStatus({ kind: "verified", note: body.note ?? "" });
        pushLog("Verification: the hash re-derives exactly over the recorded payload.", "good");
      } else if (body.status === "recorded") {
        setVerifyStatus({ kind: "recorded", note: body.note ?? "" });
        pushLog(`Verification incomplete: ${body.note ?? ""}`, "warn");
      } else {
        setVerifyStatus({ kind: "unverified", note: body.detail ?? "" });
        pushLog(`Not verified yet: ${body.detail ?? ""}`, "warn");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setVerifyStatus({ kind: "unverified", note: msg });
      pushLog(`Verification lookup failed: ${msg}`, "bad");
    } finally {
      setVerifying(false);
    }
  }, [answer, pushLog]);

  /* ---- rendering ---------------------------------------------------- */

  const canPreview = mode === "advanced" ? rawJson.trim().length > 0 : !!intentDetail;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="x-tag">EXPLORER · PAY PER REQUEST · x402 v2</p>
          <h1 className="x-display-1 mt-3 text-ink">The interactive terminal</h1>
          <p className="mt-3 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-soft">
            Compose a real request against <span className="tabular text-[12.5px]">{nodeUrl}</span>, read the node&apos;s
            verdict and the live x402 price before anything is signed, approve that exact offer, then receive the answer
            with its receipt and a signal you can reconcile against the network.
          </p>
        </div>
        <div className="rounded-lg border border-edge bg-panel px-4 py-3">
          <p className="x-label">Payer wallet</p>
          <p className="tabular mt-1 text-[11.5px] text-ink">
            {wallet.configured && wallet.address
              ? `${wallet.address}`
              : "Not configured — previews still run; nothing can be signed."}
          </p>
        </div>
      </div>

      <ol className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-faint">
        {(["compose", "preview", "executing", "result"] as const).map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={`tabular rounded-full px-2 py-0.5 ${stage === s ? "bg-amber-soft text-amber-deep" : stage === "result" && s === "result" ? "text-teal" : ""}`}>
              {i + 1}. {s}
            </span>
            {i < 3 && <ChevronRight size={12} aria-hidden />}
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ---------------- compose ---------------- */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <div className="flex items-center justify-between">
            <p className="x-label">Compose the request</p>
            <div className="flex rounded-lg border border-edge p-0.5" role="tablist" aria-label="Request mode">
              {(["guided", "advanced"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => {
                    setMode(m);
                    setPreviewStatus(null);
                    setNodeVerdict(null);
                    setChallenge(null);
                    setMinerId(null);
                  }}
                  className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${mode === m ? "bg-panel-3 text-ink" : "text-ink-faint hover:text-ink-soft"}`}
                >
                  {m === "guided" ? "Guided" : "Advanced JSON"}
                </button>
              ))}
            </div>
          </div>

          {mode === "guided" ? (
            <div className="mt-4 space-y-4">
              <div>
                <p className="x-label">1 · Intent</p>
                {selectedIntent ? (
                  <p className="mt-2 text-[12px] text-ink-soft">
                    Selected: <span className="tabular text-ink">{selectedIntent}</span>{" "}
                    <button onClick={() => { setSelectedIntent(null); setIntentDetail(null); setMinerId(null); }} className="text-[11px] text-amber hover:text-amber-deep">clear</button>
                  </p>
                ) : (
                  <>
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-edge bg-panel-2 px-3">
                      <Search size={13} className="text-ink-faint" aria-hidden />
                      <input
                        value={intentQuery}
                        onChange={(e) => setIntentQuery(e.target.value)}
                        placeholder={`Search ${intents.length} intents…`}
                        aria-label="Search intents"
                        className="h-9 w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
                      />
                    </div>
                    <ul className="mt-2 max-h-44 divide-y divide-edge overflow-y-auto rounded-lg border border-edge bg-panel-2">
                      {filteredIntents.length === 0 ? (
                        <li className="px-3 py-3 text-[12px] text-ink-faint">No intent matches the search.</li>
                      ) : (
                        filteredIntents.slice(0, 80).map((i) => (
                          <li key={i.intent}>
                            <button onClick={() => setSelectedIntent(i.intent)} className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-panel-3">
                              <span className="tabular text-[11.5px] text-ink">{i.intent.toLowerCase().replaceAll("_", " ")}</span>
                              <span className="tabular shrink-0 text-[10.5px] text-ink-faint">{i.minerCount} miners</span>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  </>
                )}
              </div>

              {selectedIntent && intentDetailError && (
                <div className="rounded-lg border border-amber/40 bg-amber-soft/50 p-3 text-[12px] text-ink-soft">
                  <p className="flex items-center gap-1.5 font-medium text-amber-deep"><AlertTriangle size={12} aria-hidden /> This intent could not be inspected</p>
                  <p className="mt-1">{intentDetailError}</p>
                </div>
              )}

              {intentDetail && (
                <>
                  <div>
                    <p className="x-label">2 · Parameters{intentDetail.params.length === 0 ? " — none: this intent takes a plain question" : ""}</p>
                    {intentDetail.params.length > 0 ? (
                      <div className="mt-2 space-y-3">
                        {intentDetail.params.map((p) => (
                          <label key={p.name} className="block">
                            <span className="tabular text-[11px] font-medium text-ink">
                              {p.name}
                              <span className="ml-1.5 font-normal text-ink-faint">{p.type}{p.required ? " · required" : " · optional"}</span>
                            </span>
                            {p.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{p.description}</span>}
                            <input
                              value={paramValues[p.name] ?? ""}
                              onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))}
                              placeholder={p.pattern ? `matches ${p.pattern}` : p.type}
                              className="mt-1.5 h-9 w-full rounded-lg border border-edge bg-panel-2 px-3 tabular text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal"
                            />
                          </label>
                        ))}
                      </div>
                    ) : (
                      <textarea
                        value={queryText}
                        onChange={(e) => setQueryText(e.target.value)}
                        rows={3}
                        placeholder="Type what you want answered…"
                        aria-label="Question for this intent"
                        className="mt-2 w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal"
                      />
                    )}
                  </div>

                  <div>
                    <p className="x-label">3 · Supporting miner</p>
                    <div className="mt-2 space-y-1.5">
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[12px] text-ink-soft transition-colors hover:border-edge-strong">
                        <input type="radio" name="miner" checked={minerId === null} onChange={() => setMinerId(null)} className="mt-0.5 accent-[var(--color-amber)]" />
                        <span>
                          Auto-route — the router picks the miner for this intent and falls back if its pick is down.
                          <span className="tabular mt-0.5 block text-[10.5px] text-ink-faint">POST /engine/v1/ask</span>
                        </span>
                      </label>
                      {intentDetail.miners.map((m) => (
                        <label key={m.minerId} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[12px] text-ink-soft transition-colors hover:border-edge-strong">
                          <input
                            type="radio"
                            name="miner"
                            checked={minerId === m.minerId || minerId === m.slug}
                            onChange={() => {
                              setMinerId(m.minerId);
                              pushLog(`Miner pinned: ${m.name} (${m.minerId}). The ask goes direct — no fallback.`, "info");
                            }}
                            className="mt-0.5 accent-[var(--color-amber)]"
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-ink">{m.name}</span>
                            {m.description && <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint line-clamp-2">{m.description}</span>}
                            <span className="tabular mt-0.5 block text-[10.5px] text-ink-faint">POST /engine/v1/ask/{m.minerId} · slug {m.slug}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                Paste the exact body the node should answer: a canonical ask <code className="tabular">{'{"intent": …, "params": {…}}'}</code>, a
                plain-language ask <code className="tabular">{'{"query": …}'}</code>, or the miner&apos;s native form when a miner is pinned below. The node
                validates it before payment.
              </p>
              <textarea
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                rows={8}
                spellCheck={false}
                aria-label="Advanced request JSON"
                className="w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal"
                placeholder={'{"intent":"CRYPTO_PRICE_USD","params":{"symbol":"BTC"}}'}
              />
              <label className="block">
                <span className="x-label">Optional: pin a miner (id or slug) for a direct ask</span>
                <input
                  value={minerId ?? ""}
                  onChange={(e) => setMinerId(e.target.value.trim() || null)}
                  className="mt-1.5 h-9 w-full rounded-lg border border-edge bg-panel-2 px-3 tabular text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal"
                  placeholder="e.g. 9002 or txlens"
                />
              </label>
            </div>
          )}

          <button onClick={runPreview} disabled={!canPreview} className="btn-primary mt-5 w-full !justify-center">
            Preview the request — no payment <ArrowRight size={14} aria-hidden />
          </button>
          {!wallet.configured && (
            <p className="mt-3 text-[11.5px] text-amber">Without a payer wallet configured on this deployment, previews still validate, but execution cannot sign.</p>
          )}
        </section>

        {/* ---------------- verdict / price ---------------- */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">The node&apos;s verdict and the live price</p>

          {previewStatus === null && !failure && (
            <div className="mt-4 rounded-lg border border-dashed border-edge bg-panel-2 p-6 text-[12.5px] text-ink-faint">
              Compose the request, then run the preview. The pre-flight posts the exact body with no payment: the node
              validates intent, params and miner before charging, so a broken ask is refused here for free and a valid
              ask returns the current x402 price. Nothing is signed at this step.
            </div>
          )}

          {previewStatus === "refused" && !failure && (
            <div className="mt-4 rounded-lg border border-risk/50 bg-panel-2 p-4">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-risk"><XCircle size={13} aria-hidden /> The node refused this request before payment</p>
              {previewHttp != null && <p className="tabular mt-1 text-[11px] text-ink-faint">HTTP {previewHttp}</p>}
              <NodeVerdict verdict={nodeVerdict} />
            </div>
          )}

          {previewStatus === "unavailable" && !failure && (
            <div className="mt-4 rounded-lg border border-amber/40 bg-amber-soft/60 p-4 text-[12.5px] text-ink-soft">
              <p className="flex items-center gap-1.5 font-medium text-amber-deep"><AlertTriangle size={13} aria-hidden /> The pre-flight could not complete</p>
              <p className="mt-1">{String(nodeVerdict ?? "")}</p>
            </div>
          )}

          {challenge && !failure && (
            <div className="mt-4 rounded-lg border border-edge bg-panel-3 p-4">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-teal"><TerminalIcon size={13} aria-hidden /> Payment requirements — the live x402 challenge</p>

              <dl className="mt-3 space-y-1.5 text-[12px]">
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Amount</dt>
                  <dd className="tabular text-right text-ink">
                    {challenge.payment.amount} atomic
                    <span className="block text-[10.5px] text-ink-soft">{(Number(challenge.payment.amount) / 10000).toFixed(2)} USDC (${challenge.payment.amountUsdCents.toFixed(2)})</span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Token</dt>
                  <dd className="tabular max-w-[70%] truncate text-right text-ink" title={challenge.payment.asset}>
                    {challenge.payment.asset}
                    {challenge.payment.assetName ? ` — ${challenge.payment.assetName}` : ""}
                    {challenge.payment.assetVersion ? ` v${challenge.payment.assetVersion}` : ""}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Network / chain</dt>
                  <dd className="tabular text-right text-ink">{challenge.payment.network}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Recipient (payTo)</dt>
                  <dd className="tabular max-w-[70%] truncate text-right text-ink" title={challenge.payment.payTo}>{challenge.payment.payTo}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Payer</dt>
                  <dd className="tabular max-w-[70%] truncate text-right text-ink" title={wallet.address ?? ""}>
                    {wallet.address ?? "not configured"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Scheme / x402</dt>
                  <dd className="tabular text-right text-ink">{challenge.payment.scheme}{challenge.payment.x402Version ? ` · v${challenge.payment.x402Version}` : ""}</dd>
                </div>
                {challenge.payment.maxTimeoutSeconds != null && (
                  <div className="flex justify-between gap-3">
                    <dt className="shrink-0 text-ink-faint">Max settle timeout</dt>
                    <dd className="tabular text-right text-ink">{challenge.payment.maxTimeoutSeconds}s</dd>
                  </div>
                )}
              </dl>

              {bodyPlan && (
                <div className="mt-3 rounded-lg border border-edge bg-panel p-2.5">
                  <p className="x-label">What would be sent</p>
                  <p className="tabular mt-1 text-[10.5px] text-ink-faint">POST {bodyPlan.path}</p>
                  <pre className="mt-1 overflow-x-auto font-mono text-[10.5px] leading-relaxed text-ink-soft">{JSON.stringify(bodyPlan.body, null, 2).slice(0, 1200)}</pre>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* ---------------- approval + execute ---------------- */}
      {challenge && !failure && (
        <section className="mt-6 rounded-lg border border-amber/50 bg-panel p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-[62ch]">
              <p className="x-label">Approve this exact payment</p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                Approving means: sign exactly {challenge.payment.amount} atomic units of {challenge.payment.assetName ?? challenge.payment.asset}
                {" "}on {challenge.payment.network} to {challenge.payment.payTo}, once. Before signing anything, the server re-reads the live
                challenge; if the price or recipient has changed, it refuses with the fresh offer and pays nothing.
              </p>
            </div>
            <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-ink">
              <input type="checkbox" checked={approvalBox} onChange={(e) => setApprovalBox(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-amber)]" />
              <span className="max-w-[36ch]">I approve paying this exact amount for this exact request.</span>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={runExecute} disabled={!approvalBox || executing} className="btn-primary min-w-56 !justify-center">
              {executing ? (
                <><Loader2 size={14} className="animate-spin" aria-hidden /> Executing…</>
              ) : (
                <>Execute — pay {challenge.payment.amount} atomic</>
              )}
            </button>
            <button onClick={() => { setChallenge(null); setPreviewStatus(null); setApprovalBox(false); setStage("compose"); }} className="btn-quiet" disabled={executing}>
              Cancel — pay nothing
            </button>
          </div>
        </section>
      )}

      {/* ---------------- failure ---------------- */}
      {failure && (
        <section className="mt-6 rounded-lg border border-risk/50 bg-panel p-5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-risk"><XCircle size={14} aria-hidden /> {failure.heading}</p>
          <p className="mt-2 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-soft">{failure.detail}</p>
          {failure.node !== null && failure.node !== undefined && <NodeVerdict verdict={failure.node} />}
          <button onClick={() => { setFailure(null); setStage("compose"); }} className="btn-quiet mt-4">Compose again</button>
        </section>
      )}

      {/* ---------------- result ---------------- */}
      {answer && (
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="rounded-lg border border-teal/40 bg-panel p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-teal"><CheckCircle2 size={14} aria-hidden /> Delivered</p>
              {answer.answer.timestamp != null && <span className="tabular text-[10.5px] text-ink-faint">{answer.answer.timestamp}</span>}
            </div>
            <p className="mt-1 text-[11.5px] text-ink-faint">
              Provider: {answer.answer.minerName ?? answer.answer.minerId ?? answer.receipt.miner}
              {answer.answer.endpoint ? ` · ${answer.answer.endpoint}` : ""}
              {answer.answer.durationMs ? ` · ${answer.answer.durationMs} ms` : ""}
              {answer.answer.costUsd != null ? ` · ${answer.answer.costUsd.toFixed(2)} USD` : ""}
            </p>
            <div className="mt-3 max-h-80 overflow-auto rounded-lg border border-edge bg-panel-2 p-3">
              <pre className="font-mono text-[11px] leading-relaxed text-ink">{JSON.stringify(answer.answer.result ?? {}, null, 2).slice(0, 5000)}</pre>
            </div>
            {answer.answer.fieldStatus && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(answer.answer.fieldStatus).map(([field, status]) => (
                  <span key={field} className={`tabular rounded-full px-2 py-0.5 text-[10px] ${status === "ok" ? "bg-teal/10 text-teal" : "bg-risk/10 text-risk"}`}>
                    {field}: {String(status)}
                  </span>
                ))}
              </div>
            )}
            {answer.answer.shapeError && <p className="mt-2 text-[11px] text-amber-deep">The intended shape was not applied (raw result): {answer.answer.shapeError}</p>}
            {answer.answer.warnings != null && <p className="mt-2 text-[11px] text-amber-deep">Warnings: {JSON.stringify(answer.answer.warnings)}</p>}
            <p className="mt-3 text-[11px] text-ink-faint">Delivered is not the same as verified — check the signal in the receipt panel.</p>
          </section>

          <section className="rounded-lg border border-edge bg-panel p-5">
            <p className="x-label">Receipt &amp; verification</p>
            <p className="tabular mt-2 text-[11px] text-ink-faint">receipt {answer.receipt.receipt_hash} · epoch {answer.receipt.epoch_id} · rail {answer.receipt.rail}</p>
            <dl className="mt-3 space-y-1.5 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-ink-faint">Charged</dt>
                <dd className="tabular text-right text-ink">{Number(answer.receipt.amount_uusdc) / 10000} USDC</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-ink-faint">Settlement</dt>
                <dd className="tabular text-right text-ink">{answer.receipt.settlement} ({answer.receipt.chain})</dd>
              </div>
              <div className="flex justify-between items-center gap-3">
                <dt className="shrink-0 text-ink-faint">Transaction</dt>
                <dd className="tabular max-w-[70%] truncate text-right text-ink" title={answer.receipt.tx_hash ?? "batched by the facilitator"}>
                  {answer.receipt.tx_hash ?? "batched — the facilitator groups wallet payments; key on the receipt hash"}
                </dd>
              </div>
              <div className="flex justify-between items-center gap-3">
                <dt className="shrink-0 text-ink-faint">Signal</dt>
                <dd className="tabular max-w-[70%] truncate text-right text-ink" title={answer.signalHash}>{answer.signalHash}</dd>
              </div>
            </dl>
            <button onClick={runVerify} disabled={verifying} className="btn-signal mt-4 w-full !justify-center">
              {verifying ? (
                <><Loader2 size={14} className="animate-spin" aria-hidden /> Checking the signal registry…</>
              ) : (
                <><CheckCircle2 size={14} aria-hidden /> Verify against the network</>
              )}
            </button>
            {verifyStatus && (
              <div className={`mt-3 rounded-lg border p-3 text-[12px] text-ink-soft ${verifyStatus.kind === "verified" ? "border-teal/40 bg-teal/5" : verifyStatus.kind === "recorded" ? "border-amber/40 bg-amber-soft/60" : "border-risk/40 bg-panel-2"}`}>
                <p className="font-semibold text-ink">{verifyStatus.kind === "verified" ? "Confirmed" : verifyStatus.kind === "recorded" ? "Recorded, not confirmed" : "Not verified yet"}</p>
                <p className="mt-1 leading-relaxed">{verifyStatus.note}</p>
              </div>
            )}
            {!verifyStatus && (
              <p className="mt-3 text-[11px] text-ink-faint">
                Verification re-derives the signal hash over the node&apos;s recorded payload. Until it matches, treat the answer as a plain provider claim.
              </p>
            )}
          </section>
        </section>
      )}

      {/* ---------------- log ---------------- */}
      {log.length > 0 && (
        <section className="mt-6 rounded-lg border border-edge bg-panel p-4">
          <p className="x-label">What this terminal did</p>
          <ol className="mt-2 space-y-1">
            {log.map((l, i) => (
              <li key={`${l.ts}-${i}`} className={`tabular text-[10.5px] leading-relaxed ${l.tone === "good" ? "text-teal" : l.tone === "bad" ? "text-risk" : l.tone === "warn" ? "text-amber" : "text-ink-faint"}`}>
                {new Date(l.ts).toLocaleTimeString()} — {l.text}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="mt-8 flex flex-wrap gap-3 text-[12px]">
        <Link href="/intents" className="btn-quiet">All intents</Link>
        <Link href="/miners" className="btn-quiet">All miners</Link>
      </div>
    </div>
  );
}
