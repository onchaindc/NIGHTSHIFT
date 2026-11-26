"use client";

import { useCallback, useEffect, useState } from "react";

import type { AcpJobRecord, AcpProviderStatus, AcpServiceOffering } from "@/lib/acp/types";

const STATUS_CHIP: Record<string, { chip: string; word: string }> = {
  received: { chip: "border-edge bg-panel-2 text-ink-faint", word: "Received" },
  validated: { chip: "border-edge bg-panel-2 text-ink-faint", word: "Validated" },
  rejected_intake: { chip: "border-edge bg-panel-2 text-ink-faint", word: "Refused at intake" },
  accepted: { chip: "border-teal/30 bg-teal/5 text-teal", word: "Accepted · priced" },
  funded: { chip: "border-teal/30 bg-teal/5 text-teal", word: "Funded" },
  pre_flight: { chip: "border-teal/30 bg-teal/5 text-teal", word: "Pre-flight" },
  awaiting_approval: { chip: "border-amber/40 bg-amber/10 text-amber", word: "Awaiting human approval" },
  executing: { chip: "border-amber/40 bg-amber/10 text-amber", word: "Executing" },
  delivered: { chip: "border-amber/40 bg-amber/10 text-amber", word: "Delivered · awaiting evaluator" },
  completed: { chip: "border-teal/40 bg-teal/10 text-teal", word: "Completed · settled" },
  rejected: { chip: "border-risk/40 bg-risk/5 text-risk", word: "Rejected by evaluator" },
  expired: { chip: "border-edge bg-panel-2 text-ink-faint", word: "Expired" },
  failed: { chip: "border-risk/40 bg-risk/5 text-risk", word: "Failed" },
};

const MODE_CHIP: Record<string, string> = {
  real: "border-teal/40 bg-teal/10 text-teal",
  mock: "border-amber/40 bg-amber/10 text-amber",
  disabled: "border-edge bg-panel-2 text-ink-faint",
};

function money(cents: number | null): string {
  return cents === null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

function shortAddress(address: string | null): string {
  if (!address) return "—";
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}

interface StatusBody {
  status: AcpProviderStatus;
  offerings: AcpServiceOffering[];
  jobCounts: Record<string, number>;
}

export default function Acp() {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [jobs, setJobs] = useState<AcpJobRecord[] | null>(null);
  const [busy, setBusy] = useState<"tick" | "simulate" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offeringId, setOfferingId] = useState("nightshift/listing-underwriter");
  const [subjectJson, setSubjectJson] = useState(JSON.stringify(SAMPLE_SUBJECTS["nightshift/listing-underwriter"], null, 2));

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/acp/status", { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as StatusBody);
      const jobsRes = await fetch("/api/acp/jobs", { cache: "no-store" });
      const body = (await jobsRes.json()) as { jobs?: AcpJobRecord[]; counts?: Record<string, number> };
      setJobs(body.jobs ?? null);
    } catch {
      setError("The ACP status could not be read — retrying on next action.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (kind: "tick" | "simulate", body?: Record<string, unknown>) => {
      setBusy(kind);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(kind === "tick" ? "/api/acp/jobs" : "/api/acp/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? { action: "tick" }),
        });
        const payload = (await res.json().catch(() => ({}))) as { error?: string; simulated?: boolean; job?: AcpJobRecord; submitted?: string[]; notes?: string[] };
        if (!res.ok) {
          setError(payload.error ?? `status ${res.status}`);
        } else if (kind === "simulate") {
          setNotice(`Simulated buyer job accepted through the real intake pipeline — job ${payload.job?.key ?? "?"} is ${payload.job?.status ?? "?"}.`);
        } else {
          setNotice(`Tick complete${payload.submitted?.length ? ` — ${payload.submitted.length} deliverable(s) submitted` : ""}.${payload.notes?.length ? ` ${payload.notes.join(" ")}` : ""}`);
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "request failed");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const provider = status?.status;
  const total = status ? Object.values(status.jobCounts).reduce((a, b) => a + b, 0) : 0;
  const openJobs = (jobs ?? []).filter((j) => !["completed", "rejected", "expired", "failed", "rejected_intake"].includes(j.status));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="x-label">Agent Commerce Protocol · Virtuals ACP (ERC-8183 jobs on Base)</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">Intelligence Commerce</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-soft">
          Other agents hire NIGHTSHIFT here: a job becomes one Deal Desk investigation, executed by the same
          approval-gated engine, delivered back as a structured, evidence-backed report. ACP escrow is the job&apos;s
          payment; Telegraph x402 is the per-answer payment — they are never conflated.
        </p>
      </header>

      {/* Connection — honest about what is and is not connected. */}
      <section aria-label="Provider connection" className="rounded-2xl border border-edge bg-panel p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="x-label">Provider connection</h2>
          {provider && <span className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${MODE_CHIP[provider.mode] ?? MODE_CHIP.disabled}`}>{provider.mode} transport</span>}
        </div>
        {provider ? (
          <div className="mt-3">
            <p className="text-[12.5px] leading-relaxed text-ink-soft">{provider.note}</p>
            <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[11.5px] sm:grid-cols-2">
              <div className="flex gap-1.5"><dt className="text-ink-faint">ACP_ENABLED:</dt><dd className={provider.enabled ? "text-teal" : "text-ink-faint"}>{String(provider.enabled)}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">v2 SDK installed:</dt><dd className="text-ink">{provider.enabled ? (provider.sdkInstalled ? "yes" : "no — install @virtuals-protocol/acp-node-v2 to enable the live transport") : "not checked (provider off)"}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">Agent wallet address:</dt><dd className={provider.credentials.walletAddress ? "text-teal" : "text-ink-faint"}>{provider.credentials.walletAddress ? "configured" : "missing"}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">Privy wallet id:</dt><dd className={provider.credentials.walletId ? "text-teal" : "text-ink-faint"}>{provider.credentials.walletId ? "configured" : "missing"}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">Signer key:</dt><dd className={provider.credentials.signerKey ? "text-teal" : "text-ink-faint"}>{provider.credentials.signerKey ? "configured" : "missing"}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">Chain:</dt><dd className="tabular text-ink">{provider.chainId}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">Runtime started:</dt><dd className={provider.runtimeStarted ? "text-teal" : provider.startupError ? "text-risk" : "text-ink-faint"}>{provider.runtimeStarted ? "yes — transport.start() resolved in this process" : provider.startupError ? "no — startup failed" : provider.attemptState === "starting" ? "starting…" : "not yet in this process"}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">ACP stream (SSE):</dt><dd className={provider.connected === true ? "text-teal" : provider.connected === false ? "text-risk" : "text-ink-faint"}>{provider.connected === true ? "connected to api.acp.virtuals.io" : provider.connected === false ? "disconnected" : provider.mode === "real" ? "not yet observed" : "—"}</dd></div>
              <div className="flex gap-1.5"><dt className="text-ink-faint">Agent wallet:</dt><dd className="font-mono text-ink">{shortAddress(provider.agentWalletAddress)}</dd></div>
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Never a fabricated connection: &ldquo;real&rdquo; appears only when the operator sets ACP_ENABLED and all three
              credentials and the v2 SDK is installed; without them the mock transport serves simulated buyers only.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-ink-faint">Reading the provider status…</p>
        )}
      </section>

      {/* Published services */}
      <section aria-label="Published services" className="mt-6">
        <h2 className="x-label">Published services — one ACP offering per Deal Desk workflow</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {(status?.offerings ?? []).map((o) => (
            <div key={o.id} className="rounded-2xl border border-edge bg-panel p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13px] font-semibold text-ink">{o.name}</p>
                <p className="tabular text-[12px] font-medium text-teal">{money(o.priceUsdCents)} / investigation</p>
              </div>
              <p className="mt-0.5 font-mono text-[10.5px] text-ink-faint">{o.id}</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">{o.description}</p>
              <p className="mt-2 text-[11px] text-ink-faint">
                Inputs: {o.inputs.length} field(s), {o.inputs.filter((i) => i.required).length} required ({o.inputs.filter((i) => i.required).map((i) => i.name).join(", ")})
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{o.executionPolicy}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Jobs */}
      <section aria-label="ACP jobs" className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="x-label">Jobs — {jobs ? `${openJobs.length} open · ${total} total` : "…"}</h2>
          <button type="button" className="btn-quiet !min-h-8 !text-[11.5px]" disabled={busy !== null || !provider || provider.mode === "disabled"} onClick={() => void act("tick")}>
            {busy === "tick" ? "Ticking…" : "Advance jobs (tick)"}
          </button>
        </div>
        {jobs === null ? (
          <p className="mt-2 text-[12px] text-ink-faint">Reading the job ledger…</p>
        ) : jobs.length === 0 ? (
          <p className="mt-2 rounded-xl border border-edge bg-panel-2 px-3.5 py-3 text-[12px] text-ink-soft">
            No ACP jobs yet. The intake runs the moment a buyer&apos;s agent messages a requirement{provider?.mode === "mock" ? " — use the simulated buyer below to watch the full pipeline" : ""}.
          </p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-2xl border border-edge bg-panel">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[11.5px]">
                <thead>
                  <tr className="border-b border-edge text-[10.5px] uppercase tracking-wide text-ink-faint">
                    <th className="px-3.5 py-2 font-medium">Job</th>
                    <th className="px-3.5 py-2 font-medium">Service</th>
                    <th className="px-3.5 py-2 font-medium">Status</th>
                    <th className="px-3.5 py-2 font-medium">Price</th>
                    <th className="px-3.5 py-2 font-medium">Telegraph cost</th>
                    <th className="px-3.5 py-2 font-medium">Settlement</th>
                    <th className="px-3.5 py-2 font-medium">Investigation</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const chip = STATUS_CHIP[j.status] ?? STATUS_CHIP.received;
                    return (
                      <tr key={j.key} className="border-b border-edge/60 last:border-0">
                        <td className="px-3.5 py-2">
                          <p className="font-mono text-[10.5px] text-ink">{j.key}</p>
                          <p className="text-[10px] text-ink-faint">{shortAddress(j.clientAddress)}</p>
                        </td>
                        <td className="px-3.5 py-2 text-ink-soft">{j.offering}</td>
                        <td className="px-3.5 py-2">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chip.chip}`}>{chip.word}</span>
                        </td>
                        <td className="tabular px-3.5 py-2 text-ink">{money(j.priceUsdCents)}</td>
                        <td className="tabular px-3.5 py-2 text-ink-soft">{money(j.executionCostUsdCents)}</td>
                        <td className="px-3.5 py-2 text-ink-soft">{j.settlementSettled ? `settled ${money(j.settlementUsdCents)}` : "escrow pending"}</td>
                        <td className="px-3.5 py-2">
                          {j.investigationId ? (
                            <a className="text-teal underline-offset-2 hover:underline" href={`/desk/i/${j.investigationId}`}>open file →</a>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Simulated buyer — operator only, refused when the live transport runs */}
      <section aria-label="Simulated buyer" className="mt-6 rounded-2xl border border-edge bg-panel p-4 sm:p-5">
        <h2 className="x-label">Simulated buyer (mock transport only)</h2>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
          Injects a simulated ACP job through the real intake pipeline — validation, pricing, investigation, the
          approval gate. The paid run it creates parks at the human approval gate and is released only through the
          existing controls. Refused entirely when the live transport is active, so mock and real traffic never mix.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="x-label mb-1 block">Service</span>
            <select className="w-full rounded-xl border border-edge bg-panel-2 px-3 py-2 text-[12.5px] text-ink" value={offeringId} onChange={(e) => {
              setOfferingId(e.target.value);
              setSubjectJson(JSON.stringify(SAMPLE_SUBJECTS[e.target.value] ?? {}, null, 2));
            }}>
              {(status?.offerings ?? []).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="x-label mb-1 block">Requirement inputs (JSON)</span>
            <textarea className="h-32 w-full rounded-xl border border-edge bg-panel-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink" value={subjectJson} onChange={(e) => setSubjectJson(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary !min-h-9 !text-[12.5px]"
            disabled={busy !== null || provider?.mode === "real" || provider?.mode === "disabled"}
            onClick={() => {
              try {
                const subject = JSON.parse(subjectJson) as Record<string, string>;
                void act("simulate", { offering: offeringId, subject });
              } catch {
                setError("The requirement inputs are not valid JSON.");
              }
            }}
          >
            {busy === "simulate" ? "Injecting…" : "Inject simulated buyer job"}
          </button>
          <span className="text-[11px] text-ink-faint">Sign in as the operator to act.</span>
        </div>
        {notice && <p role="status" className="mt-2 text-[12px] text-teal">{notice}</p>}
        {error && <p role="alert" className="mt-2 text-[12px] text-risk">{error}</p>}
      </section>
    </div>
  );
}

/* Example subjects, one per offering — placeholders for the operator, not data. */
const SAMPLE_SUBJECTS: Record<string, Record<string, string>> = {
  "nightshift/listing-underwriter": {
    assetClass: "digital_asset",
    assetName: "USDC",
    tokenSymbol: "USDC",
    chain: "ethereum",
    issuerEntity: "Circle Internet Group, Inc.",
    issuerJurisdiction: "US",
    issuerWebsite: "circle.com",
    controllerName: "Named Controller",
    marketSubject: "Uniswap USDC/ETH",
    declaredSupply: "1000000000",
  },
  "nightshift/counterparty-due-diligence": {
    legalName: "Acme Holdings Limited",
    jurisdiction: "US",
    website: "acme.example",
    controllerName: "Named Controller",
  },
  "nightshift/asset-intelligence": {
    assetClass: "digital_asset",
    assetName: "w1",
    walletAddress: "0xabc",
    chain: "base",
  },
  "nightshift/trade-supplier-intelligence": {
    supplierName: "Siemens AG",
    jurisdiction: "DE",
  },
};
