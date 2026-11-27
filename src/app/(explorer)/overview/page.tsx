import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ArrowRight, CircleAlert, FileSearch, ShieldCheck } from "lucide-react";

import { callerIdentity } from "@/lib/api/auth";
import { investigationsForCaller, tasksForCaller } from "@/lib/api/public";
import { readBounded } from "@/lib/api/bounded-read";
import { listDeskInvestigations, summarizeDesk } from "@/lib/desk/store";
import { listInvestigations, summarize } from "@/lib/assurance/store";
import { listTasks } from "@/lib/engine/store";
import { activityTitle } from "@/lib/terminal/activity";
import type { DeskInvestigationSummary } from "@/lib/desk/types";
import type { InvestigationSummary } from "@/lib/assurance/types";
import type { TaskRecord } from "@/lib/engine/types";
import { money } from "@/components/taskParts";
import { WalletSignIn } from "@/components/wallet-sign-in";

export const metadata: Metadata = {
  title: "Overview",
  description:
    "The deployment at a glance: the investigations in motion, what came back, and what is waiting for your decision.",
};

export const dynamic = "force-dynamic";
/**
 * The Overview destination. It shows RECORDS, not navigation: the files and
 * runs that are active, the updates that landed, and anything blocked on the
 * user's decision. The navbar destinations are never re-listed here as
 * shortcut cards, and nothing is synthesized — if the stores hold nothing,
 * the page says so.
 */

type Attention = { href: string; label: string; detail: string; tone: "amber" | "teal" };
type Row = { href: string; label: string; meta: string; ts: number };

const TASK_RUNNING = new Set(["created", "planning", "executing", "verifying"]);

/** DeskStatus in the words a reader needs — no task-run vocabulary borrowed. */
const DESK_STATUS_WORD: Record<string, string> = {
  draft: "Draft",
  collecting: "Investigating",
  reported: "Report ready",
};

function rowTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default async function OverviewPage() {
  // The page reads the stores directly but through the SAME caller projections
  // the APIs use, so it can never show more than this caller is allowed to see.
  const h = await headers();
  const req = new Request("http://nightshift.local/", {
    headers: {
      ...(h.get("cookie") ? { cookie: h.get("cookie") as string } : {}),
      ...(h.get("authorization") ? { authorization: h.get("authorization") as string } : {}),
    },
  });
  const identity = callerIdentity(req);

  let desk: DeskInvestigationSummary[] = [];
  let assurance: InvestigationSummary[] = [];
  let tasks: TaskRecord[] = [];
  // Every read carries its own deadline. A stalled store degrades this page to
  // an honest partial view within seconds — a hung RSC stream is what showed
  // as an endless loading state until the platform killed it into the error
  // boundary, and that failure class is never allowed here again.
  const STORE_DEADLINE_MS = 8_000;
  const [deskAll, assuranceAll, taskAll] = await Promise.all([
    readBounded(listDeskInvestigations(), STORE_DEADLINE_MS),
    readBounded(listInvestigations(), STORE_DEADLINE_MS),
    readBounded(listTasks(), STORE_DEADLINE_MS),
  ]);
  const deskReady = deskAll !== null;
  const assuranceReady = assuranceAll !== null;
  const tasksReady = taskAll !== null;
  const storeFailed = !deskReady || !assuranceReady || !tasksReady;

  desk = deskAll
    ? deskAll
        .filter((inv) =>
          identity.kind === "operator"
            ? true
            : identity.kind === "user"
              ? inv.owner?.toLowerCase() === identity.address
              : false,
        )
        .map(summarizeDesk)
    : [];
  assurance = assuranceAll ? investigationsForCaller(req, assuranceAll).investigations.map(summarize) : [];
  tasks = taskAll ? tasksForCaller(req, taskAll).tasks : [];

  const signedIn = identity.kind === "operator" || identity.kind === "user";

  // Attention: anything whose lifecycle is blocked on this user.
  const attention: Attention[] = [];
  for (const t of tasks) {
    if (t.state === "awaiting_approval" && t.goal) {
      attention.push({
        href: `/activity/${t.id}`,
        label: activityTitle(t),
        detail: "A plan is waiting for your approval before anything is spent.",
        tone: "amber",
      });
    }
  }
  for (const a of assurance) {
    if (a.decision === "HOLD" || a.decision === "ESCALATE") {
      attention.push({
        href: `/assurance/${a.id}`,
        label: `${a.reference} · ${a.counterparty}`,
        detail: `The assessment returned ${a.decision} — review the decision before settling.`,
        tone: "amber",
      });
    }
  }

  // Active: files and runs currently in motion.
  const activeDesk = desk.filter((d) => d.status === "collecting" || d.status === "draft");
  const activeAssurance = assurance.filter((a) => a.status === "draft" || a.status === "collecting");
  const activeTasks = tasks.filter((t) => TASK_RUNNING.has(t.state) && t.goal);

  const active: Row[] = [
    ...activeTasks.map((t) => ({
      href: `/activity/${t.id}`,
      label: activityTitle(t),
      meta: "Ask",
      ts: t.createdAt,
    })),
    ...activeDesk.map((d) => ({
      href: `/desk/${d.id}`,
      label: `${d.reference} · ${d.subject}`,
      meta: DESK_STATUS_WORD[d.status] ?? d.status,
      ts: Date.parse(d.createdAt),
    })),
    ...activeAssurance.map((a) => ({
      href: `/assurance/${a.id}`,
      label: `${a.reference} · ${a.counterparty}`,
      meta: `Settlement file · ${a.dataMode === "demonstration" ? "demonstration" : `$${a.amountUsdc.toLocaleString()}`}`,
      ts: Date.parse(a.createdAt),
    })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8);

  // Updates: records that reached an outcome, newest first.
  const updates: Row[] = [
    ...desk
      .filter((d) => d.status === "reported")
      .map((d) => ({
        href: `/desk/${d.id}`,
        label: `${d.reference} · ${d.subject}`,
        meta: `Report ready · ${d.confidence ? d.confidence.replaceAll("_", " ") : "unrated"}`,
        ts: Date.parse(d.createdAt),
      })),
    ...assurance
      .filter((a) => a.decision !== null)
      .map((a) => ({
        href: `/assurance/${a.id}`,
        label: `${a.reference} · ${a.counterparty}`,
        meta: `Decision: ${a.decision}`,
        ts: Date.parse(a.createdAt),
      })),
    ...tasks
      .filter((t) => t.state === "completed" && t.goal)
      .map((t) => ({
        href: `/activity/${t.id}`,
        label: activityTitle(t),
        meta:
          t.spend.spentUsdCents > 0
            ? `Answered · ${money(t.spend.spentUsdCents)}`
            : "Answered",
        ts: t.createdAt,
      })),
    ...tasks
      .filter((t) => (t.state === "failed" || t.state === "blocked") && t.goal)
      .map((t) => ({
        href: `/activity/${t.id}`,
        label: activityTitle(t),
        meta: "Failed or blocked — open the run for the recorded reason",
        ts: t.createdAt,
      })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8);

  const nothingAtAll =
    signedIn && deskReady && assuranceReady && tasksReady && desk.length === 0 && assurance.length === 0 && tasks.length === 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="max-w-[56ch]">
        <p className="x-eyebrow">Overview</p>
        <h1 className="x-display-1 mt-3 text-balance text-ink">What is in motion, and what needs you.</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">
          Your investigations, their latest outcomes, and anything waiting on your decision — read from the stores,
          never synthesized.
        </p>
      </header>

      {storeFailed && (
        <p role="alert" className="mt-6 rounded-lg border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Some record stores could not be read just now, so what follows may be partial. Nothing is invented to fill
          the gap — retry in a moment.
        </p>
      )}

      {/* Records are personal: signed out, the page carries no record sections
          at all rather than a peek at someone else's (or fixture) data. */}
      {!signedIn && !storeFailed && (
        <div className="mt-6 rounded-2xl border border-edge bg-panel px-6 py-8 sm:px-8">
          <p className="text-[15px] font-semibold text-ink">Your files live behind your wallet.</p>
          <p className="mt-2 max-w-[54ch] text-[13.5px] leading-relaxed text-ink-soft">
            Sign in once with your wallet and this page fills with the investigations you opened, the answers that
            came back, and anything waiting for your approval. Nothing here is estimated or pre-filled.
          </p>
          <div className="mt-5">
            <WalletSignIn />
          </div>
        </div>
      )}

      {signedIn && attention.length > 0 && (
        <section aria-label="Needs your attention" className="mt-8">
          <h2 className="x-label">NEEDS YOUR ATTENTION · {attention.length}</h2>
          <ul className="mt-2 divide-y divide-edge rounded-2xl border border-edge bg-panel">
            {attention.slice(0, 6).map((item) => (
              <li key={`${item.href}-${item.label}`}>
                <Link href={item.href} className="group flex items-start justify-between gap-4 px-5 py-4 transition-colors hover:bg-panel-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                      <CircleAlert size={14} aria-hidden className={item.tone === "amber" ? "shrink-0 text-amber" : "shrink-0 text-teal"} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-soft">{item.detail}</span>
                  </span>
                  <ArrowRight size={14} aria-hidden className="mt-1.5 shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-amber" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {signedIn && (deskReady || assuranceReady || tasksReady) && (
        <>
          <div className="mt-8 grid gap-8 lg:grid-cols-2 lg:gap-6">
            <section aria-label="Active investigations" className="min-w-0">
              <h2 className="x-label">ACTIVE INVESTIGATIONS</h2>
              {active.length === 0 ? (
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">Nothing is running right now.</p>
              ) : (
                <ul className="mt-2 divide-y divide-edge rounded-2xl border border-edge bg-panel">
                  {active.map((row) => (
                    <li key={row.href}>
                      <Link href={row.href} className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-panel-3">
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                            <FileSearch size={14} aria-hidden className="shrink-0 text-ink-faint" />
                            <span className="truncate">{row.label}</span>
                          </span>
                          <span className="mt-0.5 block text-[11.5px] text-ink-faint">{row.meta}</span>
                        </span>
                        <span className="tabular shrink-0 text-[11px] text-ink-faint">{rowTime(row.ts)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Recent updates" className="min-w-0">
              <h2 className="x-label">RECENT UPDATES</h2>
              {updates.length === 0 ? (
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">No outcomes recorded yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-edge rounded-2xl border border-edge bg-panel">
                  {updates.map((row) => (
                    <li key={`${row.href}-${row.label}`}>
                      <Link href={row.href} className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-panel-3">
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                            <ShieldCheck size={14} aria-hidden className="shrink-0 text-ink-faint" />
                            <span className="truncate">{row.label}</span>
                          </span>
                          <span className="mt-0.5 block text-[11.5px] text-ink-faint">{row.meta}</span>
                        </span>
                        <span className="tabular shrink-0 text-[11px] text-ink-faint">{rowTime(row.ts)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {nothingAtAll && (
            <p className="mt-8 text-[12.5px] leading-relaxed text-ink-faint">
              No files or runs are on record for this wallet yet. When you open an investigation or run an ask, it
              shows up here — and only what actually happened is ever shown.
            </p>
          )}
        </>
      )}
    </div>
  );
}
