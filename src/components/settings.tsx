"use client";

import { useEffect, useState } from "react";
import { money } from "@/components/taskParts";

/**
 * Settings: a truthful, read-only view of how the system is configured.
 * Integration names only, no secret values. Runtime defaults come from
 * GET /api/status so the page always matches the running server.
 */

interface StatusBody {
  ok: boolean;
  store: "ok" | "unavailable";
  services: { telegraph: boolean; telegram: boolean; chainRpc: boolean };
  defaultSpendLimitCents: number;
}

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
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="max-w-2xl">
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          How this NIGHTSHIFT instance is configured. Names and states only; secret values are never shown here.
        </p>
      </div>

      {failed && (
        <p aria-live="assertive" role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not read the runtime status. Check that the server is running.
        </p>
      )}

      {status && (
        <div className="mt-5 space-y-4">
          <section className="rounded-lg border border-edge bg-panel" aria-label="Integrations">
            <div className="border-b border-edge px-4 py-3">
              <h2 className="text-[14px] font-semibold">Integrations</h2>
            </div>
            <ul className="divide-y divide-edge">
              {[
                {
                  name: "Telegraph paid intelligence",
                  configured: status.services.telegraph,
                  note: "Buys answers over x402 with an auditable receipt. Needs TELEGRAPH_EVM_PRIVATE_KEY in the environment (Settings → Environment).",
                },
                {
                  name: "Telegram bot",
                  configured: status.services.telegram,
                  note: "The same engine on @nightshiftagent_bot. Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.",
                },
                {
                  name: "Chain RPC (read-only)",
                  configured: status.services.chainRpc,
                  note: "Public Base Sepolia RPC by default; override with NIGHTSHIFT_CHAIN_RPC_URL. Used for settlement checks and independent reads only.",
                },
              ].map((s) => (
                <li key={s.name} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div>
                    <p className="text-[13px] font-medium text-ink">{s.name}</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">{s.note}</p>
                  </div>
                  <span className={`shrink-0 rounded-sm border px-2 py-0.5 text-[10.5px] font-medium ${s.configured ? "border-teal/40 bg-teal/10 text-teal" : "border-risk/40 bg-risk/10 text-risk"}`}>
                    {s.configured ? "Configured" : "Not configured"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-edge bg-panel" aria-label="Runtime defaults">
            <div className="border-b border-edge px-4 py-3">
              <h2 className="text-[14px] font-semibold">Runtime defaults</h2>
            </div>
            <ul className="divide-y divide-edge">
              <li className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-[13px] font-medium text-ink">Default spending ceiling</p>
                  <p className="mt-0.5 text-[11.5px] text-ink-faint">Applied when an operation is launched with the field cleared; override with NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS.</p>
                </div>
                <span className="tabular text-[12.5px] text-ink">{money(status.defaultSpendLimitCents)}</span>
              </li>
              <li className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-[13px] font-medium text-ink">Task store</p>
                  <p className="mt-0.5 text-[11.5px] text-ink-faint">Local JSON store behind the task API and the Telegram bot.</p>
                </div>
                <span className={`rounded-sm border px-2 py-0.5 text-[10.5px] font-medium ${status.store === "ok" ? "border-teal/40 bg-teal/10 text-teal" : "border-risk/40 bg-risk/10 text-risk"}`}>
                  {status.store === "ok" ? "Reachable" : "Unreachable"}
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-lg border border-edge bg-panel" aria-label="Data policy">
            <div className="border-b border-edge px-4 py-3">
              <h2 className="text-[14px] font-semibold">How numbers are counted</h2>
            </div>
            <p className="px-4 py-3 text-[12px] leading-relaxed text-ink-soft">
              Costs come only from recorded spend entries, taken from each payment receipt. Tasks labeled as test
              runs by the automated audit are excluded from ordinary metrics. A task counts as completed only when
              every fixed success criterion passed against real evidence; failed and blocked tasks say so, and blocked
              tasks are never charged.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
