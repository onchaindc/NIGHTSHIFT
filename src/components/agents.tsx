"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bot, ChevronLeft, Network, Wrench } from "lucide-react";
import type { TaskRecord } from "@/lib/engine/types";
import { isOpen, isTestRun } from "@/components/taskParts";
import type { StatusBody } from "@/components/shell-types";

/**
 * Agents view: an honest capability matrix. Research & Verify is the one agent
 * with executable capabilities (Telegraph paid intelligence, settlement checks,
 * ledger reconciliation, independent chain reads), and Protocol Watch delivers
 * continuous monitoring. The others are labeled Planned and never shown as
 * active.
 */

const CAPS = {
  research: {
    name: "Research & Verify",
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
  code: { name: "Code Agent", status: "planned" as const, summary: "Repository read/write work. Not implemented: there is no execution capability for code repositories in the service yet." },
  ops: { name: "Ops Agent", status: "planned" as const, summary: "Deployments and infrastructure actions. Not implemented: no deployment target or credentials are wired up, so nothing can run." },
  data: { name: "Data Agent", status: "planned" as const, summary: "Analytics pipelines over collected data. Not implemented: no export or pipeline runner exists in the service yet." },
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
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href="/" className="inline-flex min-h-10 items-center gap-1 text-[12.5px] font-medium text-amber transition-colors hover:text-amber-soft">
        <ChevronLeft size={13} aria-hidden /> Overview
      </Link>
      <div className="mt-3 max-w-2xl">
        <p className="x-label">Capability matrix</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink">Agents</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
          What each agent can do, stated plainly. Capabilities marked Planned do not exist in the service yet and
          those agents are never shown as active.
        </p>
      </div>

      {statusFailed && (
        <p aria-live="assertive" role="alert" className="mt-5 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not read the integration status. Check that the server is running.
        </p>
      )}

      <div className="mt-6 space-y-4">
        <article className="overflow-hidden rounded-lg border border-edge bg-panel">
          <div className="border-b border-edge px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md border border-teal/40 bg-teal/10 text-teal">
                  <Wrench size={13} strokeWidth={1.8} />
                </span>
                <h2 className="text-[14px] font-semibold text-ink">{CAPS.research.name}</h2>
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
          <div className="grid gap-px overflow-hidden bg-edge sm:grid-cols-2 lg:grid-cols-3">
            {CAPS.research.capabilities.map((c) => (
              <div key={c.name} className="bg-panel px-4 py-3.5">
                <p className="text-[12.5px] font-medium text-ink">{c.name}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">{c.detail}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-edge px-4 py-3 sm:px-5">
            <span className="text-[11px] text-ink-faint">Connection status:</span>
            <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${status ? (status.services.telegraph ? "text-teal" : "text-risk") : "text-ink-faint"}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status ? (status.services.telegraph ? "bg-teal" : "bg-risk") : "bg-ink-faint"}`} />
              Telegraph {status ? (status.services.telegraph ? "configured" : "not configured") : "checking"}
            </span>
            <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${status ? (status.services.telegram ? "text-teal" : "text-amber") : "text-ink-faint"}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status ? (status.services.telegram ? "bg-teal" : "bg-amber") : "bg-ink-faint"}`} />
              Telegram bot {status ? (status.services.telegram ? "configured" : "not configured") : "checking"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-teal">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />
              Chain RPC ready (public read-only default)
            </span>
            <Link href="/operations" className="ml-auto text-[12px] font-medium text-amber transition-colors hover:text-amber-soft">
              Launch an operation →
            </Link>
          </div>
        </article>

        {/* Live monitor agent: full detail claim lives on its own route. */}
        <article className="rounded-lg border border-amber/35 bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
            <h2 className="inline-flex items-center gap-2.5 text-[14px] font-semibold text-ink">
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md border border-amber/40 bg-amber/10 text-amber">
                <Network size={13} strokeWidth={1.8} />
              </span>
              Protocol Watch
            </h2>
            <Link href="/watch" className="text-[12px] font-medium text-amber transition-colors hover:text-amber-soft">
              Open Protocol Watch →
            </Link>
          </div>
          <p className="px-4 pb-3.5 text-[12px] leading-relaxed text-ink-soft sm:px-5">
            Continuous monitoring of real protocol sources with baselined change detection, an idempotent alert
            ledger, and verified delivery — scheduled, recovered, and free to run.
          </p>
        </article>

        {(["code", "ops", "data"] as const).map((id) => (
          <article key={id} className="rounded-lg border border-edge bg-panel/50">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
              <h2 className="inline-flex items-center gap-2.5 text-[14px] font-semibold text-ink-faint">
                <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md border border-edge bg-panel-2 text-ink-faint">
                  <Bot size={13} strokeWidth={1.8} />
                </span>
                {CAPS[id].name}
              </h2>
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-faint">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                Planned
              </span>
            </div>
            <p className="px-4 pb-3.5 text-[12px] leading-relaxed text-ink-faint sm:px-5">{CAPS[id].summary}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
