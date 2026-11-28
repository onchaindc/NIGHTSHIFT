import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ArrowRight, BellRing, CheckCircle2, CircleAlert, Coins, FileText, History, Loader, Plus, ShoppingBag, Terminal } from "lucide-react";

import { callerIdentity } from "@/lib/api/auth";
import { investigationsForCaller, tasksForCaller } from "@/lib/api/public";
import { readBounded } from "@/lib/api/bounded-read";
import { listDeskInvestigations } from "@/lib/desk/store";
import { listInvestigations } from "@/lib/assurance/store";
import { listTasks } from "@/lib/engine/store";
import { buildBuyerJobView, listBuyerJobs } from "@/lib/acp/buyer";
import { listCommerceJobs } from "@/lib/commerce/store";
import { money } from "@/lib/ui/format";
import {
  buildAwaitingBreakdown,
  buildNetworkStatus,
  buildQuickAccess,
  buildRecentActivity,
  buildSnapshot,
  buildSpendSummary,
  buildWorkInProgress,
  runSection,
  runSectionAsync,
  type ActivityRow,
  type AwaitingBreakdown,
  type NetworkItem,
  type QuickAction,
  type SnapshotStat,
  type SpendSummary,
  type WorkRow,
} from "@/lib/overview/sections";
import { WalletSignIn } from "@/components/wallet-sign-in";

export const metadata: Metadata = {
  title: "Overview",
  description:
    "The operational picture: what is running, what waits on you, what came back, and which network services are configured.",
};

export const dynamic = "force-dynamic";

/**
 * The Overview destination — NIGHTSHIFT's operational command centre, in the
 * order a user acts on a room: the snapshot numbers, the work in motion, the
 * quick actions, the outcomes that just landed, the network that does the
 * work. Actions before outcomes on every screen size.
 *
 * DATA AVAILABILITY IS NEVER FAKED. Each store read is bounded and its
 * outcome is carried separately from its content: a FAILED read (deadline,
 * rejection) reaches the sections as `null` and renders "n/a" with a retry —
 * never 0, never an empty panel pretending the workspace is empty. A read
 * that succeeded and returned nothing renders an honest "0 / none", because
 * an empty workspace and an unreadable one are different truths. The 20s
 * deadline supersedes the original 8s: cold serverless instances spend their
 * first seconds resolving the database and migrating, and the old deadline
 * expired inside that window — which is exactly what produced the persistent
 * partial-store banner against a healthy database. The instrumentation hook
 * now warms the database before the first request, so warm reads answer in
 * well under a second and the deadline only bounds pathological cases.
 */

const STORE_DEADLINE_MS = 20_000;

const timeOf = (ts: number) =>
  ts > 0 ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="x-label">{label}</h2>
      {typeof count === "number" && <span className="tabular text-[11px] text-ink-faint">{count}</span>}
    </div>
  );
}

function FailureNote({ what }: { what: string }) {
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2">
      <p className="text-[12px] text-risk">
        <CircleAlert size={12} aria-hidden className="mr-1.5 inline align-[-1px]" />
        The {what} could not be read just now — shown as unavailable, not as empty.
      </p>
      <Link href="/overview" className="shrink-0 text-[11.5px] font-medium text-risk underline underline-offset-2 hover:no-underline">
        Retry
      </Link>
    </div>
  );
}

const SNAPSHOT_ICONS: Record<string, typeof Loader> = {
  active: Loader,
  awaiting: BellRing,
  buyer: ShoppingBag,
  completed: CheckCircle2,
};

function SnapshotStrip({ stats, failedNames }: { stats: SnapshotStat[]; failedNames: Set<string> }) {
  return (
    <section aria-label="Operational snapshot" className="mt-4">
      <h2 className="x-label">OPERATIONAL SNAPSHOT</h2>
      <div className="relative mt-2 overflow-hidden rounded-2xl border border-edge bg-panel shadow-sm">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal/40 to-transparent" />
        <div className="grid grid-cols-2 sm:grid-cols-4 sm:divide-x sm:divide-edge">
          {stats.map((s) => {
            const Icon = SNAPSHOT_ICONS[s.key] ?? Loader;
            const hot = s.count !== null && s.count > 0;
            return (
              <Link
                key={s.key}
                href={s.href}
                className="group px-4 py-3.5 transition-colors hover:bg-panel-3 max-sm:odd:border-r max-sm:odd:border-edge max-sm:[&:nth-child(-n+2)]:border-b max-sm:[&:nth-child(-n+2)]:border-edge"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className={`tabular text-[26px] font-semibold leading-none tracking-tight ${s.count === null ? "text-ink-faint" : "text-ink"}`}>
                    {s.count === null ? "n/a" : s.count}
                  </p>
                  <Icon
                    size={15}
                    strokeWidth={1.8}
                    aria-hidden
                    className={`mt-0.5 shrink-0 transition-colors ${
                      hot ? (s.key === "awaiting" ? "text-amber" : "text-teal") : "text-ink-faint"
                    }`}
                  />
                </div>
                <p className="mt-2 text-[11.5px] font-medium text-ink-soft">{s.label}</p>
                <p className={`mt-0.5 text-[10px] leading-tight ${s.why === "failed" ? "text-risk" : "text-ink-faint"}`}>
                  {s.why === "failed" ? "store unreadable" : s.why === "wallet-scoped" ? "wallet-scoped source" : s.key === "buyer" ? "open jobs" : "records"}
                </p>
              </Link>
            );
          })}
        </div>
      </div>
      {failedNames.size > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Unreadable sources: {[...failedNames].join(", ")}. Unavailable is shown as n/a — never as zero.
        </p>
      )}
    </section>
  );
}

function WorkSection({
  rows,
  failed,
  breakdown,
}: {
  rows: WorkRow[];
  failed: boolean;
  breakdown: AwaitingBreakdown | null;
}) {
  // The stat's "Awaiting you" spelled out: a number that says 9 must be
  // findable in the list beneath it, or the page is lying twice.
  const parts: string[] = [];
  if (breakdown) {
    if (breakdown.runs > 0) parts.push(`${breakdown.runs} run${breakdown.runs === 1 ? "" : "s"} on the approval gate`);
    if (breakdown.decisions > 0)
      parts.push(`${breakdown.decisions} file decision${breakdown.decisions === 1 ? "" : "s"} to review`);
    if (breakdown.buyer > 0) parts.push(`${breakdown.buyer} buyer action${breakdown.buyer === 1 ? "" : "s"}`);
  }
  return (
    <section aria-label="Work in progress" id="work" className="mt-6 scroll-mt-16">
      <SectionHeader label="WORK IN PROGRESS" count={failed ? undefined : rows.length} />
      {!failed && parts.length > 0 && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-soft">Awaiting you: {parts.join(" · ")}.</p>
      )}
      {failed ? (
        <FailureNote what="work-in-progress sources" />
      ) : rows.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-faint">Nothing is executing or waiting on you right now.</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge rounded-xl border border-edge bg-panel">
          {rows.map((r) => (
            <li key={`${r.kindLabel}-${r.href}-${r.title}`}>
              <Link href={r.href} className="group block px-4 py-2.5 transition-colors hover:bg-panel-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 rounded border border-edge bg-panel-2 px-1.5 py-px text-[10px] font-medium text-ink-faint">
                      {r.kindLabel}
                    </span>
                    <span className="truncate text-[13px] font-medium text-ink">{r.title}</span>
                    {r.awaiting && <span className="shrink-0 rounded bg-amber/15 px-1.5 py-px text-[10px] font-semibold text-amber">your action</span>}
                  </span>
                  <span className="tabular shrink-0 text-[10.5px] text-ink-faint">{timeOf(r.updatedTs)}</span>
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-3 pl-0.5">
                  <span className="text-[11.5px] text-ink-faint">{r.stateLabel}</span>
                  {r.nextAction && <span className="truncate text-right text-[11.5px] font-medium text-amber">{r.nextAction}</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentSection({ rows, failed }: { rows: ActivityRow[]; failed: boolean }) {
  return (
    <section aria-label="Recent activity" id="recent" className="mt-6 scroll-mt-16">
      <SectionHeader label="RECENT ACTIVITY" count={failed ? undefined : rows.length} />
      {failed ? (
        <FailureNote what="recent-activity sources" />
      ) : rows.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-faint">No recorded outcomes yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge rounded-xl border border-edge bg-panel">
          {rows.map((r) => (
            <li key={`${r.kindLabel}-${r.href}-${r.ts}`}>
              <Link href={r.href} className="group flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-panel-3">
                <span className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="w-[64px] shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-faint">{r.kindLabel}</span>
                    <span className={`truncate text-[12.5px] font-medium ${r.failed ? "text-risk" : "text-ink"}`}>{r.title}</span>
                  </span>
                  <span className="mt-0.5 block truncate pl-[72px] text-[11px] text-ink-faint">{r.meta}</span>
                </span>
                <span className="tabular shrink-0 text-[10.5px] text-ink-faint">{timeOf(r.ts)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SpendCard({ summary, unreadable }: { summary: SpendSummary | null; unreadable: boolean }) {
  return (
    <section aria-label="Recorded spend" className="mt-6">
      <SectionHeader label="RECORDED SPEND" />
      <div className="mt-2 rounded-xl border border-edge bg-panel px-4 py-3.5">
        {unreadable || !summary ? (
          <p className="text-[12px] leading-relaxed text-ink-faint">
            The run store could not be read just now — spend is shown as unavailable, not as zero.
          </p>
        ) : (
          <>
            <p className="tabular flex items-center gap-2 text-[24px] font-semibold leading-none tracking-tight text-ink">
              <Coins size={15} strokeWidth={1.8} aria-hidden className="text-ink-faint" />
              {money(summary.spentUsdCents)}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              Across {summary.runs} run{summary.runs === 1 ? "" : "s"} that recorded spend, as billed by the engine —
              no estimate. The full ledger lives in{" "}
              <Link href="/activity" className="font-medium text-ink-soft underline underline-offset-2 hover:no-underline">
                activity
              </Link>
              .
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function NetworkSection({ items }: { items: NetworkItem[] }) {
  return (
    <section aria-label="Network status" className="mt-6">
      <SectionHeader label="NETWORK" />
      <ul className="mt-2 grid gap-x-6 gap-y-1.5 rounded-xl border border-edge bg-panel px-4 py-3 sm:grid-cols-2">
        {items.map((n) => (
          <li key={n.label} className="flex items-baseline gap-2 text-[11.5px]">
            <span
              aria-hidden
              className={`mt-1 size-1.5 shrink-0 rounded-full ${n.configured ? "bg-teal" : "bg-edge-strong"}`}
            />
            <span className="min-w-0">
              <span className={`font-medium ${n.configured ? "text-ink" : "text-ink-faint"}`}>{n.label}</span>
              <span className="text-ink-faint"> — {n.configured ? n.note : "not configured on this deployment"}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function quickActionIcon(a: QuickAction): typeof ArrowRight {
  if (a.href === "/desk/new") return Plus;
  if (a.href.startsWith("/desk/")) return FileText;
  if (a.href === "/history") return History;
  if (a.href === "/console") return Terminal;
  if (a.href.startsWith("/buyer")) return ShoppingBag;
  return ArrowRight;
}

function QuickAccessSection({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section aria-label="Quick access" className="mt-6">
      <SectionHeader label="QUICK ACCESS" />
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {actions.map((a) => {
          const Icon = quickActionIcon(a);
          return (
            <Link
              key={a.href + a.label}
              href={a.href}
              className="group flex items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-3.5 py-2.5 transition-colors hover:border-teal/50 hover:bg-panel-3"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-panel-2 text-ink-faint transition-colors group-hover:bg-teal/10 group-hover:text-teal">
                  <Icon size={13} strokeWidth={1.8} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-ink">{a.label}</span>
                  <span className="mt-px block truncate text-[10.5px] text-ink-faint">{a.detail}</span>
                </span>
              </span>
              <ArrowRight size={13} aria-hidden className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default async function OverviewPage() {
  const h = await headers();
  const req = new Request("http://nightshift.local/", {
    headers: {
      ...(h.get("cookie") ? { cookie: h.get("cookie") as string } : {}),
      ...(h.get("authorization") ? { authorization: h.get("authorization") as string } : {}),
    },
  });
  const identity = callerIdentity(req);
  const address = identity.kind === "user" ? identity.address : null;
  const operator = identity.kind === "operator";
  const signedIn = operator || address !== null;

  // Five bounded reads, outcomes carried separately from content. The buyer
  // and commerce stores are wallet-scoped: the operator identity holds no
  // address, so those sources are genuinely absent (distinct from failed).
  const [deskAll, assuranceAll, taskAll, buyerRecords, commerceAll] = await Promise.all([
    readBounded(listDeskInvestigations(), STORE_DEADLINE_MS),
    readBounded(listInvestigations(), STORE_DEADLINE_MS),
    readBounded(listTasks(), STORE_DEADLINE_MS),
    address !== null ? readBounded(listBuyerJobs(address), STORE_DEADLINE_MS) : Promise.resolve(null),
    address !== null ? readBounded(listCommerceJobs(address), STORE_DEADLINE_MS) : Promise.resolve(null),
  ]);

  // Caller projections preserve the failed/empty distinction: a failed read
  // stays null through the projection, an empty one becomes an empty array.
  const desk = deskAll
    ? deskAll.filter((inv) => (operator ? true : address !== null ? inv.owner?.toLowerCase() === address : false))
    : null;
  const assurance = assuranceAll ? investigationsForCaller(req, assuranceAll).investigations : null;
  const tasks = taskAll ? tasksForCaller(req, taskAll).tasks : null;

  const buyerViewsResult = await runSectionAsync(async () => {
    if (!buyerRecords) return null;
    if (buyerRecords.length === 0) return [];
    return Promise.all(buyerRecords.slice(0, 20).map((r) => buildBuyerJobView(r)));
  });
  const buyerViews = buyerViewsResult.ok ? buyerViewsResult.value : null;

  const input = {
    desk,
    assurance,
    tasks,
    buyerViews,
    commerceJobs: commerceAll,
    buyerScoped: address !== null,
    operator,
    signedIn,
  };

  const failedNames = new Set<string>();
  if (desk === null) failedNames.add("Deal Desk store");
  if (assurance === null) failedNames.add("Assurance store");
  if (tasks === null) failedNames.add("Run store");
  if (address !== null && buyerViews === null) failedNames.add("Buyer jobs store");
  if (address !== null && commerceAll === null) failedNames.add("Commerce store");

  // Sections are isolated: one broken section renders its own honest failure
  // and retry — it never takes the page down. A section also reports failure
  // when its SOURCES failed (null inputs), so a dead store can never render
  // as a tidy empty list.
  const snapshot = runSection(() => buildSnapshot(input));
  const work = runSection(() => buildWorkInProgress(input, Date.now()));
  const recent = runSection(() => buildRecentActivity(input));
  const network = runSection(() => buildNetworkStatus());
  const quickAccess = runSection(() => buildQuickAccess({ signedIn, operator, desk }));
  // The awaiting breakdown is only rendered beside the list it explains; a
  // failed run store keeps both the stat and this line honest (never 0).
  const breakdown = tasks !== null ? runSection(() => buildAwaitingBreakdown(input)) : null;
  const spend = tasks !== null ? runSection(() => buildSpendSummary(input)) : null;

  const workSourcesFailed =
    desk === null || tasks === null || assurance === null || (input.buyerScoped && buyerViews === null);
  const recentSourcesFailed = workSourcesFailed || (input.buyerScoped && commerceAll === null);

  const nothingAtAll =
    signedIn &&
    desk !== null &&
    assurance !== null &&
    tasks !== null &&
    desk.length === 0 &&
    assurance.length === 0 &&
    tasks.length === 0 &&
    (input.buyerScoped === false ||
      ((buyerViews ?? []).length === 0 && (input.commerceJobs ?? []).length === 0));

  return (
    <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-9">
      {/* Header with presence: a real title, the honest state line beside it. */}
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <p className="x-label !text-[11px]">OVERVIEW</p>
          <h1 className="x-display-1 mt-2 text-balance text-ink">The operational picture.</h1>
        </div>
        <p className={`pb-1.5 text-[11.5px] ${failedNames.size > 0 ? "text-risk" : "text-ink-faint"}`} role={failedNames.size > 0 ? "status" : undefined}>
          {failedNames.size === 0
            ? signedIn
              ? "All record stores readable"
              : "Sign in to read your records"
            : `${failedNames.size} record ${failedNames.size === 1 ? "store" : "stores"} unreadable — partial view`}
        </p>
      </header>

      {snapshot.ok ? <SnapshotStrip stats={snapshot.value} failedNames={failedNames} /> : <FailureNote what="operational snapshot" />}

      {/* Records are personal: signed out, the page carries no record sections
          at all rather than a peek at someone else's (or fixture) data. */}
      {!signedIn && (
        <div className="mt-4 rounded-xl border border-edge bg-panel px-5 py-5 sm:px-6">
          <p className="text-[13.5px] font-semibold text-ink">Your files live behind your wallet.</p>
          <p className="mt-1.5 max-w-[54ch] text-[12.5px] leading-relaxed text-ink-soft">
            Sign in once and this page fills with the investigations you opened, the answers that came back, and
            anything waiting for your approval. Nothing is estimated or pre-filled.
          </p>
          <div className="mt-4">
            <WalletSignIn />
          </div>
        </div>
      )}

      {/* Two-sided on desktop: actions left (work, quick access), record and
          context right (spend, outcomes, network). Single column on small
          screens keeps the same order. */}
      <div className="mt-2 grid gap-8 lg:grid-cols-[minmax(0,1fr)_312px] lg:gap-10">
        <div className="min-w-0">
          {signedIn &&
            (work.ok && !workSourcesFailed ? (
              <WorkSection rows={work.value} failed={false} breakdown={breakdown && breakdown.ok ? breakdown.value : null} />
            ) : (
              <WorkSection rows={[]} failed breakdown={null} />
            ))}

          {/* Actions before outcomes: the quick tiles sit directly under the work
              list, so the two things a user acts on are the first two screens. */}
          {quickAccess.ok ? <QuickAccessSection actions={quickAccess.value} /> : <FailureNote what="quick access" />}

          {signedIn && nothingAtAll && (
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
              No files or runs are on record for this wallet yet. When you open an investigation or run an ask, it shows
              up here — and only what actually happened is ever shown.
            </p>
          )}
        </div>

        <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          {signedIn && <SpendCard summary={spend && spend.ok ? spend.value : null} unreadable={tasks === null} />}
          {signedIn &&
            (recent.ok && !recentSourcesFailed ? (
              <RecentSection rows={recent.value} failed={false} />
            ) : (
              <RecentSection rows={[]} failed />
            ))}
          {network.ok ? <NetworkSection items={network.value} /> : <FailureNote what="network status" />}
        </aside>
      </div>
    </div>
  );
}
