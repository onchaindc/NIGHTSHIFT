import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { getTask, saveTask } from "@/lib/engine/store";
import {
  collectMindReply,
  findDeliveredReport,
  type MindsDeliveryRecord,
  type MindsReply,
} from "@/lib/mind/builder-receive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deferred half of the two-way Minds round trip.
 *
 * POST /api/mind/minds-delivery  { taskId }
 *   When the inline reply wait ended without a Mind response, the delivery
 *   record stays at "reply_timeout" (or was never persisted, observed on
 *   serverless). This operator-gated route anchors attribution on the task's
 *   report row in the conversation transcript (the report embeds the task
 *   id): the reply is the first Mind row between that report and the next
 *   outbound message, so interleaved reports cannot cross-attach. It rebuilds
 *   the delivery record from the transcript when the live-send record is
 *   missing, and attaches the reply to the originating investigation's report
 *   with the explicit "mind-reply" provenance label. It never blocks or
 *   re-runs the investigation: the task is already completed and stays
 *   completed.
 *
 * Responses that arrive later must not silently vanish, and pre-send rows must
 * never be mistaken for the reply — hence the report-row anchor, not a
 * timestamp guess. Anonymous callers get nothing: the delivery record is
 * operator data (it names the objective and the connected Mind).
 */
export async function POST(req: NextRequest) {
  if (!requestAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: the Minds delivery record belongs to the operator — pass the bearer token (NIGHTSHIFT_API_TOKEN) or sign in from /api/session" },
      { status: 401 },
    );
  }

  let body: { taskId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
  if (!taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });

  const task = await getTask(taskId);
  if (!task) return NextResponse.json({ error: `task ${taskId} not found` }, { status: 404 });

  const delivery = task.result?.mindsDelivery;

  // Anchor attribution on the report row when the transcript still holds it:
  // several reports can interleave within seconds, so a fingerprint window
  // alone cannot tell their replies apart (and has attached the wrong row).
  let anchored: { record: MindsDeliveryRecord; reply: MindsReply | null } | null = null;
  if (delivery) {
    try {
      anchored = await findDeliveredReport({ taskId, alias: delivery.alias });
    } catch {
      anchored = null; // transcript read trouble falls back to the recorded fingerprint walk
    }
  }

  const misattributed =
    !!delivery?.reply &&
    !!anchored &&
    (!anchored.reply || delivery.reply.fingerprint !== anchored.reply.fingerprint);

  if (delivery?.status === "reply_received" && !misattributed) {
    return NextResponse.json(
      { error: `task ${taskId} already recorded the Mind reply (fingerprint ${delivery.reply?.fingerprint ?? "unknown"})`, delivery },
      { status: 409 },
    );
  }
  if (delivery?.status === "send_failed") {
    return NextResponse.json({ error: `task ${taskId}'s send never completed, so there is nothing to collect` }, { status: 409 });
  }

  if (delivery && anchored) {
    if (misattributed) {
      // Positive proof of mis-attribution: the window between this report and
      // the next outbound message holds a different reply (or none). Replace
      // the record's reply and document the correction; the summary keeps the
      // wrong text for the audit trail, with the correction appended.
      const wrong = delivery.reply;
      if (anchored.reply) {
        delivery.reply = anchored.reply;
        delivery.replySource = "deferred_collect";
        delivery.replyErrorDetail = undefined;
        delivery.status = "reply_received";
      } else {
        delete delivery.reply;
        delete delivery.replySource;
        delivery.replyErrorDetail = "no Mind reply found between this report and the next transcript message";
        delivery.status = "reply_timeout";
      }
      if (task.result) {
        task.result.summary += `\n\nMind reply corrected (the previously attached row ${wrong?.fingerprint ?? "unknown"} was taken from a fingerprint-window walk and does not follow this report in the transcript; attribution re-anchored on the report row carrying Task: ${taskId}. The attached row now is ${anchored.reply ? anchored.reply.fingerprint : "none - no reply is attributable to this report yet"}).`;
      }
      task.events.push({
        id: `${Date.now()}-mind-reply-corrected`,
        ts: Date.now(),
        type: "mind_reply_corrected",
        message: `Mind reply re-attributed via the report row carrying Task: ${taskId}: removed ${wrong?.fingerprint ?? "unknown"}, attached ${anchored.reply ? anchored.reply.fingerprint : "none"}.`,
        data: { removedFingerprint: wrong?.fingerprint ?? null, correctedFingerprint: anchored.reply?.fingerprint ?? null },
      });
      task.updatedAt = Date.now();
      await saveTask(task);
      return NextResponse.json({
        detail: `Mind reply re-attributed via the report row carrying Task: ${taskId}`,
        delivery,
        status: delivery.status,
      });
    }
    if (!delivery.reply && anchored.reply) {
      // Fresh attach with correct attribution.
      delivery.status = "reply_received";
      delivery.reply = anchored.reply;
      delivery.replySource = "deferred_collect";
      delivery.replyErrorDetail = undefined;
      if (task.result) {
        const text = anchored.reply.messageText;
        const clipped = text.length > 800 ? `${text.slice(0, 800)}… (truncated — the full text is in the delivery record)` : text;
        task.result.summary += `\n\nMind reply (collected ${new Date(anchored.reply.receivedAt).toISOString()}; provenance "mind-reply" — an LLM response from the connected Mind, not a network-verified fact):\n"${clipped}"`;
      }
      task.events.push({
        id: `${Date.now()}-mind-reply-collect`,
        ts: Date.now(),
        type: "mind_reply_received",
        message: `Mind reply collected from conversation "${delivery.alias}" after the inline wait ended (fingerprint ${anchored.reply.fingerprint}) — provenance "mind-reply", not a network-verified fact.`,
        data: { fingerprint: anchored.reply.fingerprint, source: "deferred_collect" },
      });
      task.updatedAt = Date.now();
      await saveTask(task);
      return NextResponse.json({
        detail: `Mind reply attached from conversation "${delivery.alias}" (attributed via the report row carrying Task: ${taskId})`,
        delivery,
        status: delivery.status,
      });
    }
    if (!delivery.reply && !anchored.reply) {
      return NextResponse.json(
        { detail: "no Mind reply has arrived for this report yet (attributed via the report row in the transcript)", delivery, status: delivery.status },
        { status: 200 },
      );
    }
    // delivery.reply exists and anchoring confirms it (fingerprint equal), or
    // the row left the window: the conservative already-recorded answer.
    return NextResponse.json(
      { error: `task ${taskId} already recorded the Mind reply (fingerprint ${delivery.reply?.fingerprint ?? "unknown"})`, delivery },
      { status: 409 },
    );
  }

  if (delivery) {
    // Recorded round trip, transcript window exhausted: pull the transcript
    // and correlate Mind rows newer than the recorded pre-send fingerprint
    // with the library's own matcher (the original deferred-collect contract).
    const outcome = await collectMindReply({
      alias: delivery.alias,
      fingerprintBefore: delivery.fingerprintBeforeSend,
    });
    if (outcome.status === "error") {
      return NextResponse.json({ error: outcome.detail, delivery }, { status: 502 });
    }
    if (outcome.status !== "reply_received" || !outcome.reply || !outcome.collected) {
      return NextResponse.json({ detail: outcome.detail, delivery }, { status: 200 });
    }
    // Attach the reply: the investigation result stays completed and intact;
    // the record and the summary gain the labelled mind-reply section.
    delivery.status = "reply_received";
    delivery.reply = outcome.reply;
    delivery.replySource = "deferred_collect";
    delivery.replyErrorDetail = undefined;
    if (task.result) {
      const text = outcome.reply.messageText;
      const clipped = text.length > 800 ? `${text.slice(0, 800)}… (truncated — the full text is in the delivery record)` : text;
      task.result.summary += `\n\nMind reply (collected ${new Date(outcome.reply.receivedAt).toISOString()}; provenance "mind-reply" — an LLM response from the connected Mind, not a network-verified fact):\n"${clipped}"`;
    }
    task.events.push({
      id: `${Date.now()}-mind-reply-collect`,
      ts: Date.now(),
      type: "mind_reply_received",
      message: `Mind reply collected from conversation "${delivery.alias}" after the inline wait ended (fingerprint ${outcome.reply.fingerprint}) — provenance "mind-reply", not a network-verified fact.`,
      data: { fingerprint: outcome.reply.fingerprint, source: "deferred_collect" },
    });
    task.updatedAt = Date.now();
    await saveTask(task);
    return NextResponse.json({ detail: outcome.detail, delivery, status: delivery.status });
  }

  // No record persisted (observed on serverless: the in-memory delivery
  // record died with the invocation before any later save). Rebuild it from
  // the transcript, anchoring attribution on the report row that carries the
  // task id: the reply is the first Mind row between that report and the next
  // outbound message, so interleaved reports cannot cross-attach.
  let found: { record: MindsDeliveryRecord; reply: MindsReply | null } | null;
  try {
    found = await findDeliveredReport({ taskId });
  } catch (err) {
    return NextResponse.json(
      { error: `transcript read failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
  if (!found) {
    return NextResponse.json(
      { error: `task ${taskId} has no Minds delivery record — only reports actually delivered to a connected Mind can be collected` },
      { status: 409 },
    );
  }
  const rebuilt = found.record;
  if (task.result) task.result.mindsDelivery = rebuilt;

  const detail = found.reply
    ? `Mind reply attached from conversation "${rebuilt.alias}" (attributed via the report row carrying Task: ${taskId})`
    : "no Mind reply has arrived for this report yet; the delivery record is rebuilt — collect again later";

  if (found.reply) {
    if (task.result) {
      const text = found.reply.messageText;
      const clipped = text.length > 800 ? `${text.slice(0, 800)}… (truncated — the full text is in the delivery record)` : text;
      task.result.summary += `\n\nMind reply (collected ${new Date(found.reply.receivedAt).toISOString()}; provenance "mind-reply" — an LLM response from the connected Mind, not a network-verified fact):\n"${clipped}"`;
    }
    task.events.push({
      id: `${Date.now()}-mind-reply-collect`,
      ts: Date.now(),
      type: "mind_reply_received",
      message: `Mind reply collected from conversation "${rebuilt.alias}" after the inline wait ended (fingerprint ${found.reply.fingerprint}) — provenance "mind-reply", not a network-verified fact.`,
      data: { fingerprint: found.reply.fingerprint, source: "deferred_collect" },
    });
  } else {
    task.events.push({
      id: `${Date.now()}-delivery-record-rebuild`,
      ts: Date.now(),
      type: "delivery_succeeded",
      message: `Delivery record rebuilt from the conversation transcript (report row carrying Task: ${taskId}); status "${rebuilt.status}".`,
      data: { source: "transcript_reconstruction" },
    });
  }
  task.updatedAt = Date.now();
  await saveTask(task);

  return NextResponse.json({ detail, delivery: rebuilt, status: rebuilt.status });
}
