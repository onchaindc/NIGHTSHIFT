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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, Loader2, Search, Terminal as TerminalIcon, XCircle } from "lucide-react";
import { useWallets, useSignTypedData, useSignMessage, useSendTransaction } from "@privy-io/react-auth";
import { encodeFunctionData } from "viem";

import { ResultView } from "@/components/result-view";

export interface TerminalIntentSummary {
  intent: string;
  minerCount: number;
  description: string;
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

const ESCROW_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const ESCROW_DEPOSIT_UUSDC = 100_000n; // 0.10 test USDC: ten $0.01 asks
const ESCROW_DEPOSIT_ABI = [
  { type: "function", name: "depositUSDC", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;
const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/**
 * Spendable escrow, from the node's own ledger. The chain holds deposits, but
 * only the node joins them with what was already billed, so `available` — not
 * a raw on-chain view — decides whether the next ask can be paid.
 */
async function escrowAvailable(nodeUrl: string, address: string): Promise<bigint | null> {
  try {
    const res = await fetch(`${nodeUrl}/v1/ledger/account/${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { available?: unknown };
    return typeof body.available === "string" && /^\d+$/.test(body.available) ? BigInt(body.available) : null;
  } catch {
    return null;
  }
}

async function waitForTransaction(hash: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      const res = await fetch(ESCROW_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
      });
      const body = (await res.json()) as { result?: { status?: string } | null };
      if (body.result?.status === "0x1") return;
      if (body.result?.status === "0x0") throw new Error("The escrow transaction reverted.");
    } catch (err) {
      if (err instanceof Error && /reverted/i.test(err.message)) throw err;
    }
  }
  throw new Error("The escrow transaction is still pending. Wait a moment, then try paying again.");
}

function escrowMessage(
  template: string,
  from: string,
  nonce: string,
  validAfter: string,
  validBefore: string,
): string {
  return template
    .replaceAll("{from}", from.toLowerCase())
    .replaceAll("{nonce}", nonce)
    .replaceAll("{validAfter}", validAfter)
    .replaceAll("{validBefore}", validBefore);
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
  initialIntent,
  initialMiner,
  nodeUrl,
}: {
  intents: TerminalIntentSummary[];
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
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();
  // The in-app wallet is the smooth path; a connected external wallet signs too.
  const signerWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;
  const [fundingEscrow, setFundingEscrow] = useState(false);
  const [escrowNotice, setEscrowNotice] = useState<string | null>(null);

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

  // The flow is one long page on phones. Keep a handle on each meaningful
  // destination so a state change can bring the next action into view instead
  // of making the person hunt for it below the fold.
  const composeRef = useRef<HTMLElement>(null);
  const priceRef = useRef<HTMLElement>(null);
  const payRef = useRef<HTMLElement>(null);
  const executingRef = useRef<HTMLElement>(null);
  const failureRef = useRef<HTMLElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const scrollToTarget = useCallback((target: HTMLElement | null) => {
    if (!target || typeof window === "undefined") return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, []);

  const resetToCompose = useCallback(
    (clearAttempt = false) => {
      setStage("compose");
      setChallenge(null);
      setApprovedOffer(null);
      setApprovalBox(false);
      setPreviewStatus(null);
      setNodeVerdict(null);
      setPreviewHttp(null);
      setComposeError(null);
      setFailure(null);
      setBodyPlan(null);
      setEscrowNotice(null);
      if (clearAttempt) {
        setAnswer(null);
        setActivitySaved(null);
        setVerifyStatus(null);
      }
      window.requestAnimationFrame(() => scrollToTarget(composeRef.current));
    },
    [scrollToTarget],
  );

  const pushLog = useCallback((text: string, tone: "info" | "warn" | "bad" | "good" = "info") => {
    setLog((l) => {
      // Execution can retry the same hand-off; keep one copy of adjacent
      // duplicates without hiding a later, different step.
      const last = l[l.length - 1];
      if (last && last.text === text && last.tone === tone) {
        return [...l.slice(0, -1), { ...last, ts: Date.now() }];
      }
      return [...l.slice(-40), { ts: Date.now(), text, tone }];
    });
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
        if (initialMiner) {
          const match = (body.miners ?? []).find((m) => m.slug === initialMiner || m.minerId === initialMiner);
          if (match) {
            setMinerId(match.minerId);
            pushLog(`Pinned to ${match.name} (${initialMiner}). Automatic routing is still available if this service cannot take the question.`, "info");
          } else {
            pushLog(`Requested service ${initialMiner} is not listed for this question, so automatic routing is active instead.`, "warn");
          }
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

  // Move the person with the flow: price → approval → processing → answer.
  useEffect(() => {
    if (failure) {
      scrollToTarget(failureRef.current);
      return;
    }
    if (answer) {
      scrollToTarget(resultRef.current);
      return;
    }
    if (stage === "executing") {
      scrollToTarget(executingRef.current);
      return;
    }
    if (challenge) {
      scrollToTarget(payRef.current);
      return;
    }
    if (stage === "preview" && previewStatus === null) {
      scrollToTarget(priceRef.current);
      return;
    }
    if (previewStatus === "refused" || previewStatus === "unavailable") {
      scrollToTarget(priceRef.current);
    }
  }, [answer, challenge, failure, previewStatus, scrollToTarget, stage]);

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
    setActivitySaved(null);
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
    if (!signerWallet) {
      setApprovalBox(false);
      setFailure({
        heading: "Connect a wallet to pay",
        detail: "This terminal pays from your wallet, never from the server. Open Wallet to create the free in-app wallet or connect one, then approve this same offer again.",
      });
      setStage("preview");
      return;
    }
    // Keep the approval after a failed attempt: the offer is unchanged and
    // re-checked for drift before signing, so the person can retry directly.
    setFailure(null);
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

      // Sign with Privy in-app wallet (the one with Telegraph USDC).
      if (signerWallet && challenge) {
        try {
          const urlPath = minerId ? `/engine/v1/ask/${encodeURIComponent(minerId)}` : "/engine/v1/ask";
          const chRes = await fetch("/api/terminal/challenge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urlPath, body: payload }),
            signal: controller.signal,
          });
          const ch = await chRes.json();
          if (!ch.offer) {
            setFailure({ heading: "Could not get payment challenge", detail: ch.error ?? "unknown" });
            return;
          }
          // Never sign a challenge that changed after the user approved it.
          const drift = (["scheme", "network", "asset", "payTo", "amount"] as const).find(
            (key) => String(ch.offer[key] ?? "").toLowerCase() !== String(approvedOffer[key] ?? "").toLowerCase(),
          );
          if (drift) {
            setFailure({
              heading: "The offer changed — nothing was signed",
              detail: `The live offer no longer matches the one you approved (${drift} changed). Review the new price before paying.`,
            });
            return;
          }
          let payment: string;
          let paymentHeaderName: "PAYMENT-SIGNATURE" | "X-PAYMENT" = "PAYMENT-SIGNATURE";
          if (ch.escrow) {
            // Escrow signs a human-readable authorization, not an EIP-3009
            // transfer. The node reads it from X-PAYMENT, not the exact rail's
            // PAYMENT-SIGNATURE header.
            const escrow = ch.escrow as { network: string; payTo: string; amount: string; message: string };
            const now = Math.floor(Date.now() / 1000);
            const nonce = crypto.randomUUID();
            const validAfter = String(now - 5);
            const validBefore = String(now + 100);
            const authorization = {
              from: signerWallet.address.toLowerCase(),
              to: escrow.payTo,
              value: escrow.amount,
              validAfter,
              validBefore,
              nonce,
            };
            const message = escrowMessage(escrow.message, authorization.from, nonce, validAfter, validBefore);
            const { signature } = await signMessage(
              { message },
              { address: signerWallet.address, uiOptions: { showWalletUIs: false } },
            );
            payment = btoa(JSON.stringify({
              x402Version: 2,
              scheme: "escrow",
              network: escrow.network,
              payload: { signature, authorization },
            }));
            paymentHeaderName = "X-PAYMENT";
          } else {
            if (!ch.typedData) {
              setFailure({ heading: "Could not get payment challenge", detail: "The exact payment typed data is missing." });
              return;
            }
            ch.typedData.message.from = signerWallet.address;
            const { signature } = await signTypedData(ch.typedData, {
              address: signerWallet.address,
              uiOptions: { showWalletUIs: false },
            });
            const accepted = ch.challenge?.accepts?.find((a: { scheme?: string; network?: string }) =>
              a.scheme === "exact" && a.network === ch.offer.network
            );
            payment = btoa(JSON.stringify({
              x402Version: 2,
              payload: {
                signature,
                authorization: {
                  from: signerWallet.address,
                  to: ch.typedData.message.to,
                  value: ch.typedData.message.value,
                  validAfter: ch.typedData.message.validAfter,
                  validBefore: ch.typedData.message.validBefore,
                  nonce: ch.typedData.message.nonce,
                },
              },
              resource: ch.challenge?.resource,
              accepted,
            }));
          }
          const done = await fetch("/api/terminal/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              urlPath,
              body: payload,
              paymentHeader: payment,
              paymentHeaderName,
              payer: signerWallet.address,
            }),
            signal: controller.signal,
          });
          const result = await done.json();
          setActivitySaved(result.activity ?? null);
          const signalHash = typeof result.body?.signal_hash === "string" ? result.body.signal_hash : null;
          if (result.status === 200 && signalHash) {
            const nodeBody =
              result.body && typeof result.body === "object"
                ? (result.body as Record<string, unknown>)
                : null;
            // The envelope holds the miner's payload under `result`; showing the
            // envelope itself is how node-level prose used to masquerade as the answer.
            const minerResult = nodeBody && "result" in nodeBody ? nodeBody.result : result.body;
            setAnswer({
              answer: {
                result: minerResult,
                minerName: typeof nodeBody?.miner_name === "string" ? nodeBody.miner_name : undefined,
                minerId: typeof nodeBody?.miner_id === "string" ? nodeBody.miner_id : undefined,
              },
              signalHash,
              receipt: {
                receipt_hash: result.receipt ?? "",
                rail: challenge.payment.scheme === "escrow" ? "escrow" : "x402",
                payer: signerWallet.address,
                miner: challenge.payment.payTo,
                intent: "",
                amount_uusdc: challenge.payment.amount,
                epoch_id: 0,
                settlement: result.paymentResponse ?? "",
                chain: challenge.payment.network,
                timestamp: Date.now(),
              },
              settlement: result.paymentResponse,
            });
            setChallenge(null);
            setStage("result");
            pushLog("Answer delivered from your wallet. Run verification before trusting it.", "good");
            return;
          }
          setFailure({ heading: "Payment from your wallet failed", detail: result.error ?? JSON.stringify(result.body ?? result).slice(0, 300) });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setFailure({ heading: "Payment from your wallet failed", detail: msg.slice(0, 300) });
          return;
        }
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
  }, [challenge, approvedOffer, mode, rawJson, minerId, buildSpec, pushLog, signerWallet, signMessage, signTypedData]);

  const handleFundEscrow = useCallback(async () => {
    if (!challenge || challenge.payment.scheme !== "escrow" || !signerWallet) return;
    setFundingEscrow(true);
    setEscrowNotice(null);
    try {
      const required = BigInt(challenge.payment.amount);
      // The node's ledger is what decides spendability: it joins the on-chain
      // deposit with anything already billed. A deposit that the node cannot
      // see is not "funded", and saying so is what stranded this flow before.
      const current = await escrowAvailable(nodeUrl, signerWallet.address);
      if (current !== null && current >= required) {
        setEscrowNotice("Your escrow already covers this ask — paying it now.");
        pushLog("Escrow already covers this ask. Signing the payment…", "info");
        void runExecute();
        return;
      }

      const chainId = Number(challenge.payment.network.replace(/^eip155:/, ""));
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("The escrow offer has no usable EVM chain.");
      const depositAmount = ESCROW_DEPOSIT_UUSDC > required ? ESCROW_DEPOSIT_UUSDC : required;

      pushLog("Approving Telegraph USDC for the escrow contract…", "info");
      const approveData = encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [challenge.payment.payTo as `0x${string}`, depositAmount],
      });
      const approved = await sendTransaction(
        { to: challenge.payment.asset as `0x${string}`, data: approveData, chainId },
        { address: signerWallet.address },
      );
      await waitForTransaction(approved.hash);

      pushLog("Depositing test USDC into Telegraph escrow…", "info");
      const depositData = encodeFunctionData({
        abi: ESCROW_DEPOSIT_ABI,
        functionName: "depositUSDC",
        args: [depositAmount],
      });
      const deposited = await sendTransaction(
        { to: challenge.payment.payTo as `0x${string}`, data: depositData, chainId },
        { address: signerWallet.address },
      );
      await waitForTransaction(deposited.hash);

      const after = await escrowAvailable(nodeUrl, signerWallet.address);
      if (after !== null && after < required) {
        setEscrowNotice(
          `Deposit sent, but the node still reports ${Number(after) / 1_000_000} test USDC spendable — not enough for this ask.`,
        );
        pushLog("The deposit is mined, but the node's ledger does not cover this ask yet.", "warn");
        return;
      }
      setEscrowNotice(`Escrow funded with ${Number(after ?? depositAmount) / 1_000_000} test USDC. Paying this ask now…`);
      pushLog("Escrow funded. Signing the payment for this ask…", "good");
      // Funding was the last consent step, and the offer being paid is the one
      // already approved — runExecute re-checks it for drift before signing.
      void runExecute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEscrowNotice(`Escrow funding failed: ${msg.slice(0, 240)}`);
      pushLog(`Escrow funding failed: ${msg}`, "bad");
    } finally {
      setFundingEscrow(false);
    }
  }, [challenge, signerWallet, sendTransaction, pushLog, nodeUrl, runExecute]);

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
  const questionSummary = useMemo(() => {
    if (mode === "advanced") return rawJson.trim() ? "Advanced JSON request" : "Your question";
    const parts: string[] = [];
    if (selectedIntent) parts.push(humanIntent(selectedIntent));
    for (const [key, value] of Object.entries(paramValues)) {
      const trimmed = value.trim();
      if (trimmed) parts.push(`${humanIntent(key)}: ${trimmed}`);
    }
    if (queryText.trim()) parts.push(queryText.trim());
    return parts.join(" · ") || "Your question";
  }, [mode, paramValues, queryText, rawJson, selectedIntent]);
  const previewLoading = stage === "preview" && previewStatus === null;
  const escrowTopUpUsdc = challenge ? Math.max(0.1, Number(challenge.payment.amount) / 1_000_000) : 0.1;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 pb-32 sm:px-6 sm:pb-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="x-tag">ASK A QUESTION · PAY PER ANSWER</p>
          <h1 className="x-display-1 mt-3 text-ink">Ask the network</h1>
          <p className="mt-3 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-soft">
            Choose what kind of answer you need, write your question, and see the price before anything is charged.
            You approve one payment, then get the answer with its receipt.
          </p>
        </div>

      </div>

      <ol className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-edge bg-panel/60 px-3 py-2 text-[11.5px] text-ink-faint">
        {([["compose", "Write"], ["preview", "Price"], ["executing", "Pay"], ["result", "Answer"]] as const).map(([s, label], i) => {
          const active = stage === s;
          const done = ["compose", "preview", "executing", "result"].indexOf(stage) > i;
          return (
            <li key={s} className="flex items-center gap-2">
              <span
                aria-current={active ? "step" : undefined}
                className={`tabular rounded-full px-2 py-0.5 ${active ? "bg-amber-soft text-amber-deep" : done ? "text-teal" : ""}`}
              >
                {i + 1}. {label}
              </span>
              {i < 3 && <ChevronRight size={12} aria-hidden />}
            </li>
          );
        })}
      </ol>

      {!answer && !failure && stage !== "executing" && (
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ---------------- compose ---------------- */}
        <section
          ref={composeRef}
          className={`scroll-mt-24 rounded-lg border border-edge bg-panel p-5 ${stage === "compose" ? "" : "hidden"}`}
        >
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
          {!signerWallet && (
            <p className="mt-3 text-[11.5px] leading-relaxed text-amber">
              Previewing is free. To pay, {" "}
              <Link href="/funds" className="underline offset-2 hover:no-underline">open Wallet</Link>{" "}
              and create the in-app wallet (or connect one).
            </p>
          )}
        </section>

        {/* ---------------- verdict / price ---------------- */}
        {!answer && (
        <section ref={priceRef} className="scroll-mt-24 rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">{challenge ? "Your price" : "What the network said"}</p>

          {stage === "compose" && previewStatus === null && !failure && (
            <div className="mt-4 rounded-lg border border-dashed border-edge bg-panel-2 p-6 text-[12.5px] leading-relaxed text-ink-faint">
              Write your question and see the price. The check is free: the network confirms it can answer before any
              payment exists, and you approve the exact amount afterwards.
            </div>
          )}

          {stage === "preview" && previewStatus === null && !failure && (
            <div aria-live="polite" className="mt-4 flex items-start gap-2.5 rounded-lg border border-edge bg-panel-2 p-4">
              <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-teal" aria-hidden />
              <div>
                <p className="text-[13px] font-medium text-ink">Checking the network for a price</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                  This check is free. No payment is made until you approve the exact offer.
                </p>
              </div>
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
              {minerId !== null && (
                <div className="mt-3 rounded-lg border border-amber/30 bg-amber-soft/50 px-3 py-2.5">
                  <p className="text-[12px] leading-relaxed text-ink-soft">
                    This preview was pinned to <span className="font-medium text-ink">{minerId}</span>. A direct ask
                    has no fallback, so the same question can fail even when other services can answer it.
                  </p>
                  <button
                    onClick={() => {
                      setMinerId(null);
                      void runPreview(null);
                    }}
                    className="btn-primary mt-2.5 !min-h-9 !text-[12.5px]"
                  >
                    Try automatic routing <ArrowRight size={12} aria-hidden />
                  </button>
                </div>
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
                  <dd className="tabular max-w-[70%] break-all text-right text-ink" title={signerWallet?.address ?? ""}>
                    {signerWallet?.address ?? "not connected"}
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
        )}

        {stage !== "compose" && (
          <section className="order-first scroll-mt-24 rounded-lg border border-edge bg-panel p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="x-label">Your question</p>
                <p className="mt-2 line-clamp-2 text-[14px] font-medium leading-relaxed text-ink">
                  {questionSummary}
                </p>
                <p className="mt-1 text-[11.5px] text-ink-faint">
                  {minerId ? `Pinned to ${minerId}` : "Automatic routing"}
                  {" · "}
                  {previewLoading
                    ? "Checking the network for a price…"
                    : previewStatus === "challenge"
                      ? "Review and approve the price"
                      : "Nothing has been charged"}
                </p>
              </div>
              <button
                type="button"
                disabled={previewLoading}
                onClick={() => resetToCompose(false)}
                className={`btn-quiet shrink-0 !min-h-8 !px-3 !text-[11.5px] ${previewLoading ? "opacity-50" : ""}`}
              >
                Edit
              </button>
            </div>
          </section>
        )}
      </div>
      )}

      {/* ---------------- approval + execute ---------------- */}
      {challenge && !answer && !executing && (
        <section ref={payRef} className="scroll-mt-24 mt-6 rounded-2xl border border-amber/50 bg-panel p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-[62ch]">
              <p className="x-label">Approve the payment</p>
              <p className="mt-2 text-[13px] font-medium leading-relaxed text-ink">
                Pay <span className="tabular text-ink">${(challenge.payment.amountUsdCents / 100).toFixed(2)}</span>{" "}
                in {challenge.payment.assetName ?? "USDC"} on {chainName(challenge.payment.network)}.
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                One payment for one answer. The price is checked again at the moment of signing; if it has changed, the
                payment is refused and you are charged nothing.
              </p>
            </div>
            <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-ink">
              <input type="checkbox" checked={approvalBox} onChange={(e) => setApprovalBox(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-amber)]" />
              <span className="max-w-[36ch]">I approve paying this exact amount for this exact request.</span>
            </label>
          </div>
          {signerWallet && (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Paying from {signerWallet.walletClientType === "privy" ? "your in-app wallet" : "your connected wallet"}{" "}
              <span className="tabular">
                {signerWallet.address.slice(0, 6)}…{signerWallet.address.slice(-4)}
              </span>
            </p>
          )}
          {challenge.payment.scheme === "escrow" && signerWallet && (
            <div className="mt-3 rounded-lg border border-teal/30 bg-teal/5 px-3 py-2.5">
              <p className="text-[11.5px] leading-relaxed text-ink-soft">
                This ask is paid from your <span className="font-medium text-ink">Telegraph escrow</span> balance on{" "}
                {chainName(challenge.payment.network)}. Your existing Telegraph USDC pays for it; if escrow is empty,
                fund it once here.
              </p>
              <button
                type="button"
                onClick={() => void handleFundEscrow()}
                disabled={fundingEscrow}
                className="btn-quiet mt-2 !min-h-8 !px-3 !text-[11.5px]"
              >
                {fundingEscrow ? "Funding escrow…" : `Fund escrow with ${escrowTopUpUsdc.toFixed(2)} test USDC`}
              </button>
              {escrowNotice && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{escrowNotice}</p>}
            </div>
          )}
          {!signerWallet && (
            <p className="mt-3 max-w-[66ch] text-[11.5px] leading-relaxed text-amber">
              Connect a wallet to pay.{" "}
              <Link href="/funds" className="underline offset-2 hover:no-underline">
                Open Wallet
              </Link>{" "}
              to create the free in-app wallet or connect an external one, then approve this offer again.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={runExecute} disabled={!approvalBox || executing || !signerWallet} className="btn-primary min-w-56 !justify-center">
              {executing ? (
                <><Loader2 size={14} className="animate-spin" aria-hidden /> Executing…</>
              ) : (
                <>Pay ${(challenge.payment.amountUsdCents / 100).toFixed(2)} and send</>
              )}
            </button>
            <button onClick={() => resetToCompose(false)} className="btn-quiet" disabled={executing}>
              Cancel — pay nothing
            </button>
          </div>
        </section>
      )}

      {/* ---------------- processing ---------------- */}
      {stage === "executing" && !answer && !failure && (
        <section
          ref={executingRef}
          aria-live="polite"
          className="scroll-mt-24 mt-6 rounded-2xl border border-teal/30 bg-panel p-5 sm:p-6"
        >
          <div className="flex items-center gap-2 text-teal">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            <p className="text-[13px] font-medium">Paying and waiting for the answer</p>
          </div>
          <p className="mt-3 max-w-[68ch] text-[12.5px] leading-relaxed text-ink-soft">
            Your approval is in. The network is processing the paid request, so keep this page open. This can take up to
            70 seconds.
          </p>
          {challenge && (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Paying <span className="tabular">${(challenge.payment.amountUsdCents / 100).toFixed(2)}</span>{" "}
              in {challenge.payment.assetName ?? "USDC"} on {chainName(challenge.payment.network)}.
            </p>
          )}
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
            No answer yet? Check Activity before retrying: a settled payment may still produce a recorded answer.
          </p>
        </section>
      )}

      {/* ---------------- failure ---------------- */}
      {failure && (
        <section ref={failureRef} className="scroll-mt-24 mt-6 rounded-2xl border border-risk/50 bg-panel p-5 sm:p-6">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-risk"><XCircle size={14} aria-hidden /> {failure.heading}</p>
          <p className="mt-2 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-soft">{failure.detail}</p>
          {failure.node !== null && failure.node !== undefined && <NodeVerdict verdict={failure.node} />}
          {/payment/i.test(failure.heading) && (
            <p className="mt-3 text-[12px] leading-relaxed text-ink-soft">
              {challenge?.payment.scheme === "escrow"
                ? "This ask pays from Telegraph escrow. Fund escrow with your existing test USDC, then pay again — no Base Sepolia balance is needed."
                : "A wallet payment is rejected when it has no test USDC for the offered rail. Check the Wallet page, then try the same ask again."}
            </p>
          )}
          {challenge?.payment.scheme === "escrow" && signerWallet && (
            <div className="mt-3 rounded-lg border border-teal/30 bg-teal/5 px-3 py-2.5">
              <button
                type="button"
                onClick={() => void handleFundEscrow()}
                disabled={fundingEscrow}
                className="btn-quiet !min-h-8 !px-3 !text-[11.5px]"
              >
                {fundingEscrow ? "Funding escrow…" : `Fund escrow with ${escrowTopUpUsdc.toFixed(2)} test USDC`}
              </button>
              {escrowNotice && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{escrowNotice}</p>}
            </div>
          )}
          {challenge && signerWallet && (
            <>
              <button
                type="button"
                onClick={() => void runExecute()}
                className="btn-primary mt-3 !min-h-9 !px-4 !text-[12.5px]"
              >
                Try the payment again — ${(challenge.payment.amountUsdCents / 100).toFixed(2)}
              </button>
              <p className="mt-2 max-w-[68ch] text-[11.5px] leading-relaxed text-ink-faint">
                The approved offer is unchanged. Retrying signs a fresh authorization for it, and the price and
                recipient are checked again before anything is signed.
              </p>
            </>
          )}
          <div className="mt-4">
            <button onClick={() => resetToCompose(true)} className="btn-quiet">Start again</button>
          </div>
        </section>
      )}

      {/* ---------------- result ---------------- */}
      {answer && (
        <div ref={resultRef} className="scroll-mt-24 mt-6 space-y-4">
          {/* Main answer — the spotlight */}
          <section aria-live="polite" className="rounded-2xl border border-teal/30 bg-panel p-5 sm:p-6">
            <div className="flex items-center gap-2 text-teal">
              <CheckCircle2 size={16} />
              <span className="text-[13px] font-medium">Answer</span>
            </div>
            <div className="mt-4">
              <ResultView result={answer.answer.result} />
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-ink-faint">
                {answer.answer.minerName || answer.answer.minerId ? (
                  <>Answered by {answer.answer.minerName ?? answer.answer.minerId}. {" "}</>
                ) : null}
                Paid {(Number(answer.receipt.amount_uusdc) / 1_000_000).toFixed(2)} USDC
              </p>
              <button
                type="button"
                onClick={() => resetToCompose(true)}
                className="btn-quiet !min-h-8 !px-3 !text-[11.5px]"
              >
                Ask another question
              </button>
            </div>
          </section>

          {/* Receipt — collapsed, no overflow */}
          <details className="rounded-xl border border-edge bg-panel">
            <summary className="cursor-pointer px-4 py-3 text-[13px] text-ink-soft">
              Receipt & verification
            </summary>
            <div className="space-y-2 border-t border-edge px-4 py-3 text-[12px]">
              <div className="flex justify-between gap-3">
                <span className="text-ink-faint">Charged</span>
                <span className="tabular text-ink">{(Number(answer.receipt.amount_uusdc) / 1_000_000).toFixed(2)} USDC</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-ink-faint">Receipt</span>
                <span className="truncate text-right tabular text-ink" title={answer.receipt.receipt_hash}>
                  {answer.receipt.receipt_hash.slice(0, 12)}…
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-ink-faint">Signal</span>
                <span className="truncate text-right tabular text-ink" title={answer.signalHash}>
                  {answer.signalHash.slice(0, 12)}…
                </span>
              </div>
              <button onClick={runVerify} disabled={verifying} className="btn-signal mt-2 w-full !justify-center text-[12px]">
                {verifying ? "Checking…" : "Verify"}
              </button>
              {verifyStatus && (
                <p className="mt-2 text-[11px] text-ink-soft">{verifyStatus.note}</p>
              )}
            </div>
          </details>

          {/* Technical details — collapsed */}
          <details className="rounded-xl border border-edge bg-panel">
            <summary className="cursor-pointer px-4 py-3 text-[13px] text-ink-soft">
              Technical details
            </summary>
            <pre className="max-h-60 overflow-auto border-t border-edge px-4 py-3 text-[11px] leading-relaxed text-ink-soft">
              {JSON.stringify(answer.answer.result ?? {}, null, 2)}
            </pre>
          </details>
        </div>
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

      {/* ---------------- log ---------------- */}
      {log.length > 0 && (
        <details open={!answer} className="mt-6 rounded-xl border border-edge bg-panel">
          <summary className="cursor-pointer px-5 py-4 text-[13px] font-medium text-ink-soft">
            What happened{" "}
            <span className="text-[11px] font-normal text-ink-faint">{log.length} steps</span>
          </summary>
          <div className="border-t border-edge px-5 py-4">
            <ol className="space-y-3.5">
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
          </div>
        </details>
      )}

      <div className="mt-8 flex flex-wrap gap-3 text-[12px]">
        <Link href="/intents" className="btn-quiet">All intents</Link>
        <Link href="/miners" className="btn-quiet">All miners</Link>
      </div>
    </div>
  );
}
