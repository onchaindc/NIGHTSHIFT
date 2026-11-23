import { missingBotCredentials } from "./adapter";

/**
 * Telegram webhook reconciliation — the production-registration safety net.
 *
 * ROOT CAUSE this fixes: https://api.telegram.org/bot<token>/getWebhookInfo
 * proved that the webhook URL pointed at a dead sandbox preview host, so
 * every Telegram update came back as "Wrong response from the webhook: 502
 * Bad Gateway" and the bot silently received nothing. setWebhook had simply
 * never been called against production.
 *
 * This module compares the webhook URL Telegram actually holds against the
 * URL the current deployment is reachable at, and re-registers on drift. It
 * runs on server boot and on the daily scheduler tick, so a webhook can no
 * longer rot silently. It never sends user-visible messages and it is safe
 * to call repeatedly (no-op when Telegram already has the right URL).
 *
 * Secrets: TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are read from env
 * and never logged or returned.
 */

const API_BASE = "https://api.telegram.org";

/**
 * The public base URL updates should arrive on, or null when this process
 * should not touch webhook registration.
 *
 * Priority: an explicit PRIVATE config (NIGHTSHIFT_PUBLIC_BASE_URL) wins so
 * custom domains always work; on Vercel the stable PROJECT PRODUCTION URL is
 * preferred over the per-deployment VERCEL_URL (per-deployment URLs die with
 * the deployment, which would strand the webhook again). Outside a Vercel
 * runtime (= local dev, tests, sandboxes) nothing is auto-derived: pointing
 * a webhook at a durability-host that dies with a session is exactly the
 * failure mode being repaired.
 */
export function resolveWebhookBaseUrl(): string | null {
  const explicit = (process.env.NIGHTSHIFT_PUBLIC_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const production = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  if (production) return `https://${production}`;

  // Per-deployment fallback only when there is no production domain AND no
  // recorded production-domain hint (Vercel sets both on every deployment).
  if (process.env.VERCEL_ENV) {
    const deployment = (process.env.VERCEL_URL || "").trim();
    if (deployment) return `https://${deployment}`;
  }
  return null;
}

export interface WebhookReconcileResult {
  action: "registered" | "current" | "skipped";
  detail: string;
}

interface TelegramApiOk<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * Ensure the webhook is registered against the current public URL.
 *
 * `fetchFn` is injectable for tests; production uses global fetch.
 *
 * Policy: re-register whenever getWebhookInfo's URL does not equal the
 * expected one (this also clears Telegram's stored last_error context tied
 * to the dead URL). Secret-token freshness is NOT verifiable from
 * getWebhookInfo, so the secret from env is always re-sent with setWebhook
 * whenever we register. A matching URL is left alone (setWebhook resets
 * pending updates comparisons on some transitions of state; the risk of a
 * no-op HTTP call outweighs nothing here).
 */
export async function reconcileTelegramWebhook(fetchFn: typeof fetch = fetch): Promise<WebhookReconcileResult> {
  const missing = missingBotCredentials();
  if (missing.length) {
    return { action: "skipped", detail: `bot not configured: missing ${missing.join(", ")}` };
  }
  const base = resolveWebhookBaseUrl();
  if (!base) {
    return { action: "skipped", detail: "no public base URL for this runtime (set NIGHTSHIFT_PUBLIC_BASE_URL to reconcile)" };
  }
  const expected = `${base}/api/telegram/webhook`;
  const token = process.env.TELEGRAM_BOT_TOKEN as string;

  let info: TelegramApiOk<{ url?: string; last_error_message?: string; last_error_date?: number }>;
  try {
    const res = await fetchFn(`${API_BASE}/bot${token}/getWebhookInfo`, { method: "POST" });
    if (!res.ok) return { action: "skipped", detail: `getWebhookInfo failed: HTTP ${res.status}` };
    info = (await res.json()) as TelegramApiOk<{ url?: string; last_error_message?: string; last_error_date?: number }>;
  } catch (err) {
    return { action: "skipped", detail: `getWebhookInfo request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!info.ok || typeof info.result?.url !== "string") {
    return { action: "skipped", detail: `getWebhookInfo rejected: ${info.description ?? "unexpected payload"}` };
  }
  if (info.result.url === expected) {
    return { action: "current", detail: `webhook URL already points at ${expected}` };
  }
  // The existing URL is wrong (often a dead deployment host, the exact
  // production failure that made the bot unresponsive).

  const body: Record<string, unknown> = { url: expected, allowed_updates: ["message"], drop_pending_updates: false };
  if (process.env.TELEGRAM_WEBHOOK_SECRET) body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
  try {
    const res = await fetchFn(`${API_BASE}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { action: "skipped", detail: `setWebhook failed: HTTP ${res.status}` };
    const out = (await res.json()) as TelegramApiOk<unknown>;
    if (!out.ok) return { action: "skipped", detail: `setWebhook rejected: ${out.description ?? "unknown error"}` };
  } catch (err) {
    return { action: "skipped", detail: `setWebhook request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  console.log(`telegram webhook reconciled: URL changed to ${expected}`);
  return { action: "registered", detail: `webhook URL set to ${expected}` };
}
