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

/** Structured papers when the result looks like an academic search. */
function paperList(result: unknown): { papers: Array<{ title: string; doi?: string }>; total: number | null } | null {
  if (!result || typeof result !== "object") return null;
  const o = result as Record<string, unknown>;
  const titles = Array.isArray(o.paper_titles) ? o.paper_titles.filter((t): t is string => typeof t === "string") : [];
  const dois = Array.isArray(o.dois) ? o.dois.filter((d): d is string => typeof d === "string") : [];
  if (titles.length === 0) return null;
  const total = typeof o.total_matches === "number" ? o.total_matches : null;
  return { papers: titles.map((title, i) => ({ title, doi: dois[i] })), total };
}

/** The answer's own words, when the provider returns a labelled text field.
    Long answers arrive as one string; they read as prose only once split. */
function answerParagraphs(result: unknown): string[] {
  const split = (text: string) =>
    text
      .trim()
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

  if (typeof result === "string") return split(result);
  if (!result || typeof result !== "object") return [];

  const o = result as Record<string, unknown>;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    for (const paragraph of split(value)) {
      if (paragraph.length > 1 && !seen.has(paragraph)) {
        seen.add(paragraph);
        out.push(paragraph);
      }
    }
  };

  for (const key of ["answer", "brief", "summary", "text", "content", "result"]) {
    const v = o[key];
    if (typeof v === "string") push(v);
  }
  if (out.length === 0) {
    const longest = Object.values(o)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 40)
      .sort((a, b) => b.length - a.length)[0];
    if (longest) push(longest);
  }
  return out;
}

/** `ACADEMIC_SEARCH_GENERAL` reads as a database key; the list should read as a choice. */
function humanIntent(raw: string): string {
  const spaced = raw.toLowerCase().replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Chain ids are for machines; a payer needs a name. Unknown ids stay raw. */
function chainName(network: string): string {
  const names: Record<string, string> = {
    "eip155:1": "Ethereum",
    "eip155:8453": "Base",
    "eip155:11155111": "the Ethereum Sepolia testnet",
    "eip155:84532": "the Base Sepolia testnet",
  };
  return names[network] ?? network;
}

/** What the network said, in a sentence; the protocol form stays available. */
function NodeVerdict({ verdict }: { verdict: unknown }) {
  if (verdict == null) return null;
  if (typeof verdict === "string") {
    return <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{verdict}</p>;
  }
  const v = verdict as Record<string, unknown>;
  const problems = Array.isArray(v.problems) ? v.problems : null;
  const code = typeof v.error === "string" ? v.error : null;
  const plain = plainRefusal(code, typeof v.message === "string" ? v.message : null);
  return (
    <div className="mt-2 space-y-2">
      {plain && <p className="text-[13px] leading-relaxed text-ink">{plain}</p>}
      {!plain && code && <p className="tabular text-[11.5px] text-risk">{code}</p>}
      {typeof v.message === "string" && v.message !== v.error && !plain && <p className="text-[12px] leading-relaxed text-ink-soft">{v.message}</p>}
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
      <details className="pt-1">
        <summary className="cursor-pointer text-[11px] text-ink-faint transition-colors hover:text-ink-soft">
          Technical details
        </summary>
        <pre className="mt-1.5 overflow-x-auto rounded-lg bg-panel-2 p-2 font-mono text-[10.5px] leading-relaxed text-ink-soft">{JSON.stringify(v, null, 2).slice(0, 1200)}</pre>
      </details>
    </div>
  );
}

/** The network's error codes, said plainly. Unknown codes stay untouched. */
function plainRefusal(code: string | null, message: string | null): string | null {
  if (code === "no_compatible_miner") {
    return "That answer service advertises this kind of question, but the network says its form does not match. Automatic routing picks one that works.";
  }
  if (code === "invalid_request_composition" || (message ? /required/i.test(message) : false)) {
    return null;
  }
  if (code === "unknown_miner" || code === "miner_not_found") {
    return "The network does not know that answer service. Use automatic routing.";
  }
  if (code === "rate_limited") return "The network is rate limiting right now. Try again in a moment.";
  if (code === "unavailable" || code === "service_unavailable") return "The network is temporarily unavailable. Nothing was charged.";
  return null;
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
  /** Advanced JSON and provider pinning are for people who work on the protocol. */
  const [devMode, setDevMode] = useState(false);

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
  /** Our own "fill this in first" message, distinct from a node verdict. */
  const [composeError, setComposeError] = useState<string | null>(null);
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
  // Phase 5b: whether the execute route could durably record this attempt in
  // the activity store. Reported exactly as answered: saved, or NOT saved.
  const [activitySaved, setActivitySaved] = useState<{ id?: string; saved: boolean; detail?: string } | null>(null);
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
          pushLog(`Intent ${humanIntent(selectedIntent)}: not available right now (${body.error ?? res.status}).`, "warn");
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
          // Keep auto-route as the default. Specific miner pinning is advanced and can fail with no_compatible_miner.
          pushLog(`A specific answer service was requested (${initialMiner}). Using automatic routing instead — it falls back if the first choice cannot take this question.`, "info");
        }
        const fields = (body.params ?? []).length;
        pushLog(
          `Intent loaded: ${humanIntent(body.intent)}. ${
            fields === 0 ? "No fields to fill" : `${fields} field${fields === 1 ? "" : "s"} to fill`
          }, ${body.minerCount} answer services available.`,
          "good",
        );
      } catch (err) {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : String(err);
        setIntentDetailError(msg);
        pushLog(`Intent ${humanIntent(selectedIntent)} could not be read: ${msg}`, "bad");
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
      return { body: null, error: "This intent takes no input params. Write the question instead." };
    }
    return { body: { query: queryText.trim() } };
  }, [mode, rawJson, selectedIntent, intentDetail, paramValues, queryText]);

  /* ---- preview ------------------------------------------------------ */

  const runPreview = useCallback(async (minerOverride?: string | null) => {
    const activeMiner = minerOverride === undefined ? minerId : minerOverride;
    const spec = buildSpec();
    if (spec.error) {
      // The node was never called: this is our own completeness check. Saying
      // "the node refused" here blamed the network for a form we never filled
      // in, and read like a payment decision the node had made.
      setPreviewStatus(null);
      setPreviewHttp(null);
      setNodeVerdict(null);
      setComposeError(spec.error);
      pushLog(`Nothing was sent: ${spec.error}`, "warn");
      return;
    }
    setComposeError(null);
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
      if (activeMiner) payload.miner = activeMiner;
      pushLog(`Checking with the network. No payment is made by this step.`, "info");
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
        pushLog(`Price: $${(p.amountUsdCents / 100).toFixed(2)} in ${p.assetName ?? "USD Coin"} on ${chainName(p.network)}. Nothing is signed until you approve.`, "good");
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
    /* No answer is also an answer: stop waiting instead of holding the UI on
       "Executing…" until the platform kills the function. */
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 70_000);
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
        signal: controller.signal,
      });
      const body = (await res.json()) as Record<string, unknown>;
      setActivitySaved((body.activity as { id?: string; saved: boolean; detail?: string } | undefined) ?? null);
      if (body.status === "answered") {
        setAnswer({
          answer: body.answer as AnswerInfo,
          signalHash: body.signalHash as string,
          receipt: body.receipt as ReceiptInfo,
          settlement: (body.settlement as string | null) ?? null,
        });
        setChallenge(null);
        setStage("result");
        pushLog("Answer delivered with a receipt. Run verification before trusting it.", "good");
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
      const aborted = err instanceof DOMException && err.name === "AbortError";
      const msg = aborted
        ? "No answer came back within 70 seconds. The payment may already have settled — check Activity before trying again."
        : err instanceof Error
          ? err.message
          : String(err);
      setFailure({ heading: aborted ? "Timed out — settlement unknown" : "Execution failed", detail: msg });
      pushLog(`${aborted ? "Timed out" : "Execution failed"}: ${msg}`, "bad");
    } finally {
      clearTimeout(deadline);
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

  // The button is only offered when the body is actually complete: a required
  // parameter that the node will reject should never look like a payable ask.
  const composed = useMemo(() => buildSpec(), [buildSpec]);
  const canPreview = composed.body !== null;
  const composeProblem =
    composed.body === null && composed.error && (selectedIntent !== null || rawJson.trim().length > 0)
      ? composed.error
      : null;
  // The network's way of saying "this provider's form does not take this question".
  const isNoCompatibleMiner = JSON.stringify(nodeVerdict ?? "").includes("no_compatible_miner");

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="x-tag">ASK A QUESTION · PAY PER ANSWER</p>
          <h1 className="x-display-1 mt-3 text-ink">Ask the network</h1>
          <p className="mt-3 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-soft">
            Choose what kind of answer you need, write your question, and see the price before anything is charged.
            You approve one payment, then get the answer with its receipt.
          </p>
        </div>
        {devMode && (
          <div className="rounded-lg border border-edge bg-panel px-4 py-3">
            <p className="x-label">Payment wallet</p>
            <p className="tabular mt-1 text-[11.5px] text-ink">
              {wallet.configured && wallet.address
                ? `${wallet.address}`
                : "Not configured. Previews still run; execution cannot sign."}
            </p>
          </div>
        )}
      </div>

      <ol className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-faint">
        {([["compose", "Write"], ["preview", "Price"], ["executing", "Pay"], ["result", "Answer"]] as const).map(([s, label], i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={`tabular rounded-full px-2 py-0.5 ${stage === s ? "bg-amber-soft text-amber-deep" : stage === "result" && s === "result" ? "text-teal" : ""}`}>
              {i + 1}. {label}
            </span>
            {i < 3 && <ChevronRight size={12} aria-hidden />}
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ---------------- compose ---------------- */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="x-label">Your question</p>
            <button
              type="button"
              aria-pressed={devMode}
              onClick={() => {
                const next = !devMode;
                setDevMode(next);
                if (!next) {
                  setMode("guided");
                  setMinerId(null);
                }
                setPreviewStatus(null);
                setNodeVerdict(null);
                setChallenge(null);
              }}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${devMode ? "border-amber/50 bg-amber-soft text-amber-deep" : "border-edge text-ink-faint hover:text-ink-soft"}`}
            >
              Developer mode
            </button>
          </div>

          {devMode && (
            <div className="mt-3 flex rounded-lg border border-edge p-0.5" role="tablist" aria-label="Request mode">
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
                  className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-all ${mode === m ? "bg-panel text-ink shadow-[0_1px_2px_rgba(22,24,29,0.10)] ring-1 ring-edge" : "text-ink-faint hover:text-ink-soft"}`}
                >
                  {m === "guided" ? "Guided" : "Advanced JSON"}
                </button>
              ))}
            </div>
          )}

          {mode === "guided" ? (
            <div className="mt-4 space-y-4">
              <div>
                <p className="x-label">1 · Kind of answer</p>
                {selectedIntent ? (
                  <p className="mt-2 text-[12px] text-ink-soft">
                    Selected: <span className="text-ink">{humanIntent(selectedIntent)}</span>{" "}
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
                        <li className="px-3 py-3 text-[12px] text-ink-faint">No intent matches.</li>
                      ) : (
                        filteredIntents.slice(0, 80).map((i) => (
                          <li key={i.intent}>
                            <button onClick={() => setSelectedIntent(i.intent)} className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-panel-3">
                              <span className="text-[12.5px] text-ink">{humanIntent(i.intent)}</span>
                              <span className="shrink-0 text-[10.5px] text-ink-faint">{i.minerCount} services</span>
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
                    <p className="x-label">2 · Your question{intentDetail.params.length === 0 ? " (plain language)" : ""}</p>
                    {intentDetail.params.length > 0 ? (
                      <div className="mt-2 space-y-3">
                        {intentDetail.params.map((p) => (
                          <label key={p.name} className="block">
                            <span className="text-[11.5px] font-medium text-ink">
                              {humanIntent(p.name)}
                              <span className="ml-1.5 font-normal text-ink-faint">{p.required ? "required" : "optional"}</span>
                            </span>
                            {p.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{p.description}</span>}
                            <input
                              value={paramValues[p.name] ?? ""}
                              onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))}
                              placeholder={`Enter ${p.name.replaceAll("_", " ")}`}
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
                    <p className="x-label">3 · {devMode ? "Answer service" : "Answered by"}</p>
                    {!devMode && (
                      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">
                        Automatic routing. The network picks an answer service that can take this question, and falls
                        back if its first choice is down.
                      </p>
                    )}
                    <div className={devMode ? "mt-2 space-y-1.5" : "hidden"}>
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[12px] text-ink-soft transition-colors hover:border-edge-strong">
                        <input type="radio" name="miner" checked={minerId === null} onChange={() => setMinerId(null)} className="mt-0.5 accent-[var(--color-amber)]" />
                        <span>
                          Auto-route: the router picks the miner and falls back if its pick is down.
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
                              pushLog(`Using ${m.name} directly. If it cannot take the question, there is no fallback.`, "info");
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

          <button onClick={() => void runPreview()} disabled={!canPreview} className="btn-primary mt-5 w-full !justify-center">
            See the price <ArrowRight size={14} aria-hidden />
          </button>
          {composeProblem && !canPreview && (
            <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-snug text-ink-soft">
              <AlertTriangle size={13} className="mt-px shrink-0 text-amber" aria-hidden />
              <span>
                <span className="font-medium text-ink">Fill this in before previewing.</span> {composeProblem}
              </span>
            </p>
          )}
          {!wallet.configured && (
            <p className="mt-3 text-[11.5px] text-amber">Without a payer wallet configured on this deployment, previews still validate, but execution cannot sign.</p>
          )}
        </section>

        {/* ---------------- verdict / price ---------------- */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">What the network said</p>

          {previewStatus === null && !failure && (
            <div className="mt-4 rounded-lg border border-dashed border-edge bg-panel-2 p-6 text-[12.5px] leading-relaxed text-ink-faint">
              Write your question and see the price. The check is free: the network confirms it can answer before any
              payment exists, and you approve the exact amount afterwards.
            </div>
          )}

          {composeError && !canPreview && !failure && (
            <div className="mt-4 rounded-lg border border-edge-strong bg-panel-2 p-4">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                <AlertTriangle size={13} aria-hidden className="text-amber" /> Complete the request first
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{composeError}</p>
              <p className="mt-1.5 text-[11.5px] text-ink-faint">Nothing was sent to the node and nothing can be charged.</p>
            </div>
          )}

          {previewStatus === "refused" && !failure && (
            <div className="mt-4 rounded-lg border border-edge-strong bg-panel-2 p-4">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                <XCircle size={13} aria-hidden className="text-risk" /> That request did not go through
              </p>
              <NodeVerdict verdict={nodeVerdict} />
              {isNoCompatibleMiner && (
                <button
                  onClick={() => {
                    setMinerId(null);
                    void runPreview(null);
                  }}
                  className="btn-primary mt-3 !min-h-9 !text-[12.5px]"
                >
                  Try automatic routing <ArrowRight size={12} aria-hidden />
                </button>
              )}
              <p className="mt-3 text-[11.5px] text-ink-faint">Nothing was charged.</p>
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
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-teal">
                <TerminalIcon size={13} aria-hidden /> Price for this question
              </p>
              <p className="tabular mt-3 text-[28px] font-semibold leading-none text-ink">
                ${(challenge.payment.amountUsdCents / 100).toFixed(2)}
              </p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                Paid once in {challenge.payment.assetName ?? "USDC"} on {chainName(challenge.payment.network)}. Nothing is
                charged until you approve this exact amount.
              </p>

              <details open={devMode} className="mt-4 border-t border-edge pt-3">
                <summary className="cursor-pointer text-[11.5px] text-ink-faint transition-colors hover:text-ink-soft">
                  Payment details
                </summary>
              <dl className="mt-3 space-y-1.5 text-[12px]">
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Amount</dt>
                  <dd className="tabular text-right text-ink">
                    {challenge.payment.amount} atomic
                    <span className="block text-[10.5px] text-ink-soft">{(Number(challenge.payment.amount) / 1_000_000).toFixed(2)} USDC (${(challenge.payment.amountUsdCents / 100).toFixed(2)})</span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Token</dt>
                  <dd className="tabular max-w-[70%] break-all text-right text-ink" title={challenge.payment.asset}>
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
                  <dd className="tabular max-w-[70%] break-all text-right text-ink" title={challenge.payment.payTo}>{challenge.payment.payTo}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">Payer</dt>
                  <dd className="tabular max-w-[70%] break-all text-right text-ink" title={wallet.address ?? ""}>
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
              </details>

              {devMode && bodyPlan && (
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
              <p className="x-label">Approve the payment</p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                One payment for one answer. The price is checked again at the moment of signing; if it has changed, the
                payment is refused and you are charged nothing.
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
                <>Pay ${(challenge.payment.amountUsdCents / 100).toFixed(2)} and send</>
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
          <button onClick={() => { setFailure(null); setStage("compose"); }} className="btn-quiet mt-4">Start again</button>
        </section>
      )}

      {/* ---------------- activity record status (Phase 5b) ---------------- */}
      {activitySaved && (
        <p className="mt-4 max-w-[74ch] text-[12px] leading-relaxed">
          {activitySaved.saved && activitySaved.id ? (
            <>
              <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-teal align-middle" />
              This attempt is recorded as durable activity:{" "}
              <Link href={`/activity/${activitySaved.id}`} className="text-amber underline offset-2 hover:underline">
                open it in the Activity centre
              </Link>
              .
            </>
          ) : (
            <>
              <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-risk align-middle" />
              This attempt could <strong className="text-ink">not</strong> be saved to the activity store
              {activitySaved.detail ? ` (${activitySaved.detail})` : ""}. It stays visible in this session only — it is recorded nowhere else.
            </>
          )}
        </p>
      )}

      {/* ---------------- result ---------------- */}
      {answer && (
        <>
          <div className="mt-6 rounded-lg border border-teal/30 bg-teal/5 p-4">
            <p className="text-[12.5px] font-medium text-teal">What just happened</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
              Paid {(Number(answer.receipt.amount_uusdc) / 1_000_000).toFixed(2)} USDC to {answer.answer.minerName ?? answer.receipt.miner}. 
              Receipt {answer.receipt.receipt_hash.slice(0, 10)}… recorded. Signal {answer.signalHash.slice(0, 10)}… ready to verify.
            </p>
          </div>
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
            <div className="mt-4 border-t border-edge pt-4">
            {answerParagraphs(answer.answer.result).map((p, i) => (
              <p key={i} className="mt-3 text-[14.5px] leading-[1.65] text-pretty text-ink first:mt-0">{p}</p>
            ))}
            {(() => {
              const parsed = paperList(answer.answer.result);
              if (!parsed) return null;
              return (
                <div className="mt-4">
                  {parsed.total != null && (
                    <p className="mb-2 text-[11.5px] text-ink-faint">{parsed.total.toLocaleString()} matches · showing {parsed.papers.length}</p>
                  )}
                  <ul className="space-y-2.5">
                    {parsed.papers.map((p, i) => (
                      <li key={i} className="rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
                        <p className="text-[13px] leading-snug text-ink">{p.title}</p>
                        {p.doi && (
                          <a
                            href={`https://doi.org/${p.doi}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block text-[11.5px] text-teal underline decoration-teal/30 underline-offset-2 hover:text-teal"
                          >
                            Open on DOI · {p.doi}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-[11.5px] text-ink-faint transition-colors hover:text-ink-soft">
                Technical details
              </summary>
              <div className="mt-2 space-y-2">
                {answer.answer.fieldStatus && (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(answer.answer.fieldStatus).map(([field, status]) => (
                      <span key={field} className={`tabular rounded-full px-2 py-0.5 text-[10px] ${status === "ok" ? "bg-teal/10 text-teal" : "bg-risk/10 text-risk"}`}>
                        {field}: {String(status)}
                      </span>
                    ))}
                  </div>
                )}
                <div className="max-h-80 overflow-auto rounded-lg border border-edge bg-panel-2 p-3">
                  <pre className="font-mono text-[11px] leading-relaxed text-ink">{JSON.stringify(answer.answer.result ?? {}, null, 2).slice(0, 5000)}</pre>
                </div>
              </div>
            </details>
            {answer.answer.shapeError && <p className="mt-2 text-[11px] text-amber-deep">The intended shape was not applied (raw result): {answer.answer.shapeError}</p>}
            {answer.answer.warnings != null && <p className="mt-2 text-[11px] text-amber-deep">Warnings: {JSON.stringify(answer.answer.warnings)}</p>}
            <p className="mt-3 text-[11px] text-ink-faint">Delivery is not verification. Check the signal in the receipt panel.</p>
          </section>

          <section className="rounded-lg border border-edge bg-panel p-5">
            <p className="x-label">Receipt &amp; verification</p>
            <p className="tabular mt-2 break-all text-[11px] text-ink-faint">receipt {answer.receipt.receipt_hash} · epoch {answer.receipt.epoch_id} · rail {answer.receipt.rail}</p>
            <dl className="mt-3 space-y-1.5 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-ink-faint">Charged</dt>
                <dd className="tabular text-right text-ink">{(Number(answer.receipt.amount_uusdc) / 1_000_000).toFixed(2)} USDC</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-ink-faint">Settlement</dt>
                <dd className="tabular text-right text-ink">{answer.receipt.settlement} ({answer.receipt.chain})</dd>
              </div>
              <div className="flex justify-between items-center gap-3">
                <dt className="shrink-0 text-ink-faint">Transaction</dt>
                <dd className="tabular max-w-[70%] break-all text-right text-ink" title={answer.receipt.tx_hash ?? "batched by the facilitator"}>
                  {answer.receipt.tx_hash ?? "batched by the facilitator; key settlements on the receipt hash"}
                </dd>
              </div>
              <div className="flex justify-between items-center gap-3">
                <dt className="shrink-0 text-ink-faint">Signal</dt>
                <dd className="tabular max-w-[70%] break-all text-right text-ink" title={answer.signalHash}>{answer.signalHash}</dd>
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
        </>
      )}

      {/* ---------------- activity record status (Phase 5b) ---------------- */}
      {activitySaved && (
        <p className="mt-4 max-w-[74ch] text-[12px] leading-relaxed">
          {activitySaved.saved && activitySaved.id ? (
            <>
              <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-teal align-middle" />
              Saved to the Activity centre as a durable record with its receipt and signal:{" "}
              <Link href={`/activity/${activitySaved.id}`} className="text-amber underline offset-2 hover:underline">
                /activity/ record
              </Link>
              .
            </>
          ) : (
            <>
              <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-risk align-middle" />
              This attempt could <strong className="text-ink">not</strong> be saved to the activity store
              {activitySaved.detail ? ` (${activitySaved.detail})` : ""}. It stays visible in this session only — it is recorded nowhere else.
            </>
          )}
        </p>
      )}

      {/* ---------------- log ---------------- */}
      {log.length > 0 && (
        <section className="mt-6 rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">What happened</p>
          <ol className="mt-4 space-y-3.5">
            {log.map((l, i) => (
              <li key={`${l.ts}-${i}`} className="flex gap-3">
                <span
                  aria-hidden
                  className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${
                    l.tone === "good"
                      ? "bg-teal"
                      : l.tone === "bad"
                        ? "bg-risk"
                        : l.tone === "warn"
                          ? "bg-amber"
                          : "bg-edge-strong"
                  }`}
                />
                <div className="min-w-0">
                  <p className="text-[12.5px] leading-relaxed text-ink-soft">{l.text}</p>
                  <p className="tabular mt-0.5 text-[10px] text-ink-faint">
                    {new Date(l.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </p>
                </div>
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
