"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Server, Wallet } from "lucide-react";
import { money } from "@/components/taskParts";
import type { StatusBody } from "@/components/shell-types";

/**
 * Settings: a truthful, read-only view of how the system is configured.
 * Integration names and states only, no secret values. Runtime defaults come
 * from GET /api/status so the page always matches the running server.
 */

export default function Settings() {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.ok && !cancelled) setStatus((await res.json()) as StatusBody);
        else if (!cancelled) setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="max-w-2xl">
        <p className="x-tag">NS-WSP/15 · CONFIG</p>
        <h1 className="x-display-1 mt-3 text-ink">Settings</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
          How this NIGHTSHIFT instance is configured. Names and states only; secret values never appear here.
        </p>
      </div>

      {failed && (
        <p aria-live="assertive" role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not read the runtime status. Check that the server is running.
        </p>
      )}

      {status && (
        <div className="mt-8 space-y-5">
          <section className="overflow-hidden rounded-lg border border-edge bg-panel" aria-label="Integrations">
            <div className="border-b border-edge px-4 py-3">
              <h2 className="x-label">Integrations</h2>
            </div>
            <ul className="divide-y divide-edge">
              {[
                {
                  name: "Paid research",
                  configured: status.services.telegraph,
                  detail: "Buys answers on the Telegraph network with an auditable receipt and x402 settlement.",
                  setup: "TELEGRAPH_EVM_PRIVATE_KEY (the paid-research wallet key)",
                },
                {
                  name: "Telegram bot",
                  configured: status.services.telegram,
                  detail: "Runs the same operations over @nightshiftagent_bot, with webhook re-registration and delivery retries.",
                  setup: "TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET",
                },
                {
                  name: "Chain reads (read-only)",
                  configured: status.services.chainRpc,
                  detail: "Reads public chain data for verification. Base Sepolia RPC by default. Never signs anything.",
                  setup: "NIGHTSHIFT_CHAIN_RPC_URL (optional override)",
                },
                {
                  name: "Task store (Neon Postgres or local JSON)",
                  configured: status.store === "ok",
                  detail: "Watch configs, fingerprints and the alert ledger persist across restarts in production.",
                  setup: "DATABASE_URL or a local data directory",
                },
              ].map((s) => (
                <li key={s.name} className="flex items-start justify-between gap-4 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink">{s.name}</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">{s.detail}</p>
                    <p className="mt-1 tabular text-[10.5px] text-ink-faint">setup key: {s.setup}</p>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] font-medium ${s.configured ? "border-teal/40 bg-teal/10 text-teal" : "border-risk/40 bg-risk/10 text-risk"}`}>
                    {s.configured ? <CheckCircle2 size={11} aria-hidden /> : <CircleAlert size={11} aria-hidden />}
                    {s.configured ? "Configured" : "Not configured"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="overflow-hidden rounded-lg border border-edge bg-panel" aria-label="Runtime defaults">
            <div className="border-b border-edge px-4 py-3">
              <h2 className="x-label">Runtime defaults</h2>
            </div>
            <ul className="divide-y divide-edge">
              <li className="flex items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-2 text-[13px] font-medium text-ink">
                    <Wallet size={13} strokeWidth={1.8} aria-hidden className="text-ink-faint" /> Default spending ceiling
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">Applied when an operation is launched with the ceiling field cleared.</p>
                </div>
                <span className="tabular shrink-0 text-[13px] text-amber">{money(status.defaultSpendLimitCents ?? 100)}</span>
              </li>
              <li className="flex items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-2 text-[13px] font-medium text-ink">
                    <Server size={13} strokeWidth={1.8} aria-hidden className="text-ink-faint" /> Task store
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">The durable store behind the task API, the Telegram bot, and the watch scheduler.</p>
                </div>
                <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] font-medium ${status.store === "ok" ? "border-teal/40 bg-teal/10 text-teal" : "border-risk/40 bg-risk/10 text-risk"}`}>
                  {status.store === "ok" ? <CheckCircle2 size={11} aria-hidden /> : <CircleAlert size={11} aria-hidden />}
                  {status.store === "ok" ? "Reachable" : "Unreachable"}
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-lg border border-edge bg-panel px-4 py-3.5" aria-label="Data policy">
            <h2 className="x-label mb-2">How numbers are counted</h2>
            <p className="text-[12px] leading-relaxed text-ink-soft">
              Costs come only from recorded spend entries, taken from each payment receipt. Tasks labeled as test runs
              by the automated audit are excluded from ordinary metrics. A task counts as completed only when every
              fixed success criterion passed against real evidence; failed and blocked tasks say so, and blocked tasks
              are never charged. Protocol Watch alerts are delivered exactly once per detected change, with failed
              deliveries retried automatically.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
