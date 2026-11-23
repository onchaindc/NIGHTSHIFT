import { persistence } from "@/lib/storage";
import type { Finding, FindingSignificance } from "./types";
import { watchDeps } from "./execute";

/**
 * Alert ledger for Protocol Watch — the delivery-side twin of the fingerprint
 * store. Reliability properties:
 *
 *  - DEDUPE: every change finding maps to a stable alert key (source id plus
 *    the after-fingerprint). An alert is recorded BEFORE any delivery is
 *    attempted, in a persisted per-watch document. A later run (fresh
 *    serverless invocation, repeated tick, double worker) re-checks the
 *    ledger, so the same change can NEVER be notified twice: change detection
 *    is idempotent at the delivery boundary, not just at the fingerprint.
 *  - RETRY: a delivery failure records the attempt plus error and the alert
 *    STAYS pending. Subsequent scheduler ticks (or the next check run of that
 *    watch) re-deliver pending alerts after a bounded backoff, so a transient
 *    Telegram outage never loses an alert.
 *  - HONESTY: alerts restate what the source itself showed (what changed,
 *    detail, link, observation time) and carry the transparent
 *    keyword-heuristic importance. Nothing is ever labelled a "confirmed
 *    security incident": the alert states the observed change and points at
 *    the linked evidence, and the full report carries the verification trail.
 *
 * Storage: named documents (`watch-alerts:<watchId>`) through the swappable
 * persistence backend — JSON files locally, durable rows in Neon Postgres in
 * production, so alert state survives restarts exactly like fingerprints.
 */

export interface WatchAlert {
  /** Dedupe key: `<sourceId>:<afterSignature>` (signature is unique per change). */
  key: string;
  watchId: string;
  watchName: string;
  protocol: string;
  sourceId: string;
  sourceLabel: string;
  kind: Finding["kind"];
  before?: { signature: string; summary?: string; seenAt: number };
  after?: { signature: string };
  /** What changed, as observed on the source. */
  title: string;
  detail: string;
  severity?: FindingSignificance;
  /** Link to the original evidence on the source. */
  evidenceUrl?: string;
  /** When the change was actually observed (ms epoch). */
  observedAt: number;
  /** Task whose timeline holds the full run + evidence. */
  taskId: string;
  status: "pending" | "delivered";
  attempts: number;
  lastError?: string;
  lastAttemptAt?: number;
}

/** Bounded exponential backoff between delivery attempts. */
export function alertRetryDelayMs(attempts: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

function alertDocName(watchId: string): string {
  return `watch-alerts:${watchId}`;
}

async function loadAlerts(watchId: string): Promise<WatchAlert[]> {
  const doc = await persistence().readNamed<WatchAlert[]>(alertDocName(watchId));
  return Array.isArray(doc) ? doc : [];
}

async function saveAlerts(watchId: string, alerts: WatchAlert[]): Promise<void> {
  // Cap the ledger: delivered alert history stays in the task records; the
  // ledger only needs recent keys for dedupe across restarts.
  const kept = alerts.slice(-400);
  await persistence().writeNamed(alertDocName(watchId), kept);
}

/** All alerts for a watch (most recent first) — used by the web UI. */
export async function listAlerts(watchId: string): Promise<WatchAlert[]> {
  const alerts = await loadAlerts(watchId);
  return [...alerts].reverse();
}

/** What a run knows about its watch config (needed to attribute alerts). */
export interface AlertContext {
  watchId: string;
  watchName: string;
  protocol: string;
  telegramChatId: string | number | null;
}

/** Compact was/now line when the previous observation is known. */
export function alertChangeLine(a: WatchAlert): string | null {
  if (!a.before?.summary) return null;
  return `was: ${relSummary(a.sourceLabel, a.before.summary)} → now: ${relSummary(a.sourceLabel, a.title)}`;
}

/** Source summaries can repeat the source label; don't repeat it per line. */
function relSummary(sourceLabel: string, summary: string): string {
  const prefix = `${sourceLabel}: `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

/**
 * One concise alert message (a single Telegram message carrying one block per
 * change, so a multi-source change never spams one message per source). Every
 * block: what changed, the previous value when known, importance keyword when
 * supported, evidence link. The footer: observation time + full-report link.
 */
export function alertText(alerts: WatchAlert[], baseReportUrl: string | null): string {
  const first = alerts[0];
  const lines: string[] = [];
  lines.push(`🔎 Protocol Watch: ${first.protocol} (${first.watchName})`);
  const observed = new Date(first.observedAt).toISOString().replace("T", " ").slice(0, 16);
  for (const a of alerts) {
    lines.push("");
    lines.push(`• ${a.sourceLabel}: ${relSummary(a.sourceLabel, a.title)}`);
    const change = alertChangeLine(a);
    if (a.before?.summary && change) lines.push(`  ${change.slice(0, 200)}`);
    if (a.detail) lines.push(`  → ${a.detail.replace(/\s+/g, " ").slice(0, 240)}`);
    if (a.severity === "high") {
      lines.push("  Importance: security-relevant keywords in the source text. Not a confirmed incident; verify at the evidence link.");
    } else if (a.severity === "notable") {
      lines.push("  Importance: breaking/deprecation/governance keywords in the source text.");
    }
    if (a.evidenceUrl) lines.push(`  Evidence: ${a.evidenceUrl}`);
  }
  lines.push("", `Observed: ${observed} UTC.`);
  if (baseReportUrl) {
    lines.push(`Full report: ${baseReportUrl}/tasks/${first.taskId}`);
  } else {
    lines.push(`Full report: run ${first.taskId.slice(0, 8)} in the NIGHTSHIFT web app.`);
  }
  return lines.join("\n").slice(0, 3800);
}

/**
 * Records change findings into the ledger BEFORE delivery (dedupe-first).
 * Returns only the genuinely NEW alerts — anything already recorded under the
 * same key (delivered earlier or currently pending) is a duplicate and is
 * dropped, regardless of which worker or invocation noticed it.
 */
export async function recordAlerts(context: AlertContext, findings: Finding[], taskId: string): Promise<WatchAlert[]> {
  const changeFindings = findings.filter((f) => f.kind !== "source_error");
  if (changeFindings.length === 0) return [];
  const existing = await loadAlerts(context.watchId);
  const seenKeys = new Set(existing.map((a) => a.key));
  const fresh: WatchAlert[] = [];
  for (const f of changeFindings) {
    const key = `${f.sourceId}:${f.after?.signature ?? f.title}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    fresh.push({
      key,
      watchId: context.watchId,
      watchName: context.watchName,
      protocol: context.protocol,
      sourceId: f.sourceId,
      sourceLabel: f.sourceLabel,
      kind: f.kind,
      before: f.before,
      after: f.after,
      title: f.title,
      detail: f.detail,
      severity: f.significance,
      evidenceUrl: f.url,
      observedAt: f.detectedAt,
      taskId,
      status: "pending",
      attempts: 0,
    });
  }
  if (fresh.length > 0) await saveAlerts(context.watchId, [...existing, ...fresh]);
  return fresh;
}

/**
 * Delivers NEW findings plus pending alerts past their retry backoff, as one
 * message. Attempts are recorded per alert: success flips the status to
 * delivered (it can never re-send), failure increments attempts, records the
 * error and keeps the alert pending for the next trigger. Never throws:
 * delivery problems are recorded, the scan continues.
 */
export async function deliverAlerts(
  context: AlertContext,
  freshAlerts: WatchAlert[],
  baseReportUrl: string | null,
  now: number,
): Promise<{ delivered: number; failed: number; freshCount: number; firstError?: string }> {
  const all = await loadAlerts(context.watchId);
  const freshKeys = new Set(freshAlerts.map((a) => a.key));
  const pending = all.filter((a) => a.status === "pending" && (freshKeys.has(a.key) || now - (a.lastAttemptAt ?? 0) >= alertRetryDelayMs(a.attempts)));
  if (pending.length === 0) return { delivered: 0, failed: 0, freshCount: freshAlerts.length };
  // The pending batch is what the message contains, whatever its origin.
  const batch = pending.filter((a) => !(a.status === "pending" && a.attempts > 0 && now - (a.lastAttemptAt ?? 0) < alertRetryDelayMs(a.attempts)));
  if (batch.length === 0) return { delivered: 0, failed: 0, freshCount: freshAlerts.length };
  const results = { delivered: 0, failed: 0, freshCount: freshAlerts.length, firstError: undefined as string | undefined };
  const attemptKeys = new Set(batch.map((a) => a.key));
  try {
    const text = alertText(batch, baseReportUrl);
    try {
      if (!context.telegramChatId) {
        // No chat configured: nothing to send, nothing failed. The ledger
        // keeps the alerts as recorded history (the report stays in the app).
        return results;
      }
      await watchDeps.sendTelegram(context.telegramChatId, text);
      for (const a of all) {
        if (attemptKeys.has(a.key)) {
          a.status = "delivered";
          a.attempts += 1;
          a.lastAttemptAt = now;
        }
      }
      results.delivered = batch.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const a of all) {
        if (attemptKeys.has(a.key)) {
          a.status = "pending";
          a.attempts += 1;
          a.lastAttemptAt = now;
          a.lastError = `delivery failed: ${message}`;
        }
      }
      results.failed = batch.length;
      results.firstError = message;
    }
    await saveAlerts(context.watchId, all);
  } catch (err) {
    console.error("alert ledger update failed:", err);
  }
  return results;
}

/** Dev/test helper: clears one watch's ledger (does not touch task history). */
export async function clearAlerts(watchId: string): Promise<void> {
  await persistence().deleteNamed(alertDocName(watchId));
}
