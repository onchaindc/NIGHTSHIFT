"use client";

/**
 * The Counterparty Intel client. A strict human-checked sequence, reusing the
 * Terminal's payment rail without re-building any of it:
 *
 *   compose (company + jurisdiction) → probe (the node's UNPAID verdict:
 *   validation error or the live x402 challenge for the pinned
 *   zk-corp-atlas ask) → approval (the exact challenged offer) → pay (the
 *   wallet signs; /api/terminal/challenge + /api/terminal/complete are the
 *   same routes the Terminal uses) → result (the hash-committed answer,
 *   classified into verified facts / missing fields / disagreements, with
 *   the receipt and signal verification shown as they actually are).
 *
 * Nothing here invents a price, a provider, a fact, or a success. A bare 402
 * to a signed payment is displayed as a refusal — never retried.
 */

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  CircleAlert,
  ExternalLink,
  Loader2,
  Search,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useWallets, useSignMessage, useSignTypedData } from "@privy-io/react-auth";

import type { CounterpartyClassification } from "@/lib/counterparty/intel";

export interface CounterpartyGuarantees {
  intent: string;
  miner: string;
  nodeUrl: string;
}

interface ApprovedOffer {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

interface ProbeChallenge {
  kind: "challenge";
  urlPath: string;
  body: { intent: string; params: Record<string, unknown> };
  approvedOffer: ApprovedOffer;
  priceUsd: number;
  /** The request exactly as probed; paying and analysis use this, not the live inputs. */
  request: { company: string; jurisdiction?: string };
}

type ProbeState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "challenge"; offer: ProbeChallenge }
  | { kind: "rejected"; status: number; text: string; node?: unknown }
  | { kind: "unavailable"; detail: string };

interface PaidAnswer {
  body: Record<string, unknown>;
  signalHash: string;
  receipt: {
    receipt_hash: string;
    rail: string;
    payer: string;
    miner: string;
    intent: string;
    amount_uusdc: string;
    epoch_id: number;
    settlement: string;
    chain: string;
    timestamp: number;
  } | null;
  settlementHeader: string | null;
}

type AnalysisState =
  | { kind: "analyzing" }
  | {
      kind: "analyzed";
      verification: { status: "verified" | "recorded" | "unverified"; note: string };
      committed: Record<string, unknown> | null;
      classification: CounterpartyClassification | null;
    };

const FIELD_LABELS: Record<string, string> = {
  legal_name: "Legal name",
  registration_id: "Registration ID",
  lei: "LEI",
  active: "Active",
  jurisdiction: "Jurisdiction",
  registered_address: "Registered address",
  incorporated: "Incorporated",
  legal_form: "Legal form",
  register: "Register",
};

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Fill the node's escrow template verbatim; it lowercases {from} itself. */
function escrowMessage(template: string, from: string, nonce: string, validAfter: string, validBefore: string): string {
  return template
    .replaceAll("{from}", from.toLowerCase())
    .replaceAll("{nonce}", nonce)
    .replaceAll("{validAfter}", validAfter)
    .replaceAll("{validBefore}", validBefore);
}

function fmtField(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes (active)" : "No (not active)";
  return String(v);
}

function shortHash(h: string): string {
  return h.length > 22 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h;
}

export default function CounterpartyClient({ guarantees }: { guarantees: CounterpartyGuarantees }) {
  const [company, setCompany] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [approvedBox, setApprovedBox] = useState(false);
  const [paying, setPaying] = useState(false);
  const [failure, setFailure] = useState<{ heading: string; detail: string } | null>(null);
  const [answer, setAnswer] = useState<PaidAnswer | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const { signMessage } = useSignMessage();
  const signerWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;

  /* ---- probe (unpaid) ------------------------------------------------ */

  const runProbe = useCallback(async () => {
    setFailure(null);
    setAnswer(null);
    setAnalysis(null);
    setApprovedBox(false);
    setProbe({ kind: "probing" });
    try {
      const res = await fetch("/api/counterparty/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, jurisdiction: jurisdiction.trim() || undefined }),
      });
      const body = (await res.json()) as { status?: string; outcome?: Record<string, unknown>; error?: string };
      if (body.status === "challenge" && body.outcome) {
        const o = body.outcome as unknown as ProbeChallenge;
        // Freeze the request at probe time: the approval card, the signed body,
        // and the post-purchase analysis all describe the same ask.
        setProbe({
          kind: "challenge",
          offer: { ...o, request: { company: company.trim(), jurisdiction: jurisdiction.trim() || undefined } },
        });
        setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
        return;
      }
      if (body.status === "rejected") {
        const o = (body.outcome ?? {}) as { status?: number; text?: string; body?: unknown };
        setProbe({ kind: "rejected", status: o.status ?? 0, text: o.text ?? body.error ?? "The request was rejected.", node: o.body });
        return;
      }
      setProbe({ kind: "unavailable", detail: (body.outcome as { detail?: string } | undefined)?.detail ?? body.error ?? "The node could not be reached." });
    } catch (err) {
      setProbe({ kind: "unavailable", detail: err instanceof Error ? err.message : String(err) });
    }
  }, [company, jurisdiction]);

  /* ---- pay (Terminal rail: challenge → signature → complete) --------- */

  const runPay = useCallback(async () => {
    if (probe.kind !== "challenge") return;
    const offer = probe.offer;
    setFailure(null);
    if (!signerWallet) {
      setFailure({
        heading: "Connect a wallet to pay",
        detail:
          "This flow pays from your wallet, never from the server. Open the Wallet page to create the free in-app wallet or connect one, then approve this same offer again.",
      });
      return;
    }
    setPaying(true);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 70_000);
    try {
      // The probed request, not whatever is currently in the inputs.
      const requestParams: Record<string, unknown> = { company: offer.request.company };
      if (offer.request.jurisdiction) requestParams.jurisdiction = offer.request.jurisdiction;
      const body = {
        intent: guarantees.intent,
        params: requestParams,
        miner: guarantees.miner,
        approved: true,
        offer: offer.approvedOffer,
      };
      const chRes = await fetch("/api/terminal/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urlPath: offer.urlPath, body }),
        signal: controller.signal,
      });
      const ch = await chRes.json();
      if (!ch.offer) {
        setFailure({ heading: "Could not get the payment challenge", detail: ch.error ?? "unknown" });
        return;
      }
      // Drift protection, as the approval text promises: the fresh challenge
      // must match the approved offer field for field before anything is
      // signed. On drift nothing is signed and nothing is charged.
      const fresh = ch.offer as Partial<ApprovedOffer> | undefined;
      const approved = offer.approvedOffer;
      const drifted =
        !fresh ||
        fresh.scheme !== approved.scheme ||
        fresh.network !== approved.network ||
        fresh.amount !== approved.amount ||
        (fresh.asset ?? "").toLowerCase() !== approved.asset.toLowerCase() ||
        (fresh.payTo ?? "").toLowerCase() !== approved.payTo.toLowerCase();
      if (drifted) {
        setFailure({
          heading: "The live offer has drifted — nothing was signed or charged",
          detail: `You approved ${approved.amount} units to ${approved.payTo} on ${approved.network}, but the node now offers ${
            fresh?.amount ?? "an unknown amount"
          } to ${fresh?.payTo ?? "an unknown recipient"} on ${fresh?.network ?? "an unknown network"}. Run the price check again and approve the new offer explicitly.`,
        });
        return;
      }
      let payment: string;
      let paymentHeaderName: "PAYMENT-SIGNATURE" | "X-PAYMENT" = "PAYMENT-SIGNATURE";
      if (ch.escrow) {
        // Escrow signs a human-readable authorization instead of EIP-3009
        // transfer typed data; the node reads it from X-PAYMENT.
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
        payment = btoa(
          JSON.stringify({
            x402Version: 2,
            scheme: "escrow",
            network: escrow.network,
            payload: { signature, authorization },
          }),
        );
        paymentHeaderName = "X-PAYMENT";
      } else {
        if (!ch.typedData) {
          setFailure({ heading: "Could not get the payment challenge", detail: "The exact payment typed data is missing." });
          return;
        }
        ch.typedData.message.from = signerWallet.address;
        const { signature } = await signTypedData(ch.typedData, {
          address: signerWallet.address,
          uiOptions: { showWalletUIs: false },
        });
        const accepted = (ch.challenge?.accepts as Array<Record<string, unknown>> | undefined)?.find(
          (a) => a.scheme === "exact" && a.network === ch.offer.network,
        );
        payment = btoa(
          JSON.stringify({
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
          }),
        );
      }
      const done = await fetch("/api/terminal/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urlPath: offer.urlPath,
          body,
          paymentHeader: payment,
          paymentHeaderName,
          payer: signerWallet.address,
        }),
        signal: controller.signal,
      });
      const result = await done.json();
      const signalHash = typeof result.body?.signal_hash === "string" ? result.body.signal_hash : null;
      if (result.status === 200 && signalHash) {
        let receipt: PaidAnswer["receipt"] = null;
        if (typeof result.receipt === "string") {
          try {
            receipt = JSON.parse(atob(result.receipt)) as PaidAnswer["receipt"];
          } catch {
            receipt = null;
          }
        }
        setAnswer({
          body: (result.body ?? {}) as Record<string, unknown>,
          signalHash,
          receipt,
          settlementHeader: result.paymentResponse ?? null,
        });
        setProbe({ kind: "idle" });
        setAnalysis({ kind: "analyzing" });
        // The summary `result` is what disagreements are detected against —
        // the whole envelope is not an answer and would never be compared.
        const bodyResult = (result.body as { result?: unknown } | null)?.result ?? null;
        analyze(signalHash, bodyResult, offer.request);
        return;
      }
      const detail =
        result.status === 402
          ? (typeof result.error === "string" && result.error
              ? `${result.error} Nothing settled on chain, and this flow never re-sends a refused payment.`
              : "The signed payment did not verify (bare 402). Nothing settled on chain, and this flow never re-sends a refused payment.")
          : result.error ?? JSON.stringify(result.body ?? result).slice(0, 300);
      setFailure({ heading: result.status === 402 ? "Payment refused by the network" : "Payment failed", detail });
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      const msg = aborted
        ? "No answer came back within 70 seconds. The payment may already have settled — check Activity before trying again."
        : err instanceof Error
          ? err.message
          : String(err);
      setFailure({ heading: aborted ? "Timed out — settlement unknown" : "Payment failed", detail: msg });
    } finally {
      clearTimeout(deadline);
      setPaying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe, signerWallet, signTypedData, signMessage, guarantees]);

  /* ---- analyze (verify + read the committed payload) ------------------ */

  const analyze = useCallback(
    async (signalHash: string, bodyResult: unknown, request: { company: string; jurisdiction?: string }) => {
      try {
        const res = await fetch("/api/counterparty/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signalHash, bodyResult, request }),
        });
        const body = (await res.json()) as {
          status?: string;
          analysis?: {
            verification: { kind: "verified" | "recorded" | "unverified"; note?: string; detail?: string };
            committed: Record<string, unknown> | null;
            classification: CounterpartyClassification | null;
          };
          error?: string;
        };
        if (body.status === "analyzed" && body.analysis) {
          setAnalysis({
            kind: "analyzed",
            verification: {
              status: body.analysis.verification.kind,
              note: body.analysis.verification.note ?? body.analysis.verification.detail ?? "",
            },
            committed: body.analysis.committed,
            classification: body.analysis.classification,
          });
        } else if (body.status === "unverified" && body.analysis) {
          setAnalysis({
            kind: "analyzed",
            verification: { status: "unverified", note: body.analysis.verification.detail ?? "" },
            committed: null,
            classification: null,
          });
        } else {
          setAnalysis({ kind: "analyzed", verification: { status: "unverified", note: body.error ?? "Analysis failed." }, committed: null, classification: null });
        }
      } catch (err) {
        setAnalysis({
          kind: "analyzed",
          verification: { status: "unverified", note: err instanceof Error ? err.message : String(err) },
          committed: null,
          classification: null,
        });
      }
    },
    [],
  );

  /* ---- rendering ------------------------------------------------------ */

  const classification = analysis?.kind === "analyzed" ? analysis.classification : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/minds" className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
        ← All Minds
      </Link>
      <p className="x-tag mt-4">MINDS · COUNTERPARTY</p>
      <h1 className="x-display-1 mt-3 text-ink">Counterparty intelligence</h1>
      <p className="mt-4 max-w-[62ch] text-[14px] leading-relaxed text-ink-soft">
        Name a company; a pinned corporate-registry specialist answers, paid per request through your
        wallet. What you see is the hash-committed answer — verified against the signal registry and
        split into facts, gaps, and conflicts.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <Building2 size={12} aria-hidden /> provider pinned: <span className="text-ink-soft">{guarantees.miner}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          intent: <span className="text-ink-soft">{guarantees.intent}</span>
        </span>
      </div>

      {/* compose */}
      <section className="mt-8 overflow-hidden rounded-xl border border-edge bg-panel">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label">1 · Who are you checking</p>
        </div>
        <div className="space-y-4 px-4 py-4 sm:px-5">
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <div>
              <label htmlFor="cp-company" className="x-label">Company name</label>
              <input
                id="cp-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Equinor ASA"
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
              />
            </div>
            <div>
              <label htmlFor="cp-jurisdiction" className="x-label">Jurisdiction <span className="text-ink-faint">(optional)</span></label>
              <input
                id="cp-jurisdiction"
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
                placeholder="e.g. Norway"
                className="mt-1.5 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={runProbe}
            disabled={company.trim().length < 2 || probe.kind === "probing"}
            className="btn-primary inline-flex items-center gap-2"
          >
            {probe.kind === "probing" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Search size={14} aria-hidden />}
            {probe.kind === "probing" ? "Asking the network…" : "Check price"}
          </button>
          <p className="text-[11.5px] text-ink-faint">
            The price check is free: the node validates the request and returns the live offer before any payment exists.
          </p>
        </div>
      </section>

      {/* probe outcomes */}
      <div ref={resultRef}>
        {probe.kind === "rejected" && (
          <section className="mt-5 rounded-xl border border-amber/40 bg-amber-soft/50 p-4 text-[13px] text-ink-soft">
            <p className="flex items-center gap-1.5 font-medium text-amber-deep">
              <AlertTriangle size={13} aria-hidden />
              {probe.status === 0 ? "The request was not sent" : `The node refused this request (HTTP ${probe.status})`}
            </p>
            <p className="mt-1.5 break-words">{probe.text}</p>
          </section>
        )}
        {probe.kind === "unavailable" && (
          <section className="mt-5 rounded-xl border border-amber/40 bg-amber-soft/50 p-4 text-[13px] text-ink-soft">
            <p className="flex items-center gap-1.5 font-medium text-amber-deep"><AlertTriangle size={13} aria-hidden /> The node could not be reached</p>
            <p className="mt-1.5 break-words">{probe.detail}</p>
          </section>
        )}

        {probe.kind === "challenge" && !answer && (
          <section className="mt-5 overflow-hidden rounded-xl border border-edge bg-panel">
            <div className="border-b border-edge px-4 py-3 sm:px-5">
              <p className="x-label">2 · The live offer <span className="text-ink-faint">— nothing is charged until you approve</span></p>
            </div>
            <div className="space-y-3 px-4 py-4 sm:px-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-ink-soft">Price</span>
                <span className="text-[15px] font-semibold tabular text-ink">${probe.offer.priceUsd.toFixed(2)}</span>
              </div>
              <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-[130px_1fr]">
                <dt className="text-ink-faint">Provider</dt>
                <dd className="text-ink">{guarantees.miner} <span className="text-ink-faint">(pinned)</span></dd>
                <dt className="text-ink-faint">Network</dt>
                <dd className="tabular text-ink">{probe.offer.approvedOffer.network}</dd>
                <dt className="text-ink-faint">Asset</dt>
                <dd className="break-all tabular text-ink">{probe.offer.approvedOffer.asset}</dd>
                <dt className="text-ink-faint">Pay to</dt>
                <dd className="break-all tabular text-ink">{probe.offer.approvedOffer.payTo}</dd>
                <dt className="text-ink-faint">Amount</dt>
                <dd className="tabular text-ink">{probe.offer.approvedOffer.amount} <span className="text-ink-faint">(6-decimal USDC units)</span></dd>
                <dt className="text-ink-faint">Payer</dt>
                <dd className="break-all tabular text-ink">{signerWallet ? signerWallet.address : <span className="text-amber-deep">no wallet connected</span>}</dd>
              </dl>
              <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-lg border border-edge bg-panel-2 p-3">
                <input
                  type="checkbox"
                  checked={approvedBox}
                  onChange={(e) => setApprovedBox(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span className="text-[12.5px] leading-relaxed text-ink-soft">
                  I approve exactly this offer: {probe.offer.approvedOffer.amount} units of the asset above,
                  paid to the address above, on {probe.offer.approvedOffer.network}. If the live price or
                  recipient has drifted by the time of signing, the request is refused — never signed.
                </span>
              </label>
              <button type="button" onClick={runPay} disabled={!approvedBox || paying} className="btn-primary inline-flex items-center gap-2">
                {paying ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
                {paying ? "Paying…" : `Approve & pay $${probe.offer.priceUsd.toFixed(2)}`}
              </button>
            </div>
          </section>
        )}

        {failure && (
          <section className="mt-5 rounded-xl border border-risk/40 bg-risk/5 p-4 text-[13px] text-risk">
            <p className="flex items-center gap-1.5 font-medium"><XCircle size={13} aria-hidden /> {failure.heading}</p>
            <p className="mt-1.5 break-words">{failure.detail}</p>
          </section>
        )}

        {/* result */}
        {answer && (
          <section className="mt-5 overflow-hidden rounded-xl border border-edge bg-panel">
            <div className="border-b border-edge px-4 py-3 sm:px-5">
              <p className="x-label">3 · Answer &amp; verification</p>
            </div>
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {/* verification banner — exactly as checked, never assumed */}
              {analysis?.kind === "analyzed" ? (
                <div
                  className={`rounded-lg border p-3 text-[12.5px] leading-relaxed ${
                    analysis.verification.status === "verified"
                      ? "border-teal/40 bg-teal-soft/40 text-ink-soft"
                      : "border-amber/40 bg-amber-soft/50 text-ink-soft"
                  }`}
                >
                  <p className={`flex items-center gap-1.5 font-medium ${analysis.verification.status === "verified" ? "text-teal" : "text-amber-deep"}`}>
                    {analysis.verification.status === "verified" ? <BadgeCheck size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}
                    Signal verification: {analysis.verification.status}
                  </p>
                  <p className="mt-1">{analysis.verification.note}</p>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel-2 p-3 text-[12.5px] text-ink-soft">
                  <Loader2 size={13} className="animate-spin" aria-hidden /> Verifying the signal against the registry…
                </div>
              )}

              {/* committed-answer status */}
              {analysis?.kind === "analyzed" && !analysis.committed && (
                <p className="text-[12.5px] text-amber-deep">
                  The signal registry carries no committed answer payload for this hash, so no field below is presented as fact.
                </p>
              )}

              {/* verified facts */}
              {classification && classification.facts.length > 0 && (
                <div>
                  <p className="x-label">Verified facts <span className="text-ink-faint">— from the hash-committed answer</span></p>
                  <dl className="mt-2 divide-y divide-edge overflow-hidden rounded-lg border border-edge bg-panel-2">
                    {classification.facts.map((f) => (
                      <div key={f.field} className="grid gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-[190px_1fr]">
                        <dt className="text-[12px] text-ink-faint">{fmtField(f.field)}</dt>
                        <dd className="break-words text-[13px] text-ink">{fmtValue(f.value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {/* missing fields */}
              {classification && classification.missing.length > 0 && (
                <div>
                  <p className="x-label">Not provided by the provider</p>
                  <p className="mt-1.5 text-[12.5px] text-ink-soft">
                    {classification.missing.map((f) => fmtField(f)).join(", ")} — absent from the committed answer; shown as missing, never filled in.
                  </p>
                </div>
              )}

              {/* disagreements */}
              {classification && classification.disagreements.length > 0 && (
                <div>
                  <p className="x-label">Disagreements</p>
                  <ul className="mt-2 space-y-2">
                    {classification.disagreements.map((d, i) => (
                      <li key={`${d.field}-${i}`} className="rounded-lg border border-risk/40 bg-risk/5 p-3 text-[12.5px] text-ink-soft">
                        <p className="font-medium text-risk">{fmtField(d.field)}: sources disagree</p>
                        <p className="mt-1">
                          <span className="text-ink-faint">{d.left.source}:</span> <span className="tabular">{fmtValue(d.left.value)}</span>
                          {" — "}
                          <span className="text-ink-faint">{d.right.source}:</span> <span className="tabular">{fmtValue(d.right.value)}</span>
                        </p>
                        {d.note && <p className="mt-1 italic">{d.note}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* supporting evidence */}
              {classification && (classification.meta.register || classification.meta.license || classification.meta.sources.length > 0 || classification.meta.confidence !== undefined) && (
                <div>
                  <p className="x-label">Supporting evidence</p>
                  <div className="mt-2 space-y-1.5 text-[12.5px] text-ink-soft">
                    {classification.meta.confidence !== undefined && (
                      <p>Provider confidence: <span className="tabular text-ink">{Math.round(classification.meta.confidence * 100)}%</span></p>
                    )}
                    {classification.meta.register && <p>Register: <span className="text-ink">{classification.meta.register}</span></p>}
                    {classification.meta.crossCheckNote && (
                      <p>
                        Cross-check: <span className="text-ink">{classification.meta.crossCheckNote}</span>
                        {classification.meta.crossCheckSource && (
                          <> — <a href={classification.meta.crossCheckSource} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-teal hover:underline">{shortHash(classification.meta.crossCheckSource)} <ExternalLink size={11} aria-hidden /></a></>
                        )}
                      </p>
                    )}
                    {classification.meta.license && <p className="text-ink-faint">{classification.meta.license}</p>}
                    {classification.meta.sources.length > 0 && (
                      <ul className="space-y-1">
                        {classification.meta.sources.map((s) => (
                          <li key={s}>
                            <a href={s} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 break-all text-teal hover:underline">
                              {s} <ExternalLink size={11} aria-hidden />
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {/* receipt + signal */}
              <div>
                <p className="x-label">Receipt &amp; signal</p>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-[150px_1fr]">
                  <dt className="text-ink-faint">Receipt hash</dt>
                  <dd className="break-all tabular text-ink">{answer.receipt?.receipt_hash ? shortHash(answer.receipt.receipt_hash) : "—"}</dd>
                  <dt className="text-ink-faint">Settlement</dt>
                  <dd className="break-all text-ink">{answer.receipt?.settlement || answer.settlementHeader || "—"}</dd>
                  <dt className="text-ink-faint">Amount</dt>
                  <dd className="tabular text-ink">{answer.receipt?.amount_uusdc ?? "—"} <span className="text-ink-faint">units</span></dd>
                  <dt className="text-ink-faint">Signal</dt>
                  <dd className="break-all tabular text-ink">
                    {HASH_RE.test(answer.signalHash) ? (
                      <Link href={`/signals/${answer.signalHash}`} className="inline-flex items-center gap-1 text-teal hover:underline">
                        {shortHash(answer.signalHash)} <ExternalLink size={11} aria-hidden />
                      </Link>
                    ) : (
                      answer.signalHash
                    )}
                  </dd>
                </dl>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
