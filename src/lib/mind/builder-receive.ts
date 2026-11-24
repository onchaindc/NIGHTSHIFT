/**
 * The receiving half of the Minds by Animoca Brands round trip.
 *
 * Sending is `builder.ts` (raw POST to the documented /v1/messaging/message).
 * Receiving uses the official client library
 * (`@animocabrands/minds-client-lib`), which is the documented interface for
 * everything messaging besides that one literal path: conversation binding
 * (`ensureConversation` — idempotent), the newest-first transcript
 * (`getHistory`), the pre-send correlation fingerprint
 * (`getLatestHistoryFingerprint` passed as `afterFingerprint`), the bounded
 * reply wait (`waitForReply` — live event stream first, then history), and
 * the documented reply matcher (`isReplyHistoryRow`).
 *
 * Correlation contract (all documented capabilities, nothing guessed):
 *  - immediately BEFORE the send, capture the alias's newest history
 *    fingerprint (`getLatestHistoryFingerprint`);
 *  - the reply wait and the deferred collect accept only Mind rows
 *    (`senderType` 0|2) newer than that fingerprint, matched with the
 *    library's own `isReplyHistoryRow`;
 *  - the deferred collect additionally stops walking the newest-first
 *    transcript at the recorded fingerprint, so rows from before the send
 *    can never be mistaken for the reply.
 *
 * Every call is environment-gated (MINDS_BUILDER_API_KEY + MINDS_BUILDER_ALIAS,
 * exactly like the send path) and every failure is returned as a typed
 * outcome, never thrown into the investigation: a Minds outage must not be
 * able to change a NIGHTSHIFT result. A reply is an LLM response — recorded
 * with provenance "mind-reply" and never presented as a network-verified fact.
 */

import {
  createMindsClient,
  isReplyHistoryRow,
  MindsApiError,
  type MessageRecord,
  type MindsClient,
} from "@animocabrands/minds-client-lib";

import { MINDS_BUILDER_ENDPOINT, mindsBuilderAlias, type MindNotifyResult } from "./builder";
import type { ExecutionEventType, TaskRecord } from "@/lib/engine/types";

/** The Mind's reply, verbatim, with its conversation coordinates. */
export interface MindsReply {
  fingerprint: string;
  messageId?: string;
  messageText: string;
  createdAt?: string;
  receivedAt: number;
}

/** Lifecycle of the two-way round trip, persisted on the task result. */
export type MindsDeliveryStatus = "sent" | "reply_received" | "reply_timeout" | "send_failed" | "error";

export interface MindsDeliveryRecord {
  /** The alias the report was sent under (bound conversation). */
  alias: string;
  /** The exact endpoint the send used (default official, optional override). */
  endpoint: string;
  sentAt: number;
  status: MindsDeliveryStatus;
  /** Newest transcript fingerprint captured BEFORE the send (correlation anchor). */
  fingerprintBeforeSend?: string;
  /** Detail from the send attempt itself. */
  sendDetail: string;
  /** The Mind's reply, when one arrived. */
  reply?: MindsReply;
  /** Failure detail for the reply phase, when it failed. */
  replyErrorDetail?: string;
  /** How the reply was obtained: inline wait or deferred collect. */
  replySource?: "inline_wait" | "deferred_collect";
}

export type ReplyOutcome =
  | { status: "reply_received"; reply: MindsReply; detail: string }
  | { status: "reply_timeout"; detail: string }
  | { status: "not_configured"; detail: string }
  | { status: "error"; detail: string };

export interface ReplyRequest {
  alias: string;
  /** The exact text NIGHTSHIFT sent — the library's documented reply matcher. */
  sentMessageText: string;
  /** Fingerprint captured before the send (optional but strongly preferred). */
  fingerprintBefore?: string;
  timeoutMs?: number;
}

export interface CollectedReply {
  reply: MindsReply;
  /** Every Mind row since the send, oldest first — the Mind's execution trail. */
  mindRows: MindsReply[];
}

export interface MindsReceiveDeps {
  /** Returns null when the environment is not configured. */
  client: () => MindsClient | null;
  now: () => number;
}

export const MINDS_BUILDER_MIND_ID_ENV = "MINDS_BUILDER_MIND_ID";

/** Reply wait bound: short enough for an inline step, long enough for a Mind. */
export function replyWaitTimeoutMs(): number {
  const raw = Number(process.env.MINDS_BUILDER_REPLY_TIMEOUT_MS);
  const parsed = Number.isFinite(raw) ? raw : 20_000;
  return Math.min(Math.max(parsed, 3_000), 45_000);
}

function defaultClient(): MindsClient | null {
  const key = process.env.MINDS_BUILDER_API_KEY;
  if (!key) return null;
  return createMindsClient({ builderApiKey: key });
}

export const mindsReceiveDeps: MindsReceiveDeps = {
  client: defaultClient,
  now: () => Date.now(),
};

export function setMindsReceiveDeps(overrides: Partial<MindsReceiveDeps>): void {
  Object.assign(mindsReceiveDeps, overrides);
}
export function resetMindsReceiveDeps(): void {
  mindsReceiveDeps.client = defaultClient;
  mindsReceiveDeps.now = () => Date.now();
}

/** Same gate as the send path: no key or no bound alias, nothing is called. */
export function mindsReceiveConfigured(): boolean {
  return !!(process.env.MINDS_BUILDER_API_KEY && process.env.MINDS_BUILDER_ALIAS?.trim());
}

/** Documented failure semantics: 401/403 credential, 429 throttling, else the API code. */
export function describeMindsError(err: unknown): string {
  if (err instanceof MindsApiError) {
    if (err.status === 401 || err.status === 403) {
      return `Minds rejected the credential (HTTP ${err.status}, ${err.code}) — the Builder API key is missing, expired, revoked, or lacks the scope this call needs`;
    }
    if (err.status === 429) {
      return `Minds throttled the request (HTTP 429, ${err.code})${err.message ? `: ${err.message}` : ""}`;
    }
    return `Minds API error ${err.code} (HTTP ${err.status})${err.message ? `: ${err.message}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** True when the record is a Mind row with real text (belt and braces on top of the library matcher). */
function usableMindRow(row: MessageRecord): boolean {
  const role = row.senderType;
  return (role === 0 || role === 2) && typeof row.messageText === "string" && row.messageText.trim().length > 0;
}

function toReply(row: MessageRecord, now: number): MindsReply {
  return {
    fingerprint: row.fingerprint,
    messageId: row.messageId,
    messageText: (row.messageText ?? "").trim(),
    createdAt: row.createdAt,
    receivedAt: now,
  };
}

/**
 * Bind the alias to the Mind if a Mind id is configured. `ensureConversation`
 * is documented as idempotent — an already-bound alias returns the existing
 * conversation, so this is safe on every send. Without MINDS_BUILDER_MIND_ID
 * the alias is assumed pre-bound (the documented minimal setup).
 */
export async function ensureBoundConversation(alias: string): Promise<void> {
  const mindId = process.env[MINDS_BUILDER_MIND_ID_ENV]?.trim();
  if (!mindId) return;
  const client = mindsReceiveDeps.client();
  if (!client) return;
  await client.ensureConversation(alias, mindId);
}

/** Newest transcript fingerprint before the send; undefined when unconfigured. */
export async function captureSendFingerprint(alias: string): Promise<string | undefined> {
  // The send itself is env-gated, so the capture is too: without the key no
  // network call is made even if a client was somehow constructed.
  if (!process.env.MINDS_BUILDER_API_KEY) return undefined;
  const client = mindsReceiveDeps.client();
  if (!client) return undefined;
  try {
    await ensureBoundConversation(alias);
    return await client.getLatestHistoryFingerprint(alias);
  } catch {
    // Correlation falls back to the documented sentMessageText matcher; the
    // send itself is never blocked by a fingerprint failure.
    return undefined;
  }
}

/** Inline bounded wait for the Mind's reply (documented waitForReply). */
export async function receiveMindReply(request: ReplyRequest): Promise<ReplyOutcome> {
  const client = mindsReceiveDeps.client();
  if (!client) {
    return {
      status: "not_configured",
      detail:
        "not_configured: set MINDS_BUILDER_API_KEY and MINDS_BUILDER_ALIAS (and optionally MINDS_BUILDER_MIND_ID to bind the conversation) to receive replies on the official messaging API",
    };
  }
  const timeoutMs = request.timeoutMs ?? replyWaitTimeoutMs();
  try {
    const outcome = await client.waitForReply({
      alias: request.alias,
      timeoutMs,
      sentMessageText: request.sentMessageText,
      afterFingerprint: request.fingerprintBefore,
    });
    if (outcome.timedOut) {
      return {
        status: "reply_timeout",
        detail: `no Mind reply within ${timeoutMs}ms — the conversation stays open; collect the reply later with the recorded fingerprint`,
      };
    }
    const row = outcome.reply;
    if (!usableMindRow(row) || !row.fingerprint) {
      return { status: "error", detail: "Minds returned a reply row without Mind text or fingerprint — nothing recorded" };
    }
    return {
      status: "reply_received",
      reply: toReply(row, mindsReceiveDeps.now()),
      detail: `Mind reply received (fingerprint ${row.fingerprint})`,
    };
  } catch (err) {
    return { status: "error", detail: describeMindsError(err) };
  }
}

/**
 * Deferred retrieval for replies that arrive after the inline wait ended.
 * Walks the newest-first transcript, keeps Mind rows newer than the recorded
 * pre-send fingerprint (matched with the library's documented reply matcher),
 * and stops at that fingerprint so pre-send rows can never be returned.
 */
export async function collectMindReply(request: {
  alias: string;
  fingerprintBefore?: string;
  sentMessageText?: string;
}): Promise<ReplyOutcome & { collected?: CollectedReply }> {
  const client = mindsReceiveDeps.client();
  if (!client) {
    return { status: "not_configured", detail: "not_configured: the receiving environment variables are not set" };
  }
  try {
    const history = await client.getHistory(request.alias, { limit: 50 });
    const mindRows: MessageRecord[] = [];
    for (const row of history) {
      if (request.fingerprintBefore && row.fingerprint === request.fingerprintBefore) break;
      const isReply = isReplyHistoryRow(row, {
        alias: request.alias,
        afterFingerprint: request.fingerprintBefore,
        sentMessageText: request.sentMessageText,
      });
      if (isReply && usableMindRow(row)) mindRows.push(row);
    }
    if (mindRows.length === 0) {
      return {
        status: "reply_timeout",
        detail: "no Mind row newer than the recorded pre-send fingerprint — the Mind has not replied yet",
      };
    }
    // Transcript is newest-first; reverse for oldest-first execution order.
    const ordered = [...mindRows].reverse();
    const newest = ordered[ordered.length - 1];
    return {
      status: "reply_received",
      reply: toReply(newest, mindsReceiveDeps.now()),
      detail: `collected ${ordered.length} Mind reply row(s) since the send; newest fingerprint ${newest.fingerprint}`,
      collected: { reply: toReply(newest, mindsReceiveDeps.now()), mindRows: ordered.map((r) => toReply(r, mindsReceiveDeps.now())) },
    };
  } catch (err) {
    return { status: "error", detail: describeMindsError(err) };
  }
}

/**
 * Locate THIS task's delivered report row in the conversation transcript and
 * attribute its reply correctly. The report message embeds "Task: <uuid>";
 * the reply is the first usable Mind row between that report and the next
 * outbound message. A fingerprint-window walk alone cannot tell interleaved
 * reports apart (several reports can land within seconds of each other), so
 * attribution is anchored on the report row itself. Also rebuilds the
 * delivery record when the live-send record was never persisted (observed on
 * serverless: the in-memory assignment died with the invocation before any
 * later save).
 */
export async function findDeliveredReport(request: {
  taskId: string;
  alias?: string;
}): Promise<{ record: MindsDeliveryRecord; reply: MindsReply | null } | null> {
  const alias = request.alias ?? mindsBuilderAlias();
  const client = mindsReceiveDeps.client();
  if (!alias || !client) return null;
  const history = await client.getHistory(alias, { limit: 50 });
  // Newest-first; the report message embeds "Task: <full uuid>".
  const reportIdx = history.findIndex((r) => (r.messageText ?? "").includes(`Task: ${request.taskId}`));
  if (reportIdx < 0) return null;
  const reportRow = history[reportIdx];
  const fingerprintBefore = reportIdx + 1 < history.length ? history[reportIdx + 1].fingerprint : undefined;
  // Walk the newer rows (indices below the report) until the next outbound
  // message: the first usable Mind row in between is this report's reply.
  let reply: MindsReply | null = null;
  for (let i = reportIdx - 1; i >= 0; i--) {
    const row = history[i];
    if (row.senderType === 1) break;
    if (usableMindRow(row)) {
      reply = toReply(row, mindsReceiveDeps.now());
      break;
    }
  }
  const record: MindsDeliveryRecord = {
    alias,
    endpoint: MINDS_BUILDER_ENDPOINT,
    sentAt: reportRow.createdAt ? Date.parse(reportRow.createdAt) || mindsReceiveDeps.now() : mindsReceiveDeps.now(),
    status: reply ? "reply_received" : "reply_timeout",
    sendDetail: "delivery record reconstructed from the conversation transcript",
  };
  if (fingerprintBefore) record.fingerprintBeforeSend = fingerprintBefore;
  if (reply) {
    record.reply = reply;
    record.replySource = "deferred_collect";
  } else {
    record.replyErrorDetail = "no Mind reply found between this report and the next transcript message";
  }
  return { record, reply };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (truncated — the full text is in the delivery record)` : text;
}

/**
 * Compose the reply phase onto a completed send, in the executor's voice:
 * capture nothing here (the fingerprint is captured BEFORE the send by the
 * executor), wait bounded for the reply, then persist the whole round trip on
 * the task result and record the lifecycle events. Best-effort by contract:
 * every failure becomes a typed event, never an exception, and the
 * investigation result the engine already verified stays intact.
 *
 * The reply is incorporated into the report summary under an explicit
 * "mind-reply" provenance label — it is an LLM response, never mixed with
 * the network-verified fact set.
 */
export async function awaitAndRecordMindReply(args: {
  task: TaskRecord;
  notify: MindNotifyResult;
  alias?: string;
  fingerprintBefore?: string;
  sentMessageText: string;
  receive?: (request: ReplyRequest) => Promise<ReplyOutcome>;
  now: () => number;
  event: (type: ExecutionEventType, message: string, data?: Record<string, unknown>) => Promise<void>;
  /** Called after the record is assigned: the caller's sequential task save. */
  persist?: () => Promise<void>;
}): Promise<void> {
  const { task, notify, alias, fingerprintBefore, sentMessageText, receive, now, event, persist } = args;
  if (!notify.ok) return;

  const record: MindsDeliveryRecord = {
    alias: alias ?? "",
    endpoint: MINDS_BUILDER_ENDPOINT,
    sentAt: now(),
    status: "sent",
    fingerprintBeforeSend: fingerprintBefore,
    sendDetail: notify.detail,
  };

  if (alias && receive) {
    const outcome = await receive({ alias, sentMessageText, fingerprintBefore });
    if (outcome.status === "reply_received") {
      record.status = "reply_received";
      record.reply = outcome.reply;
      record.replySource = "inline_wait";
      await event(
        "mind_reply_received",
        `The Mind replied on conversation "${alias}": "${truncate(outcome.reply.messageText, 200)}" — recorded with provenance "mind-reply": an LLM response, not a network-verified fact.`,
        { fingerprint: outcome.reply.fingerprint, messageId: outcome.reply.messageId },
      );
      if (task.result) {
        task.result.summary += `\n\nMind reply (received ${new Date(outcome.reply.receivedAt).toISOString()}; provenance "mind-reply" — an LLM response from the connected Mind, not a network-verified fact):\n"${truncate(outcome.reply.messageText, 800)}"`;
      }
    } else if (outcome.status === "reply_timeout") {
      record.status = "reply_timeout";
      record.replyErrorDetail = outcome.detail;
      await event(
        "mind_reply_pending",
        `No Mind reply yet (${outcome.detail}) — execution state preserved with the pre-send fingerprint; collect the reply later from the same conversation.`,
        { fingerprintBeforeSend: fingerprintBefore ?? null },
      );
    } else if (outcome.status === "error") {
      record.status = "error";
      record.replyErrorDetail = outcome.detail;
      await event("mind_reply_error", `Minds reply receive failed: ${outcome.detail}`);
    }
    // "not_configured" cannot happen after a successful send (same gate) but
    // is handled defensively: the record stays "sent" with the send detail.
    if (outcome.status === "not_configured") record.replyErrorDetail = outcome.detail;
  }

  if (task.result) {
    task.result.mindsDelivery = record;
    // The record is assigned after the awaited event-saves above; without an
    // explicit sequential persist here it never reaches the store (observed
    // on serverless: the in-memory task dies with the invocation) and the
    // deferred collect later finds no delivery record.
    if (persist) await persist();
  }
}
