import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { listTasks } from "@/lib/engine/store";
import { AUDIT_LABEL } from "@/components/taskParts";
import { listWatches } from "@/lib/watch/store";
import type { TaskRecord } from "@/lib/engine/types";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "NIGHTSHIFT",
};

/**
 * Product landing. Renders the product story around the only marketing
 * assets this system has: real operations from the task store and the
 * actual monitoring capability. If the store cannot be reached the intel
 * band and outcome sections are omitted instead of faked.
 */

interface Intel {
  operations: number;
  completed: number;
  spendTotal: number;
  watches: number;
  findings: number;
  latest: TaskRecord | null;
  reachable: boolean;
}

async function readIntel(): Promise<Intel | null> {
  try {
    const [tasks, watches] = await Promise.all([listTasks(), listWatches()]);
    const real = tasks.filter((t) => !(t.labels ?? []).includes(AUDIT_LABEL));
    const watchRuns = real.filter((t) => t.jobType === "protocol_watch");
    let spendTotal = 0;
    for (const t of real) spendTotal += t.spend.spentUsdCents;
    const findings = watchRuns.reduce(
      (n, t) => n + t.events.filter((e) => e.type === "watch_change_detected").length,
      0,
    );
    const latest =
      [...real].sort((a, b) => b.createdAt - a.createdAt).find((t) => t.state === "completed" && t.result?.summary) ??
      null;
    return {
      operations: real.length,
      completed: real.filter((t) => t.state === "completed").length,
      spendTotal,
      watches: watches.length,
      findings,
      latest,
      reachable: true,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Execution schematic: the pipeline, drawn as a document, not an icon  */
/* ------------------------------------------------------------------ */

function Schematic() {
  const line = "#32373f";
  const faint = "#6a6661";
  const soft = "#a29d93";
  const amber = "#d99a3a";
  return (
    <svg
      viewBox="0 0 420 480"
      className="h-auto w-full"
      role="img"
      aria-label="Schematic of the execution pipeline: objective, plan, execution, evidence, verified outcome"
    >
      <defs>
        <marker id="arw" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8" fill="none" stroke={faint} strokeWidth="1.2" />
        </marker>
        <marker id="arwA" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8" fill="none" stroke={amber} strokeWidth="1.2" />
        </marker>
      </defs>

      {/* Objective */}
      <g>
        <rect x="24" y="18" width="372" height="64" rx="5" fill="#101215" stroke={line} />
        <text x="44" y="45" fill={soft} fontSize="13" fontFamily="var(--font-mono)" letterSpacing="1.5">OBJECTIVE</text>
        <text x="44" y="64" fill={faint} fontSize="10.5" fontFamily="var(--font-mono)" letterSpacing="1">
          ONE SENTENCE. A BUDGET. NOTHING ELSE.
        </text>
        <circle cx="376" cy="34" r="3.5" fill="none" stroke={faint} strokeWidth="1.2" />
      </g>

      <path d="M210 82 L210 114" stroke={line} strokeWidth="1.2" markerEnd="url(#arw)" />
      <text x="224" y="103" fill={faint} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">PLAN</text>

      {/* Plan */}
      <g>
        <rect x="24" y="114" width="372" height="88" rx="5" fill="#101215" stroke={line} />
        <rect x="44" y="134" width="152" height="18" rx="3" fill="#15181c" stroke={line} />
        <text x="52" y="147" fill={soft} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">BUYS INTELLIGENCE</text>
        <rect x="44" y="160" width="196" height="18" rx="3" fill="#15181c" stroke={line} />
        <text x="52" y="173" fill={soft} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">SETS COST CEILINGS</text>
        <text x="44" y="192" fill={faint} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">
          NOTHING SPENDS BEFORE APPROVAL
        </text>
        <text x="288" y="176" fill={faint} fontSize="26" fontFamily="var(--font-mono)">01</text>
      </g>

      <path d="M210 202 L210 234" stroke={line} strokeWidth="1.2" markerEnd="url(#arw)" />
      <text x="224" y="223" fill={faint} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">EXECUTE</text>

      {/* Execute */}
      <g>
        <rect x="24" y="234" width="372" height="88" rx="5" fill="#101215" stroke={line} />
        <rect x="44" y="254" width="220" height="4" rx="2" fill="#22262c" />
        <rect x="44" y="254" width="128" height="4" rx="2" fill={amber} />
        <text x="44" y="278" fill={soft} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">SPEND CEILING, ENFORCED LIVE</text>
        <text x="44" y="298" fill={faint} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">
          EVERY STEP LOGGED WITH ITS COST
        </text>
        <text x="288" y="296" fill={faint} fontSize="26" fontFamily="var(--font-mono)">02</text>
      </g>

      <path d="M210 322 L210 354" stroke={line} strokeWidth="1.2" markerEnd="url(#arw)" />
      <text x="224" y="343" fill={faint} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">EVIDENCE</text>

      {/* Evidence */}
      <g>
        <rect x="24" y="354" width="372" height="64" rx="5" fill="#101215" stroke={line} />
        <rect x="44" y="372" width="120" height="18" rx="3" fill="#15181c" stroke="#2d857f" />
        <text x="52" y="385" fill="#3aa981" fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">RECEIPTS</text>
        <rect x="176" y="372" width="164" height="18" rx="3" fill="#15181c" stroke="#2d857f" />
        <text x="184" y="385" fill="#3aa981" fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">CHAIN CROSS-CHECKS</text>
        <text x="44" y="408" fill={faint} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1">CLAIM WITHOUT PROOF FAILS</text>
      </g>

      <path d="M210 418 L210 442" stroke={amber} strokeWidth="1.2" markerEnd="url(#arwA)" />

      {/* Outcome */}
      <g>
        <rect x="24" y="442" width="372" height="30" rx="5" fill="rgba(217,154,58,0.08)" stroke="rgba(217,154,58,0.55)" />
        <text x="44" y="462" fill={amber} fontSize="12" fontFamily="var(--font-mono)" letterSpacing="2">VERIFIED OUTCOME</text>
        <circle cx="376" cy="457" r="4" fill={amber} className="motion-safe:animate-pulse" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Stage rows for the method section                                   */
/* ------------------------------------------------------------------ */

const STAGES = [
  {
    n: "01",
    title: "Hand off the outcome",
    body: "You write one sentence: what should be true when this is done, and the most you will pay. No workflow design, no prompt engineering, no dashboards to babysit.",
    artifact: "TASK RECORD",
  },
  {
    n: "02",
    title: "The agent buys a plan",
    body: "Nightshift drafts the plan itself: what intelligence to purchase, what to check for free on public chain data, and a dollar ceiling per step. Nothing executes until you approve.",
    artifact: "PLAN · CEILINGS",
  },
  {
    n: "03",
    title: "Execution inside the budget",
    body: "Purchases are recorded entries with their own receipts. The engine refuses work that would breach the ceiling, and it never spends what you did not approve.",
    artifact: "SPEND ENTRIES",
  },
  {
    n: "04",
    title: "Verification, not vibes",
    body: "Every result is checked against independent sources: chain reads, cross-checked gas telemetry, corroborated protocol findings. A claim without evidence is a failure, not a conclusion.",
    artifact: "CROSS-CHECKS",
  },
  {
    n: "05",
    title: "A verified outcome with receipts",
    body: "You get the answer, the evidence that backs it, and the exact money trail. The full record stays searchable in History, and urgent protocol changes reach you on Telegram with proof attached.",
    artifact: "RECORD · ALERTS",
  },
];

const CONTROLS = [
  {
    title: "Approval gates",
    body: "Any plan that spends waits for your decision. The interface shows the plan and the combined exposure before you commit.",
  },
  {
    title: "Hard spend ceilings",
    body: "A per-operation limit is set at launch and enforced mid-flight. Blocked tasks are never charged, by design.",
  },
  {
    title: "Evidence on every result",
    body: "Summaries are backed by receipts, chain reads and corroborated findings. Unverified summaries are labelled as such.",
  },
  {
    title: "Recovery, not retries",
    body: "Alert delivery is exactly-once: a failed Telegram send is recorded, backed off, and retried until it is confirmed delivered.",
  },
];

function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}

export default async function LandingPage() {
  const intel = await readIntel();

  return (
    <div className="min-h-dvh bg-night text-ink">
      {/* Top bar */}
      <header className="border-b border-edge">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-bold tracking-[0.22em] text-ink">NIGHTSHIFT</span>
            <span aria-hidden className="hidden h-3.5 w-px bg-edge-strong sm:block" />
            <span className="x-tag hidden sm:block">Autonomous intelligence operations</span>
          </div>
          <Link href="/console" className="btn-primary !min-h-9 !px-4 !text-[12.5px]">
            Enter the workspace
            <ArrowRight size={13} aria-hidden />
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-edge">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-24">
          <div>
            <p className="x-tag">NS-OPS/00 · PRODUCT BRIEF</p>
            <h1 className="x-display-hero mt-5 text-ink">
              Give it the outcome.
              <span className="block italic text-amber-soft">It handles the work.</span>
            </h1>
            <p className="mt-6 max-w-[52ch] text-[15px] leading-relaxed text-ink-soft">
              NIGHTSHIFT is an autonomous intelligence agent. Hand it a sentence, give it a budget, and it buys the
              information it needs, executes what you approved, verifies the result against public records, and hands
              back the answer with its receipts attached.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/console" className="btn-primary !min-h-11">
                Enter the workspace
                <ArrowRight size={14} aria-hidden />
              </Link>
              <a href="#method" className="btn-quiet !min-h-11">
                How an objective becomes proof
              </a>
            </div>
            <p className="x-tag mt-8">
              NO AUTO-SPEND · APPROVAL BEFORE PURCHASE · EVIDENCE BEFORE CLAIMS
            </p>
          </div>

          <div className="rounded-lg border border-edge bg-panel">
            <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
              <span className="x-tag">EXECUTION SCHEMATIC</span>
              <span className="x-tag">NS-01</span>
            </div>
            <div className="p-4 sm:p-6">
              <Schematic />
            </div>
          </div>
        </div>
      </section>

      {/* Intel band: real numbers, hidden rather than fabricated */}
      {intel?.reachable && (
        <section className="border-b border-edge bg-panel/40">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
            <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4 sm:divide-x sm:divide-edge lg:grid-cols-4">
              <div>
                <p className="tabular text-[30px] font-semibold leading-none text-ink">{intel.operations}</p>
                <p className="x-label mt-2">Operations run</p>
              </div>
              <div className="sm:pl-6">
                <p className="tabular text-[30px] font-semibold leading-none text-ink">{intel.completed}</p>
                <p className="x-label mt-2">Verified outcomes</p>
              </div>
              <div className="sm:pl-6">
                <p className="tabular text-[30px] font-semibold leading-none text-ink">$ {(intel.spendTotal / 100).toFixed(2)}</p>
                <p className="x-label mt-2">Spend, receipts on record</p>
              </div>
              <div className="sm:pl-6">
                <p className="tabular text-[30px] font-semibold leading-none text-ink">{intel.findings}</p>
                <p className="x-label mt-2">Protocol changes detected</p>
              </div>
            </div>
            <p className="x-tag mt-8">LIVE COUNTS FROM THE PRODUCTION TASK STORE · REFRESHED HOURLY</p>
          </div>
        </section>
      )}

      {/* Method */}
      <section id="method" className="border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="x-tag">NS-OPS/01 · METHOD</p>
              <h2 className="x-display-1 mt-4 text-ink">How an objective becomes a verified outcome</h2>
            </div>
            <p className="max-w-[38ch] text-[13px] leading-relaxed text-ink-faint">
              One pipeline, five stages, and a paper trail at every handoff. The agent does not hide the wiring: the
              workspace shows these exact stages running on live operations.
            </p>
          </div>

          <ol className="mt-12 space-y-0 border-t border-edge">
            {STAGES.map((s) => (
              <li key={s.n} className="grid gap-x-6 gap-y-2 border-b border-edge py-7 sm:grid-cols-[88px_1fr_1fr] lg:grid-cols-[88px_220px_1fr_140px]">
                <p className="tabular text-[13px] text-ink-faint" aria-hidden>{s.n}</p>
                <h3 className="text-[16.5px] font-semibold leading-snug text-ink sm:pr-6">{s.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-ink-soft">{s.body}</p>
                <p className="x-tag pt-1 lg:text-right">{s.artifact}</p>
              </li>
            ))}
          </ol>

          <p className="mt-6 max-w-[60ch] text-[13px] leading-relaxed text-ink-faint">
            The same pipeline powers Protocol Watch, where the objective is not a one-off question but standing
            vigilance: configured sources are re-read on a schedule, changes are fingerprinted against real baselines,
            and verified findings are delivered with proof.
          </p>
        </div>
      </section>

      {/* Latest verified outcome */}
      {intel?.latest?.state === "completed" && intel.latest.result && (
        <section className="border-b border-edge bg-panel/40">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <p className="x-tag">LATEST VERIFIED OUTCOME · REAL RECORD</p>
            <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_260px] lg:items-start">
              <div>
                <h3 className="text-[18px] font-medium leading-snug text-ink">
                  {intel.latest.goal}
                </h3>
                <p className="mt-3 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-soft">
                  {intel.latest.result.summary}
                </p>
              </div>
              <div className="rounded-lg border border-edge bg-panel p-4 lg:mt-1">
                <ul className="space-y-2.5">
                  <li className="flex items-center justify-between gap-3">
                    <span className="x-label">Status</span>
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-teal">
                      <CheckCircle2 size={13} aria-hidden /> Verified
                    </span>
                  </li>
                  <li className="flex items-center justify-between gap-3">
                    <span className="x-label">Evidence</span>
                    <span className="tabular text-[12.5px] text-ink">{intel.latest.result.evidence.length} records</span>
                  </li>
                  <li className="flex items-center justify-between gap-3">
                    <span className="x-label">Cost</span>
                    <span className="tabular text-[12.5px] text-ink">${(intel.latest.spend.spentUsdCents / 100).toFixed(2)}</span>
                  </li>
                  <li className="flex items-center justify-between gap-3">
                    <span className="x-label">Recorded</span>
                    <span className="tabular text-[12.5px] text-ink-soft">
                      {new Date(intel.latest.result.completedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </li>
                </ul>
                <Link href="/history" className="mt-4 inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-amber hover:text-amber-soft">
                  Search the record <ArrowRight size={12} aria-hidden />
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Controls */}
      <section className="border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
          <p className="x-tag">NS-OPS/02 · CONTROLS</p>
          <h2 className="x-display-1 mt-4 max-w-2xl text-ink">An agent you can audit while it works</h2>
          <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-2">
            {CONTROLS.map((c, i) => (
              <div key={c.title} className="bg-night p-6 lg:p-8">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[15px] font-semibold text-ink">{c.title}</h3>
                  <span className="x-tag">{String(i + 1).padStart(2, "0")}</span>
                </div>
                <p className="mt-2.5 max-w-[44ch] text-[13px] leading-relaxed text-ink-soft">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Telegram relay */}
      <section className="border-b border-edge bg-panel/40">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_320px] lg:items-center">
          <div>
            <p className="x-tag">NS-OPS/03 · RELAY</p>
            <h2 className="x-display-2 mt-4 max-w-[24ch] text-ink">The same engine answers on Telegram</h2>
            <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-soft">
              The web console and the Telegram bot share one store, one engine and one ledger. Send a goal from your
              phone and it runs through the same pipeline, the same ceilings and the same verification. Watch alerts
              arrive in chat with the finding attached, exactly once.
            </p>
          </div>
          <div className="rounded-lg border border-edge bg-panel p-5">
            <a
              href="https://t.me/nightshiftagent_bot"
              className="text-[14px] font-medium text-amber underline decoration-amber/40 underline-offset-4 transition-colors hover:text-amber-soft"
            >
              @nightshiftagent_bot
            </a>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
              The production bot of this workspace. Delivery failures are recorded and retried until confirmed, never silently dropped.
            </p>
          </div>
        </div>
      </section>

      {/* Closing */}
      <section>
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
          <h2 className="x-display-1 max-w-[30ch] text-ink">
            Do not babysit the work. <span className="italic text-amber-soft">Verify it.</span>
          </h2>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/console" className="btn-primary !min-h-11">
              Enter the workspace
              <ArrowRight size={14} aria-hidden />
            </Link>
            <Link href="/watch" className="btn-quiet !min-h-11">
              See Protocol Watch
            </Link>
          </div>
          <p className="x-tag mt-10">
            NIGHTSHIFT · NEON/POSTGRES · TELEGRAM RELAY · READ-ONLY VERIFICATION RPC
          </p>
        </div>
      </section>
    </div>
  );
}
