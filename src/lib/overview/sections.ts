/**
 * Overview section builders — pure functions over already-fetched, caller-
 * projected records, each executed inside `runSection`.
 *
 * The isolation contract: a section that cannot be built fails ALONE. The
 * recurring Overview failure was one malformed persisted record throwing in a
 * shared `.map()` during the server render, which killed the ENTIRE page into
 * the route error boundary ("This view hit an unexpected error") — and it
 * recurred because nothing bounded the blast radius of one bad record. The
 * store layer now normalizes shape-drifted records, and this layer bounds the
 * blast radius of anything the normalization cannot anticipate: the page
 * renders the honest failure for the one broken section and every other
 * section still renders.
 *
 * Nothing here synthesizes data: empty inputs produce honest empty sections,
 * never placeholder activity.
 */

import { activityTitle } from "@/lib/terminal/activity";
// money must come from the shared server-safe module: importing a value from
// a "use client" module into server code yields an opaque reference that
// throws when called during SSR (see src/lib/ui/format.ts).
import { money } from "@/lib/ui/format";
import type { DeskInvestigationSummary } from "@/lib/desk/types";
import type { InvestigationSummary } from "@/lib/assurance/types";
import type { TaskRecord } from "@/lib/engine/types";
import type { BuyerJobView } from "@/lib/acp/buyer";
import type { CommerceJob } from "@/lib/commerce/types";

export type SectionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Run one section's builder; a throw becomes that section's failure, alone. */
export function runSection<T>(build: () => T): SectionResult<T> {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    // The message stays server-side-honest; the page renders it without a
    // stack trace (raw internals never reach the user).
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
/* Attention required                                                  */
/* ------------------------------------------------------------------ */

export interface AttentionItem {
  href: string;
  label: string;
  detail: string;
  tone: "amber" | "teal";
}

const TASK_RUNNING = new Set(["created", "planning", "executing", "verifying"]);

const STALE_COLLECTING_MS = 48 * 60 * 60 * 1000;

export interface AttentionInput {
  tasks: TaskRecord[];
  assurance: InvestigationSummary[];
  desk: DeskInvestigationSummary[];
  buyerViews: BuyerJobView[];
  now: number;
}

export function buildAttention(input: AttentionInput): AttentionItem[] {
  const attention: AttentionItem[] = [];

  // Pending decisions: runs parked at the approval gate.
  for (const t of input.tasks) {
    if (t.state === "awaiting_approval" && t.goal) {
      attention.push({
        href: `/activity/${t.id}`,
        label: activityTitle(t),
        detail: "A plan is waiting for your approval before anything is spent.",
        tone: "amber",
      });
    }
  }

  // Decisions to review: settlement files assessed as HOLD or ESCALATE.
  for (const a of input.assurance) {
    if (a.decision === "HOLD" || a.decision === "ESCALATE") {
      attention.push({
        href: `/assurance/${a.id}`,
        label: `${a.reference} · ${a.counterparty || "counterparty not recorded"}`,
        detail: `The assessment returned ${a.decision} — review the decision before settling.`,
        tone: "amber",
      });
    }
  }

  // Investigations still running long after a normal pre-flight completes —
  // worth opening, not invented: the file really is older than two days
  // without reaching a report.
  for (const d of input.desk) {
    const started = Date.parse(d.createdAt);
    if (d.status === "collecting" && Number.isFinite(started) && input.now - started > STALE_COLLECTING_MS) {
      attention.push({
        href: `/desk/${d.id}`,
        label: `${d.reference} · ${d.subject}`,
        detail: "This file has been investigating for more than two days — check what the runs came back with.",
        tone: "teal",
      });
    }
  }

  // Outstanding buyer/provider actions on the caller's own purchases.
  for (const view of input.buyerViews) {
    if (view.action === "fund" || view.action === "review") {
      attention.push({
        href: "/buyer",
        label: `${view.buyer.offering} · ${view.buyer.key}`,
        detail:
          view.action === "fund"
            ? "Your request has a provider price waiting — review and fund it from the Buyer Desk."
            : "A deliverable is ready for your review — accept or reject it from the Buyer Desk.",
        tone: view.action === "fund" ? "amber" : "teal",
      });
    }
  }

  return attention.slice(0, 6);
}

/* ------------------------------------------------------------------ */
/* Your workspace                                                      */
/* ------------------------------------------------------------------ */

export interface WorkspaceBlock {
  key: "desk" | "assurance" | "buyer";
  label: string;
  headline: string;
  detail: string;
  href: string;
  empty: boolean;
}

export interface WorkspaceInput {
  desk: DeskInvestigationSummary[];
  assurance: InvestigationSummary[];
  buyerViews: BuyerJobView[];
  commerceJobs: CommerceJob[];
  buyerScoped: boolean;
}

export function buildWorkspace(input: WorkspaceInput): WorkspaceBlock[] {
  const blocks: WorkspaceBlock[] = [];

  const collecting = input.desk.filter((d) => d.status === "collecting").length;
  const reported = input.desk.filter((d) => d.status === "reported").length;
  blocks.push({
    key: "desk",
    label: "Deal Desk",
    headline: input.desk.length === 0 ? "No files yet" : `${input.desk.length} file${input.desk.length === 1 ? "" : "s"}`,
    detail:
      input.desk.length === 0
        ? "Open an investigation and its progress appears here."
        : `${collecting} investigating · ${reported} report${reported === 1 ? "" : "s"} ready`,
    href: "/desk",
    empty: input.desk.length === 0,
  });

  const decided = input.assurance.filter((a) => a.decision !== null).length;
  blocks.push({
    key: "assurance",
    label: "Assurance",
    headline: input.assurance.length === 0 ? "No files yet" : `${input.assurance.length} file${input.assurance.length === 1 ? "" : "s"}`,
    detail:
      input.assurance.length === 0
        ? "Open a settlement file and its progress appears here."
        : `${decided} with a decision`,
    href: "/assurance",
    empty: input.assurance.length === 0,
  });

  if (input.buyerScoped) {
    const awaiting = input.buyerViews.filter((v) => v.action === "fund" || v.action === "review").length;
    const purchases = input.commerceJobs.filter((j) => j.status === "fulfilled").length;
    blocks.push({
      key: "buyer",
      label: "Buyer activity",
      headline:
        input.buyerViews.length === 0 && purchases === 0
          ? "No purchases yet"
          : `${input.buyerViews.length + purchases} request${input.buyerViews.length + purchases === 1 ? "" : "s"}`,
      detail:
        input.buyerViews.length === 0 && purchases === 0
          ? "Purchases from the Buyer Desk appear here with their live status."
          : `${awaiting} waiting for you${purchases > 0 ? ` · ${purchases} commerce purchase${purchases === 1 ? "" : "s"}` : ""}`,
      href: "/buyer",
      empty: input.buyerViews.length === 0 && input.commerceJobs.length === 0,
    });
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/* Recent intelligence activity                                        */
/* ------------------------------------------------------------------ */

export interface ActivityRow {
  href: string;
  label: string;
  meta: string;
  ts: number;
}

export interface ActivityInput {
  tasks: TaskRecord[];
  desk: DeskInvestigationSummary[];
  assurance: InvestigationSummary[];
}

const DESK_STATUS_WORD: Record<string, string> = {
  draft: "Draft",
  collecting: "Investigating",
  reported: "Report ready",
};

export function buildActivity(input: ActivityInput): ActivityRow[] {
  const rows: ActivityRow[] = [];

  for (const d of input.desk) {
    rows.push({
      href: `/desk/${d.id}`,
      label: `${d.reference} · ${d.subject}`,
      meta: `${DESK_STATUS_WORD[d.status] ?? d.status}${d.confidence ? ` · ${d.confidence.replaceAll("_", " ")}` : ""}`,
      ts: Date.parse(d.createdAt) || 0,
    });
  }
  for (const a of input.assurance) {
    rows.push({
      href: `/assurance/${a.id}`,
      label: `${a.reference} · ${a.counterparty || "counterparty not recorded"}`,
      meta: a.decision !== null ? `Decision: ${a.decision}` : `${a.status.replaceAll("_", " ")}`,
      ts: Date.parse(a.createdAt) || 0,
    });
  }
  for (const t of input.tasks) {
    if (t.state === "completed" && t.goal) {
      const spent = typeof t.spend?.spentUsdCents === "number" ? t.spend.spentUsdCents : 0;
      rows.push({
        href: `/activity/${t.id}`,
        label: activityTitle(t),
        meta: spent > 0 ? `Answered · ${money(spent)}` : "Answered",
        ts: typeof t.createdAt === "number" ? t.createdAt : 0,
      });
    }
    if ((t.state === "failed" || t.state === "blocked") && t.goal) {
      rows.push({
        href: `/activity/${t.id}`,
        label: activityTitle(t),
        meta: "Failed or blocked — open the run for the recorded reason",
        ts: typeof t.createdAt === "number" ? t.createdAt : 0,
      });
    }
  }

  return rows.sort((a, b) => b.ts - a.ts).slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Quick access                                                        */
/* ------------------------------------------------------------------ */

export interface QuickAction {
  href: string;
  label: string;
  detail: string;
}

/** Deep, state-aware links — never a second navbar. Hidden entirely when the
 *  caller is signed out. */
export function buildQuickAccess(input: { signedIn: boolean; operator: boolean; desk: DeskInvestigationSummary[] }): QuickAction[] {
  if (!input.signedIn) return [];
  const actions: QuickAction[] = [];
  const draft = input.desk.find((d) => d.status === "draft");
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
