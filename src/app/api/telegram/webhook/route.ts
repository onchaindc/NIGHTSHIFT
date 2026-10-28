import { handleUpdate, type TgUpdate } from "@/lib/telegram/adapter";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Telegram webhook. Configure once (after setting TELEGRAM_BOT_TOKEN):
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

  try {
    await handleUpdate(update);
  } catch (err) {
    console.error("telegram webhook handler error:", err);
  }
  return NextResponse.json({ ok: true });
}
