/**
 * Overview section builders — pure functions over already-fetched,
 * caller-projected records, each executed inside `runSection`.
 *
 * Two contracts govern this module:
 *
 * 1. ISOLATION — a section that cannot be built fails ALONE (runSection). The
 *    recurring Overview failure was one malformed persisted record throwing
 *    in a shared map during the server render, killing the entire page.
 *
 * 2. HONESTY ABOUT AVAILABILITY — every builder receives `null` for a source
 *    whose read FAILED and an empty array for a source that read fine and
 *    genuinely holds nothing. A null source never renders as zero: the
 *    snapshot shows "n/a" with the source named as unreadable, and the page
 *    shows a retry action. An empty store renders "0 / none" because it is a
 *    fact, not a fallback.
 *
 * Nothing here synthesizes data: no placeholder activity, no invented
 * states, no decorative widgets.
 */

import { activityTitle } from "@/lib/terminal/activity";
// money must come from the shared server-safe module: importing a value from
// a "use client" module into server code yields an opaque reference that
// throws when called during SSR (see src/lib/ui/format.ts).
import { money } from "@/lib/ui/format";
import { deskSubjectLine } from "@/lib/desk/create";
import type { DeskInvestigation } from "@/lib/desk/types";
import type { Investigation } from "@/lib/assurance/types";
import type { TaskRecord } from "@/lib/engine/types";
import type { BuyerJobView } from "@/lib/acp/buyer";
import type { CommerceJob } from "@/lib/commerce/types";

export type SectionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Run one section's builder; a throw becomes that section's failure, alone. */
export function runSection<T>(build: () => T): SectionResult<T> {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}

/** Async variant for sections whose builder awaits further store reads. */
export async function runSectionAsync<T>(build: () => Promise<T>): Promise<SectionResult<T>> {
  try {
    return { ok: true, value: await build() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

const TASK_RUNNING = new Set(["created", "planning", "executing", "verifying"]);
const BUYER_OPEN = new Set(["submitted", "reading", "awaiting_payment", "processing", "review_delivery"]);

export interface OverviewInput {
  /** Caller-projected records. `null` means THE READ FAILED — never an empty store. */
  desk: DeskInvestigation[] | null;
  assurance: Investigation[] | null;
  tasks: TaskRecord[] | null;
  buyerViews: BuyerJobView[] | null;
  commerceJobs: CommerceJob[] | null;
  buyerScoped: boolean;
  operator: boolean;
  signedIn: boolean;
}

const tsOf = (iso: string | number | null | undefined): number => {
  if (typeof iso === "number") return iso;
  if (typeof iso === "string") {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  return 0;
};

/* ------------------------------------------------------------------ */
/* A. Operational snapshot                                             */
/* ------------------------------------------------------------------ */

export interface SnapshotStat {
  key: "active" | "awaiting" | "buyer" | "completed";
  label: string;
  /** null = this stat has no count to show. Why it is null is carried in
   *  `why`: "failed" means the source read FAILED (render "store unreadable",
   *  risk tone — a retry is offered); "wallet-scoped" means this identity
   *  simply has no wallet-scoped source (render "wallet-scoped", faint). */
  count: number | null;
  why: "failed" | "wallet-scoped" | null;
  href: string;
}

const statReady = (sources: unknown[]): boolean => sources.every((s) => s !== null);

export function buildSnapshot(input: OverviewInput): SnapshotStat[] {
  const buyerJobs = input.buyerScoped ? input.buyerViews : null;
  const commerce = input.buyerScoped ? input.commerceJobs : null;

  // In progress: runs executing now, files investigating, buyer jobs in flight.
  const activeSources: unknown[] = [input.tasks, input.desk, input.assurance];
  if (input.buyerScoped) activeSources.push(buyerJobs);
  const activeReady = statReady(activeSources);
  const active = activeReady
    ? (input.tasks as TaskRecord[]).filter((t) => TASK_RUNNING.has(t.state)).length +
      (input.desk as DeskInvestigation[]).filter((d) => d.status === "collecting").length +
      (input.assurance as Investigation[]).filter((a) => a.status === "collecting").length +
      (input.buyerScoped ? (buyerJobs as BuyerJobView[]).filter((v) => BUYER_OPEN.has(v.phase)).length : 0)
    : null;

  // Awaiting you: the approval gate, HOLD/ESCALATE decisions, buyer actions.
  const awaitingSources: unknown[] = [input.tasks, input.assurance];
  if (input.buyerScoped) awaitingSources.push(buyerJobs);
  const awaitingReady = statReady(awaitingSources);
  const awaiting = awaitingReady
    ? (input.tasks as TaskRecord[]).filter((t) => t.state === "awaiting_approval").length +
      (input.assurance as Investigation[]).filter(
        (a) => a.decision?.outcome === "HOLD" || a.decision?.outcome === "ESCALATE",
      ).length +
      (input.buyerScoped ? (buyerJobs as BuyerJobView[]).filter((v) => v.action !== "none").length : 0)
    : null;

  // Completed: everything that reached an outcome.
  const completedSources: unknown[] = [input.tasks, input.desk, input.assurance];
  if (input.buyerScoped) completedSources.push(buyerJobs, commerce);
  const completedReady = statReady(completedSources);
  const completed = completedReady
    ? (input.tasks as TaskRecord[]).filter((t) => t.state === "completed").length +
      (input.desk as DeskInvestigation[]).filter((d) => d.status === "reported").length +
      (input.assurance as Investigation[]).filter((a) => a.decision !== null).length +
      (input.buyerScoped
        ? (buyerJobs as BuyerJobView[]).filter((v) => v.phase === "completed").length +
          (commerce as CommerceJob[]).filter((j) => j.status === "fulfilled").length
        : 0)
    : null;

  // Buyer jobs open: wallet-scoped. A wallet session with a failed read
  // reports "failed"; the operator identity reports the source as absent
  // rather than pretending to have counted.
  const buyerCount = input.buyerScoped
    ? buyerJobs
      ? (buyerJobs as BuyerJobView[]).filter((v) => BUYER_OPEN.has(v.phase)).length
      : null
    : null;
  const buyerWhy: SnapshotStat["why"] = input.buyerScoped ? (buyerJobs ? null : "failed") : "wallet-scoped";

  return [
    { key: "active", label: "In progress", count: active, why: active ? null : activeReady ? null : "failed", href: "#work" },
    { key: "awaiting", label: "Awaiting you", count: awaiting, why: awaiting ? null : awaitingReady ? null : "failed", href: "#work" },
    { key: "buyer", label: "Buyer jobs open", count: buyerCount, why: buyerCount !== null ? null : buyerWhy, href: "/buyer" },
    { key: "completed", label: "Completed", count: completed, why: completed ? null : completedReady ? null : "failed", href: "#recent" },
  ];
}

/* ------------------------------------------------------------------ */
/* B. Work in progress                                                 */
/* ------------------------------------------------------------------ */

export interface WorkRow {
  href: string;
  kindLabel: string;
  title: string;
  stateLabel: string;
  nextAction: string;
  awaiting: boolean;
  updatedTs: number;
}

const STALE_COLLECTING_MS = 48 * 60 * 60 * 1000;

export function buildWorkInProgress(input: OverviewInput, now: number): WorkRow[] {
  const rows: WorkRow[] = [];

  for (const t of input.tasks ?? []) {
    if (t.state === "awaiting_approval" && t.goal) {
      rows.push({
        href: `/activity/${t.id}`,
        kindLabel: "Run",
        title: activityTitle(t),
        stateLabel: "Awaiting approval",
        nextAction: "Review and approve the plan before anything is spent",
        awaiting: true,
        updatedTs: tsOf(t.updatedAt),
      });
    } else if (TASK_RUNNING.has(t.state) && t.goal) {
      rows.push({
        href: `/activity/${t.id}`,
        kindLabel: "Run",
        title: activityTitle(t),
        stateLabel: "Executing",
        nextAction: "",
        awaiting: false,
        updatedTs: tsOf(t.updatedAt),
      });
    }
  }

  for (const d of input.desk ?? []) {
    const opened = tsOf(d.createdAt);
    if (d.status === "collecting") {
      const stale = now - opened > STALE_COLLECTING_MS;
      rows.push({
        href: `/desk/${d.id}`,
        kindLabel: "Deal Desk",
        title: `${d.reference} · ${deskSubjectLine(d)}`,
        stateLabel: stale ? "Investigating — longer than usual" : "Investigating",
        nextAction: stale ? "Open the file and check what the runs came back with" : "",
        awaiting: false,
        updatedTs: tsOf(d.updatedAt) || opened,
      });
    } else if (d.status === "draft") {
      rows.push({
        href: `/desk/${d.id}`,
        kindLabel: "Deal Desk",
        title: `${d.reference} · ${deskSubjectLine(d)}`,
        stateLabel: "Draft — not run yet",
        nextAction: "Run the investigation when you are ready",
        awaiting: true,
        updatedTs: tsOf(d.updatedAt) || opened,
      });
    }
  }

  for (const a of input.assurance ?? []) {
    const opened = tsOf(a.createdAt);
    const updated = tsOf(a.updatedAt) || opened;
    if (a.decision?.outcome === "HOLD" || a.decision?.outcome === "ESCALATE") {
      rows.push({
        href: `/assurance/${a.id}`,
        kindLabel: "Assurance",
        title: `${a.reference} · ${a.counterparty?.legalName || "counterparty not recorded"}`,
        stateLabel: `Assessed — ${a.decision.outcome}`,
        nextAction: `Review the ${a.decision.outcome} decision before settling`,
        awaiting: true,
        updatedTs: updated,
      });
    } else if (a.status === "collecting") {
      rows.push({
        href: `/assurance/${a.id}`,
        kindLabel: "Assurance",
        title: `${a.reference} · ${a.counterparty?.legalName || "counterparty not recorded"}`,
        stateLabel: "Verifying",
        nextAction: "",
        awaiting: false,
        updatedTs: updated,
      });
    }
  }

  for (const v of input.buyerViews ?? []) {
    if (!BUYER_OPEN.has(v.phase)) continue;
    rows.push({
      href: "/buyer",
      kindLabel: "Buyer job",
      title: `${v.buyer.offering} · ${v.buyer.key}`,
      stateLabel: v.phaseLabel,
      nextAction:
        v.action === "fund"
          ? "Review the provider price and fund the escrow"
          : v.action === "review"
            ? "Review the deliverable and release or reject"
            : "",
      awaiting: v.action !== "none",
      updatedTs: tsOf(v.buyer.updatedAt) || tsOf(v.buyer.createdAt),
    });
  }

  return rows.sort((a, b) => b.updatedTs - a.updatedTs).slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* C. Recent activity                                                  */
/* ------------------------------------------------------------------ */

export interface ActivityRow {
  href: string;
  kindLabel: string;
  title: string;
  meta: string;
  ts: number;
  failed: boolean;
}

export function buildRecentActivity(input: OverviewInput): ActivityRow[] {
  const rows: ActivityRow[] = [];

  for (const d of input.desk ?? []) {
    if (d.status !== "reported") continue;
    const confidence = d.report?.confidence ? ` · ${d.report.confidence.replaceAll("_", " ")}` : "";
    rows.push({
      href: `/desk/${d.id}`,
      kindLabel: "Deal Desk",
      title: `${d.reference} · ${deskSubjectLine(d)}`,
      meta: `Report ready${confidence}`,
      ts: tsOf(d.updatedAt) || tsOf(d.createdAt),
      failed: false,
    });
  }
  for (const a of input.assurance ?? []) {
    if (a.decision === null) continue;
    rows.push({
      href: `/assurance/${a.id}`,
      kindLabel: "Assurance",
      title: `${a.reference} · ${a.counterparty?.legalName || "counterparty not recorded"}`,
      meta: `Decision: ${a.decision.outcome}`,
      ts: tsOf(a.updatedAt) || tsOf(a.createdAt),
      failed: a.decision.outcome === "ESCALATE",
    });
  }
  for (const t of input.tasks ?? []) {
    if (t.state === "completed" && t.goal) {
      const spent = typeof t.spend?.spentUsdCents === "number" ? t.spend.spentUsdCents : 0;
      rows.push({
        href: `/activity/${t.id}`,
        kindLabel: "Run",
        title: activityTitle(t),
        meta: spent > 0 ? `Answered · ${money(spent)}` : "Answered",
        ts: tsOf(t.createdAt),
        failed: false,
      });
    } else if ((t.state === "failed" || t.state === "blocked") && t.goal) {
      rows.push({
        href: `/activity/${t.id}`,
        kindLabel: "Run",
        title: activityTitle(t),
        meta: "Failed — open the run for the recorded reason",
        ts: tsOf(t.createdAt),
        failed: true,
      });
    }
  }
  for (const v of input.buyerViews ?? []) {
    if (v.phase !== "completed" && v.phase !== "failed" && v.phase !== "rejected" && v.phase !== "expired") continue;
    rows.push({
      href: "/buyer",
      kindLabel: "Buyer job",
      title: `${v.buyer.offering} · ${v.buyer.key}`,
      meta: v.phaseLabel,
      ts: tsOf(v.buyer.updatedAt) || tsOf(v.buyer.createdAt),
      failed: v.phase === "failed" || v.phase === "rejected" || v.phase === "expired",
    });
  }
  for (const j of input.commerceJobs ?? []) {
    rows.push({
      href: "/buyer",
      kindLabel: "Commerce",
      title: `${j.offeringId} · ${j.section.replaceAll("_", " ")}`,
      meta: j.status === "fulfilled" ? `Delivered · ${money(j.priceUsdCents)}` : "Failed",
      ts: tsOf(j.updatedAt) || tsOf(j.createdAt),
      failed: j.status !== "fulfilled",
    });
  }

  return rows.sort((a, b) => b.ts - a.ts).slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* D. Network status                                                   */
/* ------------------------------------------------------------------ */

export interface NetworkItem {
  label: string;
  configured: boolean;
  note: string;
}

/**
 * CONFIGURATION facts only — never live network statistics, never probe
 * counts, nothing that could drift into fabrication. What is configured is
 * checkable in one place and true for every visitor; the page never makes
 * the user wait on a health roundtrip (probe caches exist for /api/status,
 * but Overview renders on store reads alone).
 */
export function buildNetworkStatus(): NetworkItem[] {
  const configured = (key: string) => Boolean(process.env[key]);
  return [
    {
      label: "Telegraph settle rail",
      configured: configured("TELEGRAPH_EVM_PRIVATE_KEY"),
      note: "operator payer wallet for provider settlements",
    },
    {
      label: "Telegram intake",
      configured: configured("TELEGRAM_BOT_TOKEN"),
      note: "asks by message, same engine as the web",
    },
    {
      label: "Agent commerce (ACP)",
      configured: configured("ACP_ENABLED"),
      note: "programmatic buyer/provider job rail",
    },
    {
      label: "Base RPC",
      configured: true,
      note: "public Base endpoint with the engine's bundled fallback",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Quick access                                                        */
/* ------------------------------------------------------------------ */

export interface QuickAction {
  href: string;
  label: string;
  detail: string;
}

/** Deep, state-aware links — never a second navbar. */
export function buildQuickAccess(input: {
  signedIn: boolean;
  operator: boolean;
  desk: DeskInvestigation[] | null;
}): QuickAction[] {
  if (!input.signedIn) return [];
  const actions: QuickAction[] = [];
  const draft = (input.desk ?? []).find((d) => d.status === "draft");
  if (draft) {
    actions.push({
      href: `/desk/${draft.id}`,
      label: `Resume the draft ${draft.reference}`,
      detail: "This file was opened but never run.",
    });
  }
  actions.push({
    href: "/desk/new",
    label: "Open a new Deal Desk investigation",
    detail: "Guided forms straight into the workflows.",
  });
  actions.push({
    href: "/history",
    label: "Full run history",
    detail: "Every ask and file the stores hold, newest first.",
  });
  if (input.operator) {
    actions.push({
      href: "/console",
      label: "Operator console",
      detail: "Approvals, watches and the spend ledger.",
    });
  }
  return actions;
}
