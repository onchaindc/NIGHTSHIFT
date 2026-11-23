import type { PlanStep, TaskRecord } from "@/lib/engine/types";
import type { IndexDeskReport } from "./report";

/**
 * Pure presentation logic for the Index Reconstitution Desk.
 *
 * The desk's critical defects were all view-layer: a spend header reading the
 * wrong shape, polling that never stopped on a redacted completion, approval
 * links pointing at retired routes, and custom weights silently degraded to
 * zero. Keeping those decisions here (instead of inside JSX) makes each one
 * directly testable without a DOM.
 */

/* ------------------------------------------------------------------ */
/* Dimension labels                                                    */
/* ------------------------------------------------------------------ */

/** State label + tone shared by the desk and Activity. */
export const DESK_STATE_META: Record<string, { label: string; tone: string }> = {
  created: { label: "Starting", tone: "border-edge bg-panel-2 text-ink-soft" },
  planning: { label: "Planning", tone: "border-edge bg-panel-2 text-ink-soft" },
  executing: { label: "Investigating", tone: "border-teal/30 bg-teal/5 text-teal" },
  verifying: { label: "Verifying", tone: "border-teal/30 bg-teal/5 text-teal" },
  awaiting_approval: { label: "Awaiting approval", tone: "border-amber/40 bg-amber-soft/50 text-amber-deep" },
  completed: { label: "Completed", tone: "border-teal/30 bg-teal/5 text-teal" },
  rejected: { label: "Rejected", tone: "border-edge bg-panel-2 text-ink-faint" },
  blocked: { label: "Blocked", tone: "border-risk/40 bg-risk/5 text-risk" },
  failed: { label: "Failed", tone: "border-risk/40 bg-risk/5 text-risk" },
};

export const DIMENSION_LABELS: Record<string, string> = {
  registry: "Issuer registry",
  price: "USD price",
  supply: "Total supply",
  liquidity: "DEX liquidity",
  holders: "Holder count",
  filings: "Regulatory filings",
};

/** Human label for a dimension key; never render the raw key in the UI. */
export function dimensionLabel(key: string): string {
  return DIMENSION_LABELS[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Definition inputs                                                   */
/* ------------------------------------------------------------------ */

export type CustomWeightsResult =
  | { ok: true; weights: Record<string, number> }
  | { ok: false; error: string };

/**
 * Parse the custom-weight textarea. Every failure is reported: malformed
 * pairs, non-numeric values, zero/out-of-range weights, duplicates, symbols
 * outside the universe and assets left without a weight. Nothing is silently
 * dropped or coerced to zero.
 */
export function parseCustomWeights(raw: string, symbols: string[]): CustomWeightsResult {
  const entries = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return {
      ok: false,
      error: 'Custom weighting needs weights as "SYMBOL: percent" pairs (comma or newline separated).',
    };
  }

  const weights: Record<string, number> = {};
  for (const entry of entries) {
    const match = /^([A-Za-z0-9]{1,15})\s*[:=]\s*(.+)$/.exec(entry);
    if (!match) {
      return { ok: false, error: `"${entry}" is not a SYMBOL: percent pair.` };
    }
    const symbol = match[1].toUpperCase();
    const rawValue = match[2].trim();
    if (!/^\d+(\.\d+)?$/.test(rawValue)) {
      return { ok: false, error: `The weight for ${symbol} must be a number between 0 and 100.` };
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      return { ok: false, error: `The weight for ${symbol} must be greater than 0 and at most 100.` };
    }
    if (weights[symbol] !== undefined) {
      return { ok: false, error: `The weight for ${symbol} is declared twice.` };
    }
    weights[symbol] = value;
  }

  const universe = new Set(symbols.map((s) => s.toUpperCase()));
  const unknown = Object.keys(weights).filter((s) => !universe.has(s));
  if (unknown.length > 0) {
    return { ok: false, error: `A weight is declared for ${unknown.join(", ")}, which is not in the universe.` };
  }
  const missing = [...universe].filter((s) => weights[s] === undefined);
  if (missing.length > 0) {
    return { ok: false, error: `Every asset needs a weight; missing ${missing.join(", ")}.` };
  }
  return { ok: true, weights };
}

export type SpendLimitResult = { ok: true; cents?: number } | { ok: false; error: string };

/** Parse the "maximum spend" field as USD dollars; the API takes cents. */
export function parseSpendLimitUsd(raw: string): SpendLimitResult {
  const value = raw.trim();
  if (!value) return { ok: true };
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return { ok: false, error: "Enter a maximum spend in dollars, for example 0.30." };
  }
  const dollars = Number(value);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return { ok: false, error: "The maximum spend must be greater than zero." };
  }
  return { ok: true, cents: Math.round(dollars * 100) };
}

/* ------------------------------------------------------------------ */
/* Task snapshot + polling                                             */
/* ------------------------------------------------------------------ */

export type DeskTerminalState = "completed" | "rejected" | "blocked" | "failed" | "awaiting_approval";

export interface DeskEvidenceDimension {
  dimension: string;
  signalHash?: string;
  receiptHash?: string;
  costUsdCents?: number;
  value?: unknown;
}

export interface DeskEvidence {
  kind: "index_asset_finding";
  symbol: string;
  totalCostUsdCents: number;
  dimensions: DeskEvidenceDimension[];
}

export interface DeskTaskSnapshot {
  state: string | null;
  error: string | null;
  redacted: boolean;
  /** Actual spend from the task record (`task.spend.spentUsdCents`). */
  spendUsdCents: number | null;
  report: IndexDeskReport | null;
  evidence: DeskEvidence[];
  /** Latest operator-visible event messages, oldest → newest. */
  progress: string[];
  terminal: DeskTerminalState | null;
  /** True once the client should stop asking the server for updates. */
  stopPolling: boolean;
  /** Operator-only execution plan (public projections strip it). */
  plan: PlanStep[] | null;
}

const TERMINAL: Record<string, DeskTerminalState> = {
  completed: "completed",
  rejected: "rejected",
  blocked: "blocked",
  failed: "failed",
  awaiting_approval: "awaiting_approval",
};

interface RawDeskTask {
  state?: string;
  error?: string | null;
  plan?: PlanStep[] | null;
  events?: Array<{ message?: unknown; type?: unknown }>;
  spend?: { spentUsdCents?: number };
  result?: { indexDeskReport?: unknown; evidence?: unknown } | null;
}

/**
 * Normalize one GET /api/tasks/:id response.
 *
 * - Spend is read from the task record, with the legacy top-level field as a
 *   fallback, so the header cannot silently show $0.00.
 * - Polling stops on EVERY terminal state and on a redacted response: an
 *   anonymous caller's completed task carries no report, which previously
 *   looked like "still running" forever.
 */
export function deskSnapshot(body: unknown): DeskTaskSnapshot {
  const payload = (body ?? {}) as { task?: RawDeskTask | null; redacted?: boolean; spend?: { spentUsdCents?: number } };
  const task = payload.task ?? null;
  const redacted = payload.redacted === true;
  const state = task?.state ?? null;
  const terminal = state ? (TERMINAL[state] ?? null) : null;

  const spendUsdCents =
    typeof task?.spend?.spentUsdCents === "number"
      ? task.spend.spentUsdCents
      : typeof payload.spend?.spentUsdCents === "number"
        ? payload.spend.spentUsdCents
        : null;

  const report =
    !redacted && task?.result && typeof task.result.indexDeskReport === "object" && task.result.indexDeskReport !== null
      ? (task.result.indexDeskReport as IndexDeskReport)
      : null;

  const evidence = !redacted && Array.isArray(task?.result?.evidence)
    ? (task!.result!.evidence as unknown[]).filter(
        (e): e is DeskEvidence =>
          typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "index_asset_finding",
      )
    : [];

  const progress: string[] = [];
  if (!redacted && Array.isArray(task?.events)) {
    for (const ev of task!.events!) {
      const message = typeof ev?.message === "string" ? ev.message.trim() : "";
      if (message && progress[progress.length - 1] !== message) progress.push(message);
    }
  }

  const stopPolling = !task || redacted || terminal !== null;

  return {
    state,
    error: !redacted && typeof task?.error === "string" ? task.error : null,
    redacted,
    spendUsdCents,
    report,
    evidence,
    progress: progress.slice(-4),
    terminal,
    stopPolling,
    plan: !redacted && Array.isArray(task?.plan) ? task!.plan! : null,
  };
}

/* ------------------------------------------------------------------ */
/* URL persistence                                                     */
/* ------------------------------------------------------------------ */

/** The `task` query value, accepted only when it looks like a task id. */
export function deskTaskParam(search: string): string | null {
  let id: string | null = null;
  try {
    id = new URLSearchParams(search).get("task");
  } catch {
    return null;
  }
  if (!id) return null;
  return /^[A-Za-z0-9_-]{4,80}$/.test(id) ? id : null;
}

export function deskHrefWithTask(id: string | null): string {
  return id ? `/minds/index-desk?task=${encodeURIComponent(id)}` : "/minds/index-desk";
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

const SIGN_IN_MESSAGE =
  "Operator sign-in is required to approve or reject a paid plan. Sign in below, then approve here.";

/** Strip anything technical or credential-shaped from a server message. */
export function sanitizeDeskMessage(message: string): string {
  return message
    .replace(/\bNIGHTSHIFT_API_TOKEN\b/g, "the operator credential")
    .replace(/\bBearer\s+\S+/gi, "the operator credential")
    .replace(/\bHTTP\s+\d{3}\b/gi, "an error")
    .replace(/\btask\s+[A-Za-z0-9_-]{4,80}\s+not found\b/gi, "that investigation could not be found")
    .trim();
}

/**
 * Turn an API failure into a user-facing message. 401s always become the
 * sign-in instruction (never the token name); validation messages from the
 * server are already written for people, so they pass through sanitized.
 */
export function friendlyDeskError(status: number, message?: string | null): string {
  const raw = (message ?? "").trim();
  if (status === 401 || /authorization required|NIGHTSHIFT_API_TOKEN|operator token/i.test(raw)) {
    return SIGN_IN_MESSAGE;
  }
  if (status === 404) return "That investigation could not be found. Start a new one.";
  if (status === 0) return "The desk could not be reached. Check your connection and try again.";
  if (status === 503) return "Investigation storage is unavailable right now. Nothing was charged.";
  if (status >= 500) return "The desk could not complete that request. Nothing was charged; try again.";
  if (raw) return sanitizeDeskMessage(raw);
  return "The request could not be completed. Nothing was charged; try again.";
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

export interface DeskActivityRow {
  id: string;
  title: string;
  state: string;
  terminal: DeskTerminalState | null;
  spendUsdCents: number;
  createdAt: number;
  href: string;
}

/** Readable title for a desk task's goal ("Reconstitute index "X" …" → X). */
export function deskGoalTitle(goal: string): string {
  const match = /Reconstitute index "([^"]+)"/.exec(goal);
  if (match) return match[1];
  const trimmed = goal.trim();
  return trimmed.length > 0 ? trimmed : "Index investigation";
}

/**
 * Desk rows for Activity. Redacted records (anonymous viewers) carry an empty
 * goal and are omitted rather than shown as an unreadable entry; only tasks
 * with a readable objective and a durable id are listed.
 */
export function deskActivityRows(tasks: TaskRecord[]): DeskActivityRow[] {
  return tasks
    .filter((t) => t.jobType === "index_desk" && t.goal.trim() !== "")
    .map((t) => ({
      id: t.id,
      title: deskGoalTitle(t.goal),
      state: t.state,
      terminal: TERMINAL[t.state] ?? null,
      spendUsdCents: t.spend?.spentUsdCents ?? 0,
      createdAt: t.createdAt,
      href: deskHrefWithTask(t.id),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------------------------------------------ */
/* Missing-dimension display                                           */
/* ------------------------------------------------------------------ */

export interface DisplayMissingDimension {
  key: string;
  scope: "portfolio" | "asset";
  symbol?: string;
  dimension: string;
  reason: string;
}

/** Deduplicate the ledger for display without dropping a distinct reason. */
export function displayMissingDimensions(
  entries: Array<{ scope: "portfolio" | "asset"; symbol?: string; dimension: string; reason: string }>,
): DisplayMissingDimension[] {
  const seen = new Set<string>();
  const out: DisplayMissingDimension[] = [];
  for (const e of entries) {
    const key = `${e.scope}|${e.symbol ?? ""}|${e.dimension}|${e.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, ...e });
  }
  return out;
}
