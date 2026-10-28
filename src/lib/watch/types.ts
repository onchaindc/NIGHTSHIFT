import type { VerificationCriteria } from "@/lib/engine/types";

/**
 * Protocol Watch: configuration and results for monitoring a protocol's
 * legitimate public sources, detecting real changes, investigating them, and
 * delivering a verified report. All source data comes from real fetches; a
 * source that cannot be read is reported as a source error, never invented.
 */

export type SourceType = "github_releases" | "github_commits" | "docs_url" | "discourse_forum" | "rss_feed";

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  github_releases: "GitHub releases",
  github_commits: "GitHub commits",
  docs_url: "Documentation page",
  discourse_forum: "Governance forum (Discourse)",
  rss_feed: "Security feed (RSS/Atom)",
};

export interface WatchSource {
  id: string;
  type: SourceType;
  label: string;
  /** Where to read: "owner/repo", a URL, etc., depending on type. */
  target: string;
}

export interface WatchConfig {
  id: string;
  name: string;
  protocol: string;
  sources: WatchSource[];
  /** Ceiling for the paid investigation step of one check run. */
  spendLimitUsdCents: number;
  /** If true, a paid investigation waits for manual approval first. */
  requiresApprovalForPaid: boolean;
  /** Telegram chat that receives reports; delivery is skipped when absent. */
  telegramChatId?: string | number | null;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  /** Last observed signature per source id; the change detector's key. */
  fingerprints: Record<string, WatchFingerprint>;
}

export interface WatchFingerprint {
  signature: string;
  seenAt: number;
  /** Short human summary of what the signature points at, for the UI. */
  summary?: string;
}

export type FindingKind =
  | "new_release"
  | "new_commits"
  | "content_change"
  | "new_topics"
  | "feed_item"
  | "source_error";

/**
 * Confidence is real, not decorative:
 *  - source-direct: observed in the fetched source data itself.
 *  - cross-checked: paid insight AND fetched source data agree.
 *  - uncertain: paid insight did not clearly agree with the source data.
 */
export type FindingConfidence = "source-direct" | "cross-checked" | "uncertain";

export interface Finding {
  id: string;
  sourceId: string;
  sourceLabel: string;
  kind: FindingKind;
  title: string;
  detail: string;
  url?: string;
  confidence: FindingConfidence;
  /** True when the finding restates something actually present in fetched data. */
  verified: boolean;
  /** Paid insight text, when the Telegraph step contributed one. */
  paidInsight?: string;
  /** Whether the paid insight agreed with the fetched source data. */
  paidInsightAgrees?: boolean;
  detectedAt: number;
}

export interface WatchRunState {
  watchId: string;
  findings: Finding[];
  /** Whether at least one source was read successfully in this run. */
  sourcesReadOk: number;
  sourcesFailed: number;
}

export interface SourceSnapshot {
  signature: string;
  summary: string;
  detail: string;
  url?: string;
}

export interface SourceFetchResult {
  sourceId: string;
  sourceLabel: string;
  ok: boolean;
  snapshot?: SourceSnapshot;
  error?: string;
}

export const WATCH_CRITERIA: VerificationCriteria = {
  // Watch runs verify their own invariants (real source data, honest errors,
  // dedupe, budget) inside the watch_report step; the goal-task criteria do
  // not apply because no purchase for "the answer" is required.
  primaryVerifiedAgainstNodeSignal: false,
  answerSane: false,
  answerMaxAgeSeconds: 0,
  ownPaymentSettledOnChain: false,
  reconcileLedgerEntries: false,
};

export function isWatchConfig(value: unknown): value is WatchConfig {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<WatchConfig>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.protocol === "string" &&
    Array.isArray(c.sources) &&
    c.sources.length > 0
  );
}
