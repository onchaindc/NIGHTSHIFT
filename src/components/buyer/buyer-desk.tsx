"use client";

/**
 * The Buyer Desk — NIGHTSHIFT's customer-facing ACP storefront, built as a
 * deliberate multi-step journey (Storefront → Configure → Review → Payment
 * → Tracking → Deliverable), not one long stacked page.
 *
 * The purchase runs on the REAL Virtuals ACP protocol with the BUYER'S OWN
 * wallet in their browser (Privy embedded or connected):
 *
 *   storefront    — four published offering cards; picking one opens ITS
 *                   dedicated request flow (forms never stack under cards)
 *   configure     — only that service's fields, worked-example fill, validation
 *   review        — requirements, price, wallet network, preflight reads, and
 *                   every wallet confirmation explained BEFORE it is requested
 *   tracking      — job lifecycle, on-chain transaction references, payment
 *                   and escrow state, provider progress, deliverable
 *   deliverable   — the evidence-backed report and the buyer's release action
 *   history       — past requests with job/tx details, one click to tracking
 *
 * Chain discipline (see wallet-chain.ts): the wallet's ACTIVE chain is read
 * before every signature; a wallet off Base is switched explicitly or the
 * signature is blocked — a Base transaction is never signed on chain 1. No
 * simulated transaction is ever shown as real: every step either produces a
 * Base transaction hash (linked on Basescan) or fails in the buyer's
 * language (tx-errors.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Check, CircleAlert, History as HistoryIcon, LoaderCircle, ShieldCheck, Store } from "lucide-react";

import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";
import { loadBuyerCatalog } from "@/lib/api/catalog-client";
import { CommerceDesk } from "@/components/commerce/commerce-desk";
import { Layers } from "lucide-react";
import { JobPanel } from "@/components/buyer/job-panel";
import { Storefront } from "./storefront";
import { RequestConfig } from "./request-config";
import { ReviewStage } from "./review-stage";
import { HistoryView } from "./history-view";
import { StageNav } from "./stage-nav";
import { ErrorNotice } from "./error-notice";
import type { BuyerJobView } from "@/lib/acp/buyer";
import type { AcpServiceOffering } from "@/lib/acp/types";
import {
  createBuyerRail,
  formatUsdc,
  usdcBaseUnits,
  buildRequirement,
  JOB_EXPIRY_SECONDS,
  classifyTxError,
  ensureWalletChain,
  readWalletChainId,
  BASE_CHAIN_ID,
  type BuyerRail,
  type Eip1193Provider,
  type OnChainJobView,
  type RoomEntry,
  type TxErrorView,
} from "@/lib/acp/buyer-browser";
import {
  journeyStep,
  preflightChecks,
  usableSamples,
  stallView,
  type BuyerStage,
  type PreflightCheck,
  type StallView,
} from "@/lib/acp/buyer-stages";

interface Catalog {
  offerings: AcpServiceOffering[];
  provider: { walletAddress: string | null; chainId: number; evaluatorAddress: string; live: boolean; mode: string };
}

const TERMINAL_PHASES = new Set(["completed", "rejected", "expired", "failed", "rejected_intake"]);

export function BuyerDesk() {
  const { login } = usePrivy();
  const { wallets } = useWallets();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  /** The catalog has its own honest state machine: loading → ready | failed.
   *  "Loading" never outlives a failure, and failure is retryable — the old
   *  one-bare-fetch loader left a permanent "Loading the published
   *  offerings…" label on any error. */
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "failed">("loading");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [rail, setRail] = useState<BuyerRail | null>(null);
  const [railError, setRailError] = useState<TxErrorView | null>(null);
  const eip1193Ref = useRef<Eip1193Provider | null>(null);

  const [stage, setStage] = useState<BuyerStage>("storefront");
  /** The Buyer Desk's two views: the real ACP purchase journey, and the four internal Agent Commerce sections. */
  const [view, setView] = useState<"store" | "commerce">("store");
  const [selected, setSelected] = useState<AcpServiceOffering | null>(null);
  const [subject, setSubject] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** Which payment confirmation is in flight — the echo between the two
   *  signatures (allowance → escrow funding), so the buyer always knows
   *  which of the two confirmations they are looking at. */
  const [payStep, setPayStep] = useState<"allowance" | "fund" | null>(null);
  const [pageError, setPageError] = useState<TxErrorView | null>(null);
  const [actionError, setActionError] = useState<TxErrorView | null>(null);

  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [gasWei, setGasWei] = useState<bigint | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);

  const [jobs, setJobs] = useState<BuyerJobView[]>([]);
  const [jobsError, setJobsError] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [chainJob, setChainJob] = useState<OnChainJobView | null>(null);
  const [room, setRoom] = useState<RoomEntry[]>([]);

  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  const active = useMemo(() => jobs.find((j) => j.buyer.key === activeKey) ?? null, [jobs, activeKey]);
  const buyerAddress = session.mode === "user" || session.mode === "operator" ? session.address ?? null : null;
  const signedIn = buyerAddress !== null;
  const providerWallet = catalog?.provider.walletAddress ?? null;
  const providerChainId = catalog?.provider.chainId ?? BASE_CHAIN_ID;
  /** The buyer wallet MUST be a different wallet from the provider signer. */
  const isProviderWallet = !!buyerAddress && !!providerWallet && buyerAddress.toLowerCase() === providerWallet.toLowerCase();
  const networkOk = walletChainId === BASE_CHAIN_ID;

  const loadCatalog = useCallback(async () => {
    setCatalogState("loading");
    const outcome = await loadBuyerCatalog();
    if (outcome.ok) {
      setCatalog(outcome.catalog as unknown as Catalog);
      setCatalogError(null);
      setCatalogState("ready");
    } else {
      setCatalogError(outcome.reason);
      setCatalogState("failed");
    }
  }, []);

  const loadJobs = useCallback(async (): Promise<BuyerJobView[]> => {
    try {
      const res = await fetch("/api/acp/buyer/jobs", { cache: "no-store" });
      if (res.status === 401) return []; // signed out — not a failure
      if (!res.ok) throw new Error(`the requests endpoint answered ${res.status}`);
      const body = (await res.json()) as { jobs?: BuyerJobView[] };
      if (!Array.isArray(body.jobs)) throw new Error("the requests answer was malformed");
      setJobs(body.jobs);
      setJobsError(false);
      return body.jobs;
    } catch {
      // A failed refresh must never masquerade as "no requests yet": the
      // history view distinguishes the two.
      setJobsError(true);
      return [];
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // The buyer rail: the signed-in wallet's EIP-1193 provider drives the real
  // SDK client. Rebuilt whenever the signed-in wallet changes; the wallet's
  // ACTIVE chain is read here and watched from then on (chainChanged).
  useEffect(() => {
    setRailError(null);
    setRail(null);
    eip1193Ref.current = null;
    if (!signedIn || !buyerAddress) return;
    const match = wallets.find((w) => w.address.toLowerCase() === buyerAddress.toLowerCase());
    if (!match) return; // surfaced as the connect hint below
    let cancelled = false;
    (async () => {
      try {
        const eip1193 = (await match.getEthereumProvider()) as Eip1193Provider;
        eip1193Ref.current = eip1193;
        const chain = await readWalletChainId(eip1193);
        if (!cancelled) setWalletChainId(chain);
        const next = await createBuyerRail({ eip1193, address: buyerAddress, chainId: providerChainId });
        if (!cancelled) setRail(next);
      } catch (err) {
        if (!cancelled) setRailError(classifyTxError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, buyerAddress, wallets, providerChainId]);

  // Watch the wallet's chain for the whole session: a chainChanged event
  // updates the guard immediately — the next signature reads it again
  // regardless (belt and suspenders).
  useEffect(() => {
    const eip1193 = eip1193Ref.current;
    if (!eip1193) return;
    const onChainChanged = (next: unknown) => {
      const id = typeof next === "string" && /^0x[0-9a-fA-F]+$/.test(next) ? Number.parseInt(next, 16) : typeof next === "number" ? next : null;
      setWalletChainId(id);
    };
    const provider = eip1193 as unknown as { on?: (event: string, handler: (payload: unknown) => void) => void; removeListener?: (event: string, handler: (payload: unknown) => void) => void };
    try {
      provider.on?.("chainChanged", onChainChanged);
    } catch {
      /* a wallet without event support just falls back to per-signature reads */
    }
    return () => {
      try {
        provider.removeListener?.("chainChanged", onChainChanged);
      } catch {
        /* nothing to clean up */
      }
    };
  }, [rail]);

  // Live tracking: poll the buyer's jobs while an open job is on screen.
  useEffect(() => {
    if (!signedIn) return;
    void loadJobs();
    const timer = setInterval(() => {
      const key = activeKeyRef.current;
      const isActive = jobs.some((j) => j.buyer.key === key && !TERMINAL_PHASES.has(j.phase));
      if (isActive || !key) void loadJobs();
    }, 5000);
    return () => clearInterval(timer);
  }, [signedIn, loadJobs, jobs]);

  // Preflight reads for the review stage (and refreshed on demand).
  const refreshPreflight = useCallback(async () => {
    if (!rail) return;
    try {
      const [g, u, a] = await Promise.all([rail.gasBalance(), rail.usdcBalance(), rail.usdcAllowance()]);
      setGasWei(g);
      setUsdcBalance(u);
      setAllowance(a);
    } catch {
      /* reads failing must not block the stage; the wallet re-checks at signature time */
    }
  }, [rail]);

  useEffect(() => {
    if (stage === "review" && rail) void refreshPreflight();
  }, [stage, rail, refreshPreflight]);

  // On-chain truth for the open job: read the ERC-8183 record directly.
  useEffect(() => {
    if (!rail || !active) return;
    let cancelled = false;
    (async () => {
      try {
        const job = await rail.readJob(active.buyer.jobId);
        if (!cancelled) setChainJob(job);
      } catch {
        /* a read failing must not break the panel; the provider status leads */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rail, active, active?.buyer.jobId]);

  // Job-room history for the open job (the provider's messages) — the room
  // exists once the requirement was posted.
  useEffect(() => {
    if (!rail || !active || !active.buyer.requirementSentAt) return;
    let cancelled = false;
    (async () => {
      try {
        const chat = await rail.openJobRoom();
        const history = await chat.getHistory(active.buyer.jobId);
        if (!cancelled) setRoom(history);
      } catch {
        /* the room is a convenience; the deliverable comes through the ledger */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rail, active, active?.buyer.key, active?.buyer.requirementSentAt]);

  /* ---------------- journey actions ---------------- */

  function pickOffering(offering: AcpServiceOffering) {
    setPageError(null);
    setActionError(null);
    setSelected(offering);
    setSubject({});
    setStage("configure");
  }

  function fillSamples(offering: AcpServiceOffering) {
    setSubject(usableSamples(offering, offering.samples));
  }

  function backToStorefront() {
    setStage("storefront");
    setSelected(null);
    setPageError(null);
  }

  async function switchToBase() {
    const eip1193 = eip1193Ref.current;
    if (!eip1193) return;
    setSwitching(true);
    setActionError(null);
    try {
      await ensureWalletChain(eip1193, BASE_CHAIN_ID);
      setWalletChainId(BASE_CHAIN_ID);
      void refreshPreflight();
    } catch (err) {
      setActionError(classifyTxError(err));
    } finally {
      setSwitching(false);
    }
  }

  async function createJobAndRegister() {
    if (!selected || !rail || !catalog) return;
    setBusy("create");
    setPageError(null);
    try {
      // The adapter verifies the wallet's ACTIVE chain before the signature
      // (wallet-chain.ts); a mismatch throws before anything is requested.
      const requirementJson = buildRequirement(selected.id, subject);
      const expiresAtSeconds = Math.floor(Date.now() / 1000) + JOB_EXPIRY_SECONDS;
      const { txHash, jobId } = await rail.createJob({
        providerAddress: catalog.provider.walletAddress ?? "",
        evaluatorAddress: catalog.provider.evaluatorAddress,
        expiredAtSeconds: expiresAtSeconds,
        description: requirementJson,
      });
      const res = await fetch("/api/acp/buyer/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register",
          chainId: providerChainId,
          jobId,
          txHash,
          offering: selected.id,
          requirement: subject,
          expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
        }),
      });
      const body = (await res.json()) as { job?: BuyerJobView; error?: string };
      if (!res.ok || !body.job) throw new Error(body.error ?? `register failed (${res.status})`);
      setActiveKey(body.job.buyer.key);
      setChainJob(null);
      setRoom([]);
      await loadJobs();
      setSelected(null);
      setStage("tracking");
      // Best-effort: also post the requirement to the signed job room (live
      // chat for ACP-registered agent wallets). The purchase does not depend
      // on it — the requirement already rode the on-chain description.
      void (async () => {
        try {
          const chat = await rail.openJobRoom();
          await chat.postMessage(body.job!.buyer.jobId, body.job!.buyer.requirementJson, "requirement");
          await fetch("/api/acp/buyer/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "update", key: body.job!.buyer.key, note: "requirement also posted to the job room" }),
          });
        } catch {
          /* recorded honestly: the description carries the requirement */
        }
      })();
    } catch (err) {
      setPageError(classifyTxError(err));
    } finally {
      setBusy(null);
    }
  }

  async function approvePayment() {
    if (!rail || !active) return;
    setBusy("fund");
    setActionError(null);
    try {
      const priceCents = active.provider?.priceUsdCents;
      if (!priceCents || priceCents <= 0) throw new Error("the provider has not priced this job yet");
      const amount = usdcBaseUnits(priceCents);
      const allowanceNow = await rail.usdcAllowance();
      if (allowanceNow < amount) {
        // Confirmation 1 of 2 — an approval, not a transfer.
        setPayStep("allowance");
        const allowanceTx = await rail.approveAllowance(amount);
        await fetch("/api/acp/buyer/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update", key: active.buyer.key, allowanceTxHash: allowanceTx, note: `allowance approved (${formatUsdc(amount)} USDC)` }),
        });
      }
      // Confirmation 2 of 2 — the actual payment into the escrow.
      setPayStep("fund");
      const fundedTx = await rail.fund(active.buyer.jobId, amount);
      await fetch("/api/acp/buyer/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", key: active.buyer.key, fundedTxHash: fundedTx, note: `escrow funded (${formatUsdc(amount)} USDC)` }),
      });
      setPayStep(null);
      await loadJobs();
    } catch (err) {
      // An allowance that LANDED stays recorded (its tx hash is on the job);
      // the error names the step that failed, never a false payment claim.
      setPayStep(null);
      setActionError(classifyTxError(err));
    } finally {
      setBusy(null);
    }
  }

  async function releaseEscrow() {
    if (!rail || !active) return;
    setBusy("release");
    setActionError(null);
    try {
      const tx = await rail.complete(active.buyer.jobId, "deliverable accepted by the buyer");
      await fetch("/api/acp/buyer/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", key: active.buyer.key, completedTxHash: tx, note: "escrow released on-chain by the buyer" }),
      });
      await loadJobs();
    } catch (err) {
      setActionError(classifyTxError(err));
    } finally {
      setBusy(null);
    }
  }

  function openJob(key: string) {
    setActiveKey(key);
    setActionError(null);
    setChainJob(null);
    setRoom([]);
    setStage("tracking");
  }

  /* ---------------- derived ---------------- */

  const preflight: PreflightCheck[] = useMemo(() => {
    const priceBase = selected ? usdcBaseUnits(selected.priceUsdCents) : 0n;
    return preflightChecks({
      walletChainId,
      requiredChainId: providerChainId,
      gasWei,
      usdcBase: usdcBalance,
      priceBase,
      allowanceBase: allowance,
    });
  }, [walletChainId, providerChainId, gasWei, usdcBalance, allowance, selected]);

  const walletForRail = wallets.find((w) => buyerAddress && w.address.toLowerCase() === buyerAddress.toLowerCase());
  const journey = journeyStep(stage, active?.phase ?? null);
  const livePhaseLabel = active && stage === "tracking" ? active.phaseLabel : null;

  /** Honest waiting view for the open job: elapsed time, unusual-wait notice,
   *  on-chain expiry countdown. Computed from real records only. */
  const stall: StallView | null = useMemo(() => {
    if (!active) return null;
    const fromRecord = active.buyer.expiresAt ? Date.parse(active.buyer.expiresAt) : NaN;
    const fromChain = chainJob ? Number(chainJob.expiredAt) : NaN;
    return stallView({
      phase: active.phase,
      createdAt: active.buyer.createdAt,
      providerUpdatedAt: active.provider?.updatedAt ?? null,
      expiresAtSeconds: Number.isFinite(fromChain) ? fromChain : Number.isFinite(fromRecord) ? Math.floor(fromRecord / 1000) : null,
    });
  }, [active, chainJob]);
  const stepNote: string | null =
    payStep === "allowance"
      ? "Step 1 of 2 — approve the USDC allowance in your wallet…"
      : payStep === "fund"
        ? "Allowance confirmed — step 2 of 2 — fund the escrow (this is the payment)."
        : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 pb-16 pt-6 sm:px-6">
      {/* Header */}
      <header className="space-y-2">
        <p className="x-label">Buyer Desk</p>
        <h1 className="text-[22px] font-semibold leading-tight text-ink sm:text-[26px]">Buy NIGHTSHIFT intelligence on the ACP protocol</h1>
        <p className="text-[13px] leading-relaxed text-ink-soft">
          Pick a published service, configure the request, approve the payment from your own wallet, and receive the evidence-backed report.
          Every step is a real Virtuals ACP action on Base — job creation, escrow funding and release are your signatures, linked on Basescan.
        </p>
        {catalogState === "ready" && catalog && (
          <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-ink-faint">
            <span className={`rounded-full border px-2 py-0.5 ${catalog.provider.live ? "border-teal/30 bg-teal/5 text-teal" : "border-amber/40 bg-amber-soft/40 text-amber-deep"}`}>
              {catalog.provider.live ? "provider live" : `provider ${catalog.provider.mode}`}
            </span>
            {providerWallet && (
              <a href={`https://basescan.org/address/${providerWallet}`} target="_blank" rel="noreferrer" className="tabular text-teal hover:underline">
                provider {providerWallet.slice(0, 6)}…{providerWallet.slice(-4)} ↗
              </a>
            )}
            <span className="rounded-full border border-edge bg-panel-2 px-2 py-0.5">Base · USDC · you release the escrow</span>
          </div>
        )}
      </header>

      {/* View switch — the ACP purchase journey vs the internal Agent Commerce desk */}
      <div role="tablist" aria-label="Buyer Desk views" className="flex gap-2 rounded-xl border border-edge bg-panel p-1">
        <button
          type="button"
          role="tab"
          aria-selected={view === "store"}
          onClick={() => setView("store")}
          className={`flex-1 !min-h-9 !text-[12px] ${view === "store" ? "btn-primary" : "btn-quiet"}`}
        >
          <Store size={13} aria-hidden className="mr-1.5 inline" /> Buy services
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "commerce"}
          onClick={() => setView("commerce")}
          className={`flex-1 !min-h-9 !text-[12px] ${view === "commerce" ? "btn-primary" : "btn-quiet"}`}
        >
          <Layers size={13} aria-hidden className="mr-1.5 inline" /> Agent Commerce
        </button>
      </div>

      {view === "commerce" && <CommerceDesk buyerAddress={buyerAddress} signedIn={signedIn} onSession={setSession} />}

      {view === "store" && (
        <>
      {/* Journey rail */}
      {(stage !== "storefront" || active) && <StageNav current={journey} livePhase={livePhaseLabel} />}

      {/* View switch — one stage on screen at a time */}
      {stage === "storefront" && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="x-label !mt-0">Published services</p>
            {signedIn && (
              <button
                type="button"
                onClick={() => setStage("history")}
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-faint transition-colors hover:text-teal"
              >
                <HistoryIcon size={13} aria-hidden /> Your requests {jobs.length > 0 && <span className="tabular">({jobs.length})</span>}
              </button>
            )}
          </div>
          {catalogState === "ready" && catalog ? (
            <Storefront offerings={catalog.offerings} onPick={pickOffering} busy={busy !== null} />
          ) : catalogState === "failed" ? (
            <CatalogFailure reason={catalogError} onRetry={() => void loadCatalog()} />
          ) : (
            <CatalogSkeleton />
          )}
          {pageError && <ErrorNotice error={pageError} />}

          {!signedIn && (
            <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
              <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Your buyer wallet</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                You can browse the services now; configuring a request asks you to sign in — one signature proves the wallet is yours. It is not a transaction; no funds move, no gas.
              </p>
              <div className="mt-2.5">
                <WalletSignIn onSession={setSession} />
              </div>
            </div>
          )}
        </>
      )}

      {stage === "configure" && selected && (
        <>
          <RequestConfig
            offering={selected}
            subject={subject}
            onChange={(name, value) => setSubject((p) => ({ ...p, [name]: value }))}
            onBack={backToStorefront}
            onContinue={() => setStage("review")}
            onFillSamples={() => fillSamples(selected)}
          />
          {pageError && <ErrorNotice error={pageError} />}
        </>
      )}

      {stage === "review" && selected && (
        <ReviewStage
          offering={selected}
          subject={subject}
          priceBase={usdcBaseUnits(selected.priceUsdCents)}
          walletAddress={buyerAddress}
          walletChainId={walletChainId}
          requiredChainId={providerChainId}
          switching={switching}
          preflight={preflight}
          preflightLoading={gasWei === null || usdcBalance === null || allowance === null}
          createError={pageError}
          busy={busy}
          onSwitchToBase={() => void switchToBase()}
          onRefreshPreflight={() => void refreshPreflight()}
          onCreateJob={() => void createJobAndRegister()}
          onBack={() => setStage("configure")}
          signedIn={signedIn}
        />
      )}

      {stage === "tracking" && active && (
        <>
          <JobPanel
            view={active}
            chainJob={chainJob}
            busy={busy}
            stepNote={stepNote}
            stall={stall}
            actionError={actionError}
            onApprovePayment={() => void approvePayment()}
            onReleaseEscrow={() => void releaseEscrow()}
          >
            {room.length > 0 && (
              <div className="rounded-lg border border-edge bg-panel-2 px-3.5 py-3">
                <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Job room</p>
                <ul className="mt-1.5 space-y-1">
                  {room.slice(-6).map((e, i) => (
                    <li key={i} className="text-[11.5px] leading-relaxed text-ink-soft">
                      {e.kind === "message" ? (
                        <>
                          <span className="font-medium text-ink">{e.contentType ?? "message"}</span> — {e.content?.slice(0, 220)}
                        </>
                      ) : (
                        <span className="text-ink-faint">{e.event?.type ?? "event"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </JobPanel>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
            <button type="button" onClick={() => setStage("storefront")} className="btn-quiet w-full !min-h-9 sm:w-auto">
              <Store size={13} aria-hidden /> Storefront
            </button>
            <button type="button" onClick={() => setStage("history")} className="btn-quiet w-full !min-h-9 sm:w-auto">
              <HistoryIcon size={13} aria-hidden /> Your requests
            </button>
          </div>
        </>
      )}

      {stage === "tracking" && !active && (
        <div className="rounded-xl border border-edge bg-panel px-4 py-6 text-center">
          <p className="text-[12.5px] text-ink-soft">No job open on this screen.</p>
          <button type="button" onClick={() => setStage("history")} className="btn-quiet mt-2 !min-h-8 !text-[12px]">
            <HistoryIcon size={12} aria-hidden /> See your requests
          </button>
        </div>
      )}

      {stage === "history" && (
        <>
          <HistoryView jobs={jobs} activeKey={activeKey} onOpen={openJob} loadFailed={signedIn && jobsError} onRetry={() => void loadJobs()} />
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
            <button type="button" onClick={() => setStage("storefront")} className="btn-quiet w-full !min-h-9 sm:w-auto">
              <Store size={13} aria-hidden /> Storefront
            </button>
          </div>
        </>
      )}

      {/* The wallet row lives with the flow: shown on configure/review when needed */}
      {(stage === "configure" || stage === "review") && (
        <div className="rounded-xl border border-edge bg-panel px-4 py-4 sm:px-5">
          <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Your buyer wallet</p>
          <div className="mt-2">
            <WalletSignIn onSession={setSession} />
          </div>
          {isProviderWallet && (
            <p className="mt-2 text-[12px] leading-relaxed text-risk">
              This wallet is the NIGHTSHIFT provider — a provider cannot buy from itself. Sign in with a different wallet.
            </p>
          )}
          {signedIn && !isProviderWallet && !walletForRail && (
            <div className="mt-2 space-y-2">
              <p className="text-[12px] leading-relaxed text-ink-soft">
                Your session wallet ({buyerAddress?.slice(0, 6)}…{buyerAddress?.slice(-4)}) has no connected wallet in this browser. Open the wallet panel to
                create or connect one, then sign in again.
              </p>
              <Link href="/funds" className="btn-quiet !min-h-8 !text-[11.5px]">
                Open Wallet
              </Link>
            </div>
          )}
          {railError && <div className="mt-2"><ErrorNotice error={railError} /></div>}
          {rail && !networkOk && (
            <div className="mt-2.5 space-y-2 rounded-lg border border-amber/40 bg-amber-soft/40 px-3 py-2.5">
              <p className="text-[12px] leading-relaxed text-amber-deep">
                Your wallet is on {walletChainId === null ? "an unknown network" : `chain ${walletChainId}`}. NIGHTSHIFT transactions only sign on Base (8453) — switching is requested explicitly and signing stays blocked until the wallet is on Base.
              </p>
              <button type="button" onClick={() => void switchToBase()} disabled={switching} className="btn-signal !min-h-8 !text-[12px]">
                {switching ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <ShieldCheck size={12} aria-hidden />}
                {switching ? "Check your wallet…" : "Switch wallet to Base"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Honesty footer */}
      <section className="rounded-xl border border-edge bg-panel-2 px-4 py-4 sm:px-5">
        <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">How the money moves</p>
        <ul className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-ink-soft">
          <li className="flex gap-1.5">
            <Check size={12} aria-hidden className="mt-0.5 shrink-0 text-teal" /> Your wallet signs every payment; NIGHTSHIFT never touches your funds and its
            signer stays on its own server.
          </li>
          <li className="flex gap-1.5">
            <Check size={12} aria-hidden className="mt-0.5 shrink-0 text-teal" /> Transactions only sign on Base (chain 8453): the desk verifies your wallet&apos;s
            network before every signature and blocks anything that would land elsewhere.
          </li>
          <li className="flex gap-1.5">
            <Check size={12} aria-hidden className="mt-0.5 shrink-0 text-teal" /> The escrow settles when YOU accept the deliverable on-chain — there is no
            separate evaluator on these jobs.
          </li>
          <li className="flex gap-1.5">
            <CircleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-amber-deep" /> The paid investigation runs behind NIGHTSHIFT&apos;s own human
            approval gate (each service&apos;s execution policy says exactly what that means); a failed run is messaged to the job room, never silently dropped.
          </li>
        </ul>
      </section>
        </>
      )}
    </div>
  );
}

/**
 * The storefront's loading shape: the catalogue is four cards, so the
 * placeholder is four card skeletons — the buyer sees what is coming and
 * roughly how long it takes, instead of one ambiguous line of text.
 */
function CatalogSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="status" aria-label="Loading the published services">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-edge bg-panel px-4 py-4">
          <div className="flex items-start justify-between gap-2">
            <div className="size-8 rounded-lg bg-panel-3 motion-safe:animate-pulse" aria-hidden />
            <div className="h-5 w-16 rounded-md bg-panel-3 motion-safe:animate-pulse" aria-hidden />
          </div>
          <div className="mt-3 h-3.5 w-40 rounded bg-panel-3 motion-safe:animate-pulse" aria-hidden />
          <div className="mt-2 h-3 w-full rounded bg-panel-2 motion-safe:animate-pulse" aria-hidden />
          <div className="mt-1.5 h-3 w-2/3 rounded bg-panel-2 motion-safe:animate-pulse" aria-hidden />
          <div className="mt-4 h-8 w-32 rounded-lg bg-panel-2 motion-safe:animate-pulse" aria-hidden />
        </div>
      ))}
    </div>
  );
}

/**
 * The catalog failure state — the state the old loader never had: it kept
 * saying "Loading…" after the request had already died. This one says what
 * happened, that nothing signed is affected, and offers the retry.
 */
function CatalogFailure({ reason, onRetry }: { reason: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-risk/30 bg-panel px-4 py-4" role="alert">
      <p className="flex items-start gap-2 text-[13.5px] font-semibold leading-snug text-risk">
        <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0" />
        The published services could not load
      </p>
      <p className="mt-1 pl-[23px] text-[12.5px] leading-relaxed text-ink-soft">
        {reason ?? "The request to the services endpoint did not complete."}
      </p>
      <div className="mt-2.5 pl-[23px]">
        <button type="button" onClick={onRetry} className="btn-quiet !min-h-8 !text-[12px]">
          Try again
        </button>
      </div>
    </div>
  );
}
