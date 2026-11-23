import { handleUpdate, type TgUpdate } from "@/lib/telegram/adapter";
import { NextResponse, after } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A /goal may run paid steps with retries; processing continues in the
// background after the response (after()), up to this duration limit.
export const maxDuration = 60;

/**
 * Telegram webhook. Registration is automatic: on server boot and on the
 * daily scheduler tick, src/lib/telegram/webhook-register.ts compares the
 * URL Telegram currently holds against this deployment's public URL and
 * re-registers (setWebhook, including TELEGRAM_WEBHOOK_SECRET) on drift —
 * so a deployment can no longer go silent because it was never registered
 * in production. Manual fallback, after setting TELEGRAM_BOT_TOKEN:
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *        -d "url=https://<your-domain>/api/telegram/webhook" \
 *        -d "secret_token=<value of TELEGRAM_WEBHOOK_SECRET>"
 *
 * If TELEGRAM_WEBHOOK_SECRET is set, updates whose
 * X-Telegram-Bot-Api-Secret-Token header does not match are rejected.
 * Always returns 200 so Telegram does not hard-retry valid updates.
 */
export async function POST(req: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== expected) {
      return NextResponse.json({ ok: false, error: "bad webhook secret" }, { status: 401 });
    }
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  // Respond to Telegram immediately and process in the background: a long
  // goal executed request-bound used to blow through the function duration
  // limit, killing progress delivery mid-run. The update-claim inside
  // handleUpdate still guarantees at-most-once processing.
  after(async () => {
    try {
      await handleUpdate(update);
    } catch (err) {
      console.error("telegram webhook handler error:", err);
    }
    // Wake-up recovery: if a previous goal's after() was killed by the
    // duration limit, its task record stayed `executing` with no live
    // runner (the update was already claimed, so no redelivery comes).
    // Each new inbound message doubles as a recovery trigger, so the
    // abandoned free task completes the next time the user talks to the
    // bot, instead of only when the daily cron fires.
    try {
      const { recoverAbandonedFreeTasks } = await import("@/lib/telegram/recovery");
      const { recovered } = await recoverAbandonedFreeTasks();
      if (recovered.length) console.log(`recovery finished for: ${recovered.join(", ")}`);
    } catch (err) {
      console.error("abandoned task recovery failed:", err);
    }
  });
  return NextResponse.json({ ok: true });
}
