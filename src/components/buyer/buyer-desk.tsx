"use client";

/**
 * The Buyer Desk — NIGHTSHIFT's customer-facing ACP storefront.
 *
 * The whole purchase flow runs on the REAL Virtuals ACP protocol with the
 * BUYER'S OWN wallet in their browser (Privy embedded or connected):
 *
 *   choose an offering → fill the structured request → connect the buyer
 *   wallet → create the on-chain ERC-8183 job (one wallet signature) → send
 *   the requirement to the signed job room → the provider prices it
 *   (setBudget) → the buyer EXPLICITLY approves payment (allowance + fund,
 *   two confirmations) → track the investigation (operator approval gate
 *   disclosed) → read the deliverable and release the escrow on-chain.
 *
 * No simulated transaction is ever shown as real: every step either produces
 * a Base transaction hash (linked on Basescan) or a signed message against
 * api.acp.virtuals.io — and failures surface as failures.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Check, CircleAlert, LoaderCircle, ShieldCheck, Wallet } from "lucide-react";

import { WalletSignIn, type SessionState } from "@/components/wallet-sign-in";
import { friendlyNetworkError } from "@/lib/api/client-errors";
import { JobPanel } from "@/components/buyer/job-panel";
import type { BuyerJobView } from "@/lib/acp/buyer";
import type { AcpServiceOffering } from "@/lib/acp/types";
import {
  createBuyerRail,
  formatUsdc,
  usdcBaseUnits,
  buildRequirement,
  JOB_EXPIRY_SECONDS,
  type BuyerRail,
  type Eip1193Provider,
  type OnChainJobView,
  type RoomEntry,
} from "@/lib/acp/buyer-browser";

interface Catalog {
  offerings: AcpServiceOffering[];
  provider: { walletAddress: string | null; chainId: number; evaluatorAddress: string; live: boolean; mode: string };
}

const TERMINAL_PHASES = new Set(["completed", "rejected", "expired", "failed", "rejected_intake"]);

export function BuyerDesk() {
  const { login } = usePrivy();
  const { wallets } = useWallets();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [rail, setRail] = useState<BuyerRail | null>(null);
  const [railError, setRailError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AcpServiceOffering | null>(null);
  const [subject, setSubject] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<BuyerJobView[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [chainJob, setChainJob] = useState<OnChainJobView | null>(null);
  const [room, setRoom] = useState<RoomEntry[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  const active = useMemo(() => jobs.find((j) => j.buyer.key === activeKey) ?? null, [jobs, activeKey]);
  const buyerAddress = session.mode === "user" || session.mode === "operator" ? session.address ?? null : null;
  const signedIn = buyerAddress !== null;
  const providerWallet = catalog?.provider.walletAddress ?? null;
  const providerChainId = catalog?.provider.chainId ?? 8453;
  /** The buyer wallet MUST be a different wallet from the provider signer. */
  const isProviderWallet = !!buyerAddress && !!providerWallet && buyerAddress.toLowerCase() === providerWallet.toLowerCase();

  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch("/api/acp/buyer/catalog", { cache: "no-store" });
      setCatalog((await res.json()) as Catalog);
    } catch (err) {
      setError(friendlyNetworkError(err));
    }
  }, []);

  const loadJobs = useCallback(async (): Promise<BuyerJobView[]> => {
    try {
      const res = await fetch("/api/acp/buyer/jobs", { cache: "no-store" });
      if (res.status === 401) return [];
      const body = (await res.json()) as { jobs?: BuyerJobView[] };
      const list = body.jobs ?? [];
      setJobs(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // The buyer rail: the signed-in wallet's EIP-1193 provider drives the real
  // SDK client. Rebuilt whenever the signed-in wallet changes.
  useEffect(() => {
    setRailError(null);
    setRail(null);
    if (!signedIn || !buyerAddress) return;
    const match = wallets.find((w) => w.address.toLowerCase() === buyerAddress.toLowerCase());
    if (!match) return; // surfaced as the connect hint below
    let cancelled = false;
    (async () => {
      try {
        const eip1193 = (await match.getEthereumProvider()) as Eip1193Provider;
        const next = await createBuyerRail({ eip1193, address: buyerAddress, chainId: providerChainId });
        if (!cancelled) setRail(next);
      } catch (err) {
        if (!cancelled) setRailError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, buyerAddress, wallets, providerChainId]);

  // Live tracking: poll the buyer's jobs while an open job is on screen.
  useEffect(() => {
    if (!signedIn) return;
    void loadJobs().then(() => setHistoryLoaded(true));
    const timer = setInterval(() => {
      const key = activeKeyRef.current;
      const isActive = jobs.some((j) => j.buyer.key === key && !TERMINAL_PHASES.has(j.phase));
      if (isActive || !key) void loadJobs();
    }, 5000);
    return () => clearInterval(timer);
  }, [signedIn, loadJobs, jobs]);

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
  }, [rail, active?.buyer.jobId]);

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
  }, [rail, active?.buyer.key, active?.buyer.requirementSentAt]);

  async function pickOffering(offering: AcpServiceOffering) {
    setError(null);
    setActionError(null);
    setSelected(offering);
    setSubject({});
  }

  async function createJobAndRegister() {
    if (!selected || !rail || !catalog) return;
    setBusy("create");
    setError(null);
    try {
      // The requirement JSON rides the job's on-chain description — the
      // protocol-native channel open to every wallet. The job-room message
      // below is still attempted (registered agent wallets get live chat too).
      const requirementJson = buildRequirement(selected.id, subject);
      const { txHash, jobId } = await rail.createJob({
        providerAddress: catalog.provider.walletAddress ?? "",
        evaluatorAddress: catalog.provider.evaluatorAddress,
        expiredAtSeconds: Math.floor(Date.now() / 1000) + JOB_EXPIRY_SECONDS,
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
        }),
      });
      const body = (await res.json()) as { job?: BuyerJobView; error?: string };
      if (!res.ok || !body.job) throw new Error(body.error ?? `register failed (${res.status})`);
      setActiveKey(body.job.buyer.key);
      setChainJob(null);
      setRoom([]);
      await loadJobs();
      setSelected(null);
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
      setError(err instanceof Error ? err.message : String(err));
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
      const allowance = await rail.usdcAllowance();
      if (allowance < amount) {
        const allowanceTx = await rail.approveAllowance(amount);
        await fetch("/api/acp/buyer/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update", key: active.buyer.key, allowanceTxHash: allowanceTx, note: `allowance approved (${formatUsdc(amount)} USDC)` }),
        });
      }
      const fundedTx = await rail.fund(active.buyer.jobId, amount);
      await fetch("/api/acp/buyer/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", key: active.buyer.key, fundedTxHash: fundedTx, note: `escrow funded (${formatUsdc(amount)} USDC)` }),
      });
      await loadJobs();
    } catch (err) {
      setActionError(err instanceof Error ? `payment did not complete: ${err.message}` : "payment did not complete");
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
      setActionError(err instanceof Error ? `the release did not complete: ${err.message}` : "the release did not complete");
    } finally {
      setBusy(null);
    }
  }

  function openJob(key: string) {
    setActiveKey(key);
    setActionError(null);
    setChainJob(null);
    setRoom([]);
  }

  const walletForRail = wallets.find((w) => buyerAddress && w.address.toLowerCase() === buyerAddress.toLowerCase());
  const requiredMissing = selected ? selected.inputs.filter((i) => i.required && !(subject[i.name] ?? "").trim()) : [];

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
      {/* Header */}
      <header className="space-y-2">
        <p className="x-label">Buyer Desk</p>
        <h1 className="text-[22px] font-semibold leading-tight text-ink sm:text-[26px]">Buy NIGHTSHIFT intelligence on the ACP protocol</h1>
        <p className="text-[13px] leading-relaxed text-ink-soft">
          Pick a published service, send the structured request from your own wallet, approve the payment on-chain, and receive the evidence-backed report.
          Every step is a real Virtuals ACP action on Base — job creation, escrow funding and release are your signatures, linked on Basescan.
        </p>
        {catalog && (
          <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-ink-faint">
            <span className={`rounded-full border px-2 py-0.5 ${catalog.provider.live ? "border-teal/30 bg-teal/5 text-teal" : "border-amber/40 bg-amber-soft/40 text-amber-deep"}`}>
              {catalog.provider.live ? "provider live" : `provider ${catalog.provider.mode}`}
            </span>
            {providerWallet && (
              <a href={`https://basescan.org/address/${providerWallet}`} target="_blank" rel="noreferrer" className="tabular text-teal hover:underline">
                provider {providerWallet.slice(0, 6)}…{providerWallet.slice(-4)} ↗
              </a>
            )}
            <span className="rounded-full border border-edge bg-panel-2 px-2 py-0.5">Base · USDC · no evaluator — you release the escrow</span>
          </div>
        )}
      </header>

      {error && <p className="rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-[12px] leading-relaxed text-risk">{error}</p>}

      {/* Stage 1-2 — the catalogue */}
      <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-label="Published services">
        <div className="border-b border-edge px-4 py-3 sm:px-5">
          <p className="x-label !mt-0">1 · Choose a service</p>
        </div>
        <div className="space-y-2.5 px-4 py-4 sm:px-5">
          {(catalog?.offerings ?? []).map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => void pickOffering(o)}
              className={`w-full rounded-lg border p-3.5 text-left transition-colors ${selected?.id === o.id ? "border-teal/40 bg-teal/5" : "border-edge bg-panel-2 hover:border-edge"}`}
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-medium text-ink">{o.name}</span>
                <span className="tabular text-[12px] text-teal">{formatUsdc(usdcBaseUnits(o.priceUsdCents))} USDC</span>
              </span>
              <span className="mt-1 block text-[12px] leading-relaxed text-ink-soft">{o.description}</span>
              <span className="mt-1.5 block text-[11px] leading-relaxed text-ink-faint">
                You receive: {o.outputs.length > 160 ? `${o.outputs.slice(0, 160)}…` : o.outputs}
              </span>
            </button>
          ))}
          {!catalog && <p className="text-[12px] text-ink-faint">Loading the published offerings…</p>}
        </div>
      </section>

      {/* Stage 2-5 — request, wallet, job */}
      {selected && !active && (
        <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-label="Your request">
          <div className="border-b border-edge px-4 py-3 sm:px-5">
            <p className="x-label !mt-0">2 · Your request — {selected.name}</p>
          </div>
          <div className="space-y-4 px-4 py-4 sm:px-5">
            <div className="space-y-3">
              {selected.inputs.map((f) => (
                <div key={f.name}>
                  <label className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint" htmlFor={`bf-${f.name}`}>
                    {f.label}
                    {f.required && <span className="ml-1 text-risk">*</span>}
                  </label>
                  {f.kind === "textarea" ? (
                    <textarea
                      id={`bf-${f.name}`}
                      value={subject[f.name] ?? ""}
                      onChange={(e) => setSubject((p) => ({ ...p, [f.name]: e.target.value }))}
                      placeholder={f.help ?? ""}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-edge bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                    />
                  ) : f.kind === "select" ? (
                    <select
                      id={`bf-${f.name}`}
                      value={subject[f.name] ?? ""}
                      onChange={(e) => setSubject((p) => ({ ...p, [f.name]: e.target.value }))}
                      className="mt-1 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13px] text-ink outline-none focus:ring-1 focus:ring-edge"
                    >
                      <option value="">Choose…</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`bf-${f.name}`}
                      type={f.kind === "number" ? "text" : "text"}
                      inputMode={f.kind === "number" ? "decimal" : undefined}
                      value={subject[f.name] ?? ""}
                      onChange={(e) => setSubject((p) => ({ ...p, [f.name]: e.target.value }))}
                      placeholder={f.help ?? ""}
                      className="mt-1 h-10 w-full rounded-lg border border-edge bg-panel-2 px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-edge"
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-edge bg-panel-2 px-3.5 py-3">
              <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Execution policy</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{selected.executionPolicy}</p>
            </div>

            {/* Wallet + rail state */}
            <div className="rounded-lg border border-edge bg-panel-2 px-3.5 py-3">
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
                  <Link href="/funds" className="btn-secondary !min-h-8 !text-[11.5px]">
                    <Wallet size={12} aria-hidden /> Open Wallet
                  </Link>
                </div>
              )}
              {railError && <p className="mt-2 text-[12px] text-risk">{railError}</p>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void createJobAndRegister()}
                disabled={busy !== null || requiredMissing.length > 0 || !rail || isProviderWallet}
                className="btn-primary !min-h-9"
              >
                {busy === "create" ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
                Create ACP job — sign with your wallet
              </button>
              <button type="button" onClick={() => setSelected(null)} disabled={busy !== null} className="btn-secondary !min-h-9">
                Back
              </button>
            </div>
            {requiredMissing.length > 0 && (
              <p className="text-[11.5px] text-ink-faint">Fill {requiredMissing.map((f) => f.label).join(", ")} to enable job creation.</p>
            )}
            {!signedIn && <p className="text-[11.5px] text-ink-faint">Sign in first — job creation signs a transaction with your wallet.</p>}
            <p className="text-[11px] leading-relaxed text-ink-faint">
              What happens: one transaction creates the job on the ACP contract (Base), then the structured request is posted to the signed job room, then
              NIGHTSHIFT prices it and you approve the payment. Nothing is spent before you fund the escrow.
            </p>
          </div>
        </section>
      )}

      {/* Stage 6 — the open job */}
      {active && (
        <JobPanel
          view={active}
          chainJob={chainJob}
          busy={busy}
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
      )}

      {/* History */}
      {signedIn && (
        <section className="overflow-hidden rounded-xl border border-edge bg-panel" aria-label="Your requests">
          <div className="border-b border-edge px-4 py-3 sm:px-5">
            <p className="x-label !mt-0">Your requests {jobs.length > 0 && <span className="ml-1 normal-case tracking-normal">({jobs.length})</span>}</p>
          </div>
          <div className="px-4 py-4 sm:px-5">
            {jobs.length === 0 && historyLoaded && (
              <p className="text-[12px] leading-relaxed text-ink-faint">
                No requests yet. {active ? "" : "Pick a service above to create your first ACP job."}
              </p>
            )}
            {jobs.length > 0 && (
              <ul className="space-y-1.5">
                {jobs.map((j) => (
                  <li key={j.buyer.key}>
                    <button
                      type="button"
                      onClick={() => openJob(j.buyer.key)}
                      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${j.buyer.key === activeKey ? "border-teal/40 bg-teal/5" : "border-edge bg-panel-2 hover:border-edge"}`}
                    >
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[12.5px] font-medium text-ink">{j.provider?.offering ?? j.buyer.offering}</span>
                        <span className={`text-[11px] ${j.phase === "completed" ? "text-teal" : j.phase === "failed" || j.phase === "rejected" || j.phase === "rejected_intake" || j.phase === "expired" ? "text-risk" : "text-amber-deep"}`}>
                          {j.phaseLabel}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[10.5px] text-ink-faint">
                        job {j.buyer.jobId} · opened {new Date(j.buyer.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
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
            <Check size={12} aria-hidden className="mt-0.5 shrink-0 text-teal" /> The escrow settles when YOU accept the deliverable on-chain — there is no
            separate evaluator on these jobs.
          </li>
          <li className="flex gap-1.5">
            <CircleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-amber-deep" /> The paid investigation runs behind NIGHTSHIFT&apos;s own human
            approval gate (the execution policy on each service says exactly what that means); a failed run is messaged to the job room, never silently dropped.
          </li>
        </ul>
      </section>
    </div>
  );
}
