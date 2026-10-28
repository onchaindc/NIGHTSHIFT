"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TaskRecord } from "@/lib/engine/types";
import { isOpen, isTestRun } from "@/components/taskParts";

/**
 * Agents view: an honest capability matrix. Research & Verify is the one agent
 * with executable capabilities (Telegraph paid intelligence, settlement checks,
 * ledger reconciliation, independent chain reads). The others are labeled
 * Planned and never shown as active.
 */

interface StatusBody {
  ok: boolean;
  store: "ok" | "unavailable";
  services: { telegraph: boolean; telegram: boolean; chainRpc: boolean };
}

const CAPS = {
  research: {
    status: "available" as const,
    summary: "Answers questions worth paying for, then proves every answer before showing it. Runs today on the web and on Telegram.",
    capabilities: [
      { name: "Paid intelligence (Telegraph network)", detail: "Buy the best answer within the task ceiling; x402 settlement with an auditable receipt." },
      { name: "Settlement verification", detail: "Reads its own payment transaction from the public chain before trusting the delivery." },
      { name: "Purchase reconciliation", detail: "Checks receipt, transaction, and signal hashes plus the ledger sums against the recorded spend." },
      { name: "Independent chain cross-check", detail: "Compares purchased telemetry against a live read from our own public RPC within tolerance." },
      { name: "Approval gate + budget ceiling", detail: "Nothing is charged before the plan passes your approval rule and the ceiling check." },
      { name: "Telegram presence", detail: "The same engine answers @nightshiftagent_bot with the same limits and evidence." },
    ],
  },
  code: {
    status: "planned" as const,
    summary: "Repository read/write work. Not implemented: there is no execution capability for code repositories in the service yet.",
    capabilities: [],
  },
  ops: {
    status: "planned" as const,
    summary: "Deployments and infrastructure actions. Not implemented: no deployment target or credentials are wired up, so nothing can run.",
    capabilities: [],
  },
  data: {
    status: "planned" as const,
    summary: "Analytics pipelines over collected data. Not implemented: no export or pipeline runner exists in the service yet.",
    capabilities: [],
  },
};

export default function Agents() {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, t] = await Promise.all([
          fetch("/api/status", { cache: "no-store" }),
          fetch("/api/tasks", { cache: "no-store" }),
        ]);
        if (s.ok && !cancelled) setStatus((await s.json()) as StatusBody);
        else if (!cancelled) setStatusFailed(true);
        if (t.ok && !cancelled) setTasks(((await t.json()) as { tasks: TaskRecord[] }).tasks);
      } catch {
        if (!cancelled) setStatusFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const real = (tasks ?? []).filter((t) => !isTestRun(t));
  const researchActive = real.filter((t) => isOpen(t.state)).length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="max-w-2xl">
        <h1 className="text-[22px] font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          What each agent can do, stated plainly. Capabilities marked Planned do not exist in the service yet and
          those agents are never shown as active.
        </p>
      </div>

      {statusFailed && (
        <p aria-live="assertive" role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not read the integration status. Check that the server is running.
        </p>
      )}

      <div className="mt-5 space-y-4">
        <article className="rounded-lg border border-edge bg-panel">
          <div className="border-b border-edge px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[14px] font-semibold">Research &amp; Verify</h2>
                <span className="inline-flex items-center gap-1.5 rounded-sm border border-teal/40 bg-teal/10 px-2 py-0.5 text-[10.5px] font-medium text-teal">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />
                  Available
                </span>
              </div>
              <span className="tabular text-[11px] text-ink-faint">
                {tasks === null ? "counting…" : `${researchActive} active operation${researchActive === 1 ? "" : "s"}`}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{CAPS.research.summary}</p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-b-lg bg-edge sm:grid-cols-2 lg:grid-cols-3">
            {CAPS.research.capabilities.map((c) => (
              <div key={c.name} className="bg-panel px-4 py-3">
                <p className="text-[12.5px] font-medium text-ink">{c.name}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">{c.detail}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-edge px-4 py-3 sm:px-5">
            <span className="text-[11px] text-ink-faint">Connection status:</span>
            <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${status?.services.telegraph ? "text-teal" : "text-risk"}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status?.services.telegraph ? "bg-teal" : "bg-risk"}`} />
              Telegraph {status?.services.telegraph ? "configured" : "not configured"}
            </span>
            <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${status?.services.telegram ? "text-teal" : "text-gold"}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status?.services.telegram ? "bg-teal" : "bg-gold"}`} />
              Telegram bot {status?.services.telegram ? "configured" : "not configured"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-teal">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />
              Chain RPC ready (public read-only default)
            </span>
            <Link href="/operations" className="ml-auto text-[12px] font-medium text-blue hover:underline underline-offset-2">
              Launch an operation →
            </Link>
          </div>
        </article>

        {(["code", "ops", "data"] as const).map((id) => (
          <article key={id} className="rounded-lg border border-edge bg-panel">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
              <h2 className="text-[14px] font-semibold">{CAPS[id].status && id === "code" ? "Code Agent" : id === "ops" ? "Ops Agent" : "Data Agent"}</h2>
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-faint">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                Planned
              </span>
            </div>
            <p className="px-4 pb-3.5 text-[12px] leading-relaxed text-ink-soft sm:px-5">{CAPS[id].summary}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
