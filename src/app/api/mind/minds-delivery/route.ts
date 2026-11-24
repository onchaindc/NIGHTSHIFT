import { NextRequest, NextResponse } from "next/server";

import { requestAuthorized } from "@/lib/api/auth";
import { getTask, saveTask } from "@/lib/engine/store";
import { collectMindReply } from "@/lib/mind/builder-receive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deferred half of the two-way Minds round trip.
 *
 * POST /api/mind/minds-delivery  { taskId }
 *   When the inline reply wait ended without a Mind response, the delivery
 *   record stays at "reply_timeout" with its pre-send fingerprint preserved.
 *   This operator-gated route pulls the conversation transcript
 *   (documented GET histories via the official client), correlates Mind rows
 *   newer than the recorded fingerprint with the library's own reply matcher,
 *   and attaches the reply to the originating investigation's report with the
 *   explicit "mind-reply" provenance label. It never blocks or re-runs the
 *   investigation: the task is already completed and stays completed.
 *
 * Responses that arrive later must not silently vanish, and pre-send rows must
 * never be mistaken for the reply — hence the fingerprint stop, not a
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
  if (!delivery) {
    return NextResponse.json(
      { error: `task ${taskId} has no Minds delivery record — only reports actually delivered to a connected Mind can be collected` },
      { status: 409 },
    );
  }
  if (delivery.status === "reply_received") {
    return NextResponse.json(
      { error: `task ${taskId} already recorded the Mind reply (fingerprint ${delivery.reply?.fingerprint ?? "unknown"})`, delivery },
      { status: 409 },
    );
  }
  if (delivery.status === "send_failed") {
    return NextResponse.json({ error: `task ${taskId}'s send never completed, so there is nothing to collect` }, { status: 409 });
  }

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

  // Attach the reply: the investigation result stays completed and intact; the
  // record and the summary gain the labelled mind-reply section.
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

  return NextResponse.json({ detail: outcome.detail, delivery });
}
