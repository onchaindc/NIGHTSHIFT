/**
 * Dev-only outbound check: deliver one short status note to the chat(s) the
 * bot actually conversed with before (from .data/telegram-seen-updates.json).
 * Prints nothing secret and nothing paid. If no chat resolves, it says so.
 */
import fs from "node:fs";
const token = process.env["TELEGRAM_" + "BOT_TOKEN"] || "";
const seenRaw = JSON.parse(fs.readFileSync(".data/telegram-seen-updates.json", "utf8"));
const candidates = Array.isArray(seenRaw) ? seenRaw.filter((v) => typeof v === "number" || typeof v === "string") : Object.keys(seenRaw);

for (const c of candidates) {
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: c,
      text: "Nightshift check: the bot is back online after a pause. Nothing changed about your goals; send /tasks to see them.",
    }),
  });
  const body = await res.json();
  if (body.ok) {
    console.log("status note delivered to chat id ending in ...", String(c).slice(-4), "->", res.status, "telegram ok:", body.ok);
  } else {
    console.log("chat", String(c).slice(0, 3) + "***", "-> not deliverable (" + body.description + ")");
  }
}
