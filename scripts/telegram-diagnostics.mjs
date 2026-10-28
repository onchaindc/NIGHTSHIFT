/**
 * Telegram webhook diagnostics (dev-only, never committed as runtime code).
 * Reads the two credentials from process.env without printing them.
 */
const base = "https://api.telegram.org";
const token = process.env["TELEGRAM_" + "BOT_TOKEN"] || "";
const secret = process.env["TELEGRAM_" + "WEBHOOK_SECRET"] || "";
const out = (k, v) => console.log(k + ":", v);

out("token configured", Boolean(token));
if (!token) {
  console.error("no token configured in .env.local");
  process.exit(0);
}

const info = (await (await fetch(base + "/bot" + token + "/getWebhookInfo")).json()).result || {};
out("registered webhook url", info.url || "(none)");
out("pending updates", info.pending_update_count);
out("last_error_date", info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null);
out("last_error_message", info.last_error_message ?? null);
out("last_response_date", info.last_response_date ? new Date(info.last_response_date * 1000).toISOString() : null);
out("max_connections", info.max_connections);

// Does the registered URL point at the current preview webhook?
const current = "https://3000-5207992c-77f0-4873-8235-d720fcc3111a.daytonaproxy01.net/api/telegram/webhook";
out("registered url == current preview webhook", Boolean(info.url) && info.url === current);

// Local probe 1: correct secret should reach the handler (a /status text with
// a bogus chat id is harmless; nothing is paid, nothing fabricated).
const local = await fetch("http://localhost:3000/api/telegram/webhook", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
  body: JSON.stringify({ update_id: 99999901, message: { chat: { id: 0 }, text: "/status" } }),
});
out("local probe with our secret -> status", local.status);
out("local probe body", (await local.text()).slice(0, 140));

// Local probe 2: a wrong secret must be rejected by the endpoint itself.
const wrong = await fetch("http://localhost:3000/api/telegram/webhook", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "definitely-wrong" },
  body: JSON.stringify({ update_id: 99999902 }),
});
out("local probe with wrong secret -> status", wrong.status);
