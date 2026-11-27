import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ArrowRight, CircleAlert, ShieldCheck } from "lucide-react";

import { callerIdentity } from "@/lib/api/auth";
import { investigationsForCaller, tasksForCaller } from "@/lib/api/public";
import { readBounded } from "@/lib/api/bounded-read";
import { listDeskInvestigations, summarizeDesk } from "@/lib/desk/store";
import { listInvestigations, summarize } from "@/lib/assurance/store";
import { listTasks } from "@/lib/engine/store";
import { buildBuyerJobView, listBuyerJobs } from "@/lib/acp/buyer";
import { listCommerceJobs } from "@/lib/commerce/store";
import {
  buildActivity,
  buildAttention,
  buildQuickAccess,
  buildWorkspace,
  runSection,
  runSectionAsync,
  type ActivityRow,
  type AttentionItem,
  type QuickAction,
  type SectionResult,
  type WorkspaceBlock,
} from "@/lib/overview/sections";
import { WalletSignIn } from "@/components/wallet-sign-in";

export const metadata: Metadata = {
  title: "Overview",
  description:
    "The command centre: what needs your decision, what each workspace holds, and what came back recently.",
};

export const dynamic = "force-dynamic";

/**
 * The Overview destination — NIGHTSHIFT's command centre. It answers three
 * questions, in order:
 *
 *   1. What needs my attention?      — decisions, stalled files, purchases
 *   2. What is happening across my workspace? — Desk / Assurance / Buyer
 *   3. What has happened recently?   — the newest recorded outcomes
 *
 * ROOT-CAUSE NOTE (the recurring "This view hit an unexpected error"): the
 * previous page mapped store records through summary projections with no
 * blast-radius control, so ONE shape-drifted persisted record (a desk file
 * without its evidence ledger, an assurance file saved before its
 * transaction step filled in) threw during the server render and killed the
 * whole page — reproducibly, for every signed-in caller, until the record
 * was removed by hand. Two layers fix that permanently:
 *
 *   1. the desk and assurance stores now normalize legacy records on read
 *      (the same contract the task store's normalizeTaskForDisplay set);
 *   2. every section below is built inside runSection — a section that
 *      still cannot be built fails ALONE, with a retry, and the rest of the
 *      page renders.
 *
 * The page reads the stores directly but through the SAME caller projections
 * the APIs use, so it can never show more than this caller is allowed to see.
 * Nothing is synthesized: empty stores produce honest empty sections.
 */

function SectionFailure({ name, retryHref }: { name: string; retryHref: string }) {
  return (
    <div role="alert" className="mt-8 rounded-xl border border-risk/30 bg-panel px-4 py-4 sm:px-5">
      <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <CircleAlert size={14} aria-hidden className="shrink-0 text-risk" />
        The {name} section could not be read just now.
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
        The records behind this section failed to load — everything else on this page is unaffected, and nothing was
        invented to fill the gap.
      </p>
      <Link href={retryHref} className="btn-quiet mt-3 !min-h-8 !text-[12px]">
        Retry
      </Link>
    </div>
  );
}

function AttentionSection({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-label="Needs your attention" className="mt-8">
      <h2 className="x-label">NEEDS YOUR ATTENTION · {items.length}</h2>
      <ul className="mt-2 divide-y divide-edge rounded-2xl border border-edge bg-panel">
        {items.map((item) => (
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
  );
}

function WorkspaceSection({ blocks }: { blocks: WorkspaceBlock[] }) {
  return (
    <section aria-label="Your workspace" className="mt-8">
      <h2 className="x-label">YOUR WORKSPACE</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {blocks.map((b) => (
          <Link
            key={b.key}
            href={b.href}
            className={`group flex flex-col justify-between rounded-2xl border px-5 py-4 transition-colors ${
              b.empty ? "border-dashed border-edge bg-panel-2 hover:border-edge-strong" : "border-edge bg-panel hover:border-edge-strong"
            }`}
          >
            <span className="min-w-0">
              <span className="text-[12px] font-medium text-ink-soft">{b.label}</span>
              <span className="mt-1.5 block text-[17px] font-semibold leading-snug text-ink">{b.headline}</span>
            </span>
            <span className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[12px] leading-relaxed text-ink-faint">{b.detail}</span>
              <ArrowRight size={13} aria-hidden className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function ActivitySection({ rows }: { rows: ActivityRow[] }) {
  return (
    <section aria-label="Recent intelligence activity" className="mt-8">
      <h2 className="x-label">RECENT INTELLIGENCE ACTIVITY</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">No outcomes recorded yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge rounded-2xl border border-edge bg-panel">
          {rows.map((row) => (
            <li key={`${row.href}-${row.label}`}>
              <Link href={row.href} className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-panel-3">
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                    <ShieldCheck size={14} aria-hidden className="shrink-0 text-ink-faint" />
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-ink-faint">{row.meta}</span>
                </span>
                <span className="tabular shrink-0 text-[11px] text-ink-faint">
                  {row.ts > 0
                    ? new Date(row.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                    : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QuickAccessSection({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section aria-label="Quick access" className="mt-8">
      <h2 className="x-label">QUICK ACCESS</h2>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {actions.map((a) => (
          <Link
            key={a.href + a.label}
            href={a.href}
            className="group flex flex-1 items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-3 transition-colors hover:border-edge-strong sm:max-w-[calc(50%-0.25rem)]"
          >
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-ink">{a.label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-ink-faint">{a.detail}</span>
            </span>
            <ArrowRight size={13} aria-hidden className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
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

  // Every read carries its own deadline. A stalled store degrades this page to
  // an honest partial view within seconds — a hung RSC stream is what showed
  // as an endless loading state until the platform killed it into the error
  // boundary, and that failure class is never allowed here again.
  const STORE_DEADLINE_MS = 8_000;
  const [deskAll, assuranceAll, taskAll, buyerRecords, commerceAll] = await Promise.all([
    readBounded(listDeskInvestigations(), STORE_DEADLINE_MS),
    readBounded(listInvestigations(), STORE_DEADLINE_MS),
    readBounded(listTasks(), STORE_DEADLINE_MS),
    // Wallet-scoped reads only exist for a signed-in wallet; the operator's
    // buyer records are keyed by THEIR address, not the deployment's.
    address !== null ? readBounded(listBuyerJobs(address), STORE_DEADLINE_MS) : Promise.resolve(null),
    address !== null ? readBounded(listCommerceJobs(address), STORE_DEADLINE_MS) : Promise.resolve(null),
  ]);
  const deskReady = deskAll !== null;
  const assuranceReady = assuranceAll !== null;
  const tasksReady = taskAll !== null;
  const storeFailed = !deskReady || !assuranceReady || !tasksReady;

  const desk = deskReady
    ? deskAll.filter((inv) => (operator ? true : address !== null ? inv.owner?.toLowerCase() === address : false)).map(summarizeDesk)
    : [];
  const assurance = assuranceReady ? investigationsForCaller(req, assuranceAll).investigations.map(summarize) : [];
  const tasks = tasksReady ? tasksForCaller(req, taskAll).tasks : [];

  // The buyer views merge each record with the provider's public lifecycle —
  // its own bounded section so a slow or broken provider read cannot take the
  // page down with it.
  const buyerViews = await runSectionAsync(async () => {
    if (!buyerRecords || buyerRecords.length === 0) return [];
    const views = await Promise.all(buyerRecords.slice(0, 20).map((r) => buildBuyerJobView(r)));
    return views;
  });

  const commerceJobs = commerceAll ?? [];

  // Sections are isolated: one broken section renders its own honest failure
  // and retry — it never takes the page down.
  const attention = runSection(() =>
    buildAttention({
      tasks,
      assurance,
      desk,
      buyerViews: buyerViews.ok ? buyerViews.value : [],
      now: Date.now(),
    }),
  );
  const workspace = runSection(() =>
    buildWorkspace({
      desk,
      assurance,
      buyerViews: buyerViews.ok ? buyerViews.value : [],
      commerceJobs,
      buyerScoped: address !== null,
    }),
  );
  const activity = runSection(() => buildActivity({ tasks, desk, assurance }));
  const quickAccess = runSection(() => buildQuickAccess({ signedIn, operator, desk }));

  const nothingAtAll =
    signedIn &&
    deskReady &&
    assuranceReady &&
    tasksReady &&
    desk.length === 0 &&
    assurance.length === 0 &&
    tasks.length === 0 &&
    commerceJobs.length === 0 &&
    (!buyerViews.ok || buyerViews.value.length === 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="max-w-[56ch]">
        <p className="x-eyebrow">Overview</p>
        <h1 className="x-display-1 mt-3 text-balance text-ink">What needs you, what is moving, what came back.</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">
          Decisions waiting on you, the state of each workspace, and the latest recorded outcomes — read from the
          stores, never synthesized.
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

      {attention.ok ? (
        attention.value.length > 0 && signedIn ? (
          <AttentionSection items={attention.value} />
        ) : null
      ) : (
        <SectionFailure name="needs your attention" retryHref="/overview" />
      )}

      {signedIn &&
        (workspace.ok ? (
          <WorkspaceSection blocks={workspace.value} />
        ) : (
          <SectionFailure name="your workspace" retryHref="/overview" />
        ))}

      {signedIn &&
        (activity.ok ? (
          <ActivitySection rows={activity.value} />
        ) : (
          <SectionFailure name="recent intelligence activity" retryHref="/overview" />
        ))}

      {signedIn && (deskReady || assuranceReady || tasksReady) && nothingAtAll && (
        <p className="mt-8 text-[12.5px] leading-relaxed text-ink-faint">
          No files or runs are on record for this wallet yet. When you open an investigation or run an ask, it
          shows up here — and only what actually happened is ever shown.
        </p>
      )}

      {quickAccess.ok ? <QuickAccessSection actions={quickAccess.value} /> : <SectionFailure name="quick access" retryHref="/overview" />}
    </div>
  );
}
