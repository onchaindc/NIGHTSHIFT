/**
 * Display-time copy cleanup for text produced by the engine (event messages,
 * task errors) and by the bot adapter. The engine stays precise and
 * technical; user-facing surfaces show clear words instead. Nothing is
 * rewritten in storage — only at render/transport time.
 */

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/TELEGRAPH_EVM_PRIVATE_KEY/g, "the paid-research wallet"],
  [/TELEGRAM_BOT_TOKEN/g, "the Telegram bot token"],
  [/TELEGRAM_WEBHOOK_SECRET/g, "the Telegram webhook secret"],
  [/NIGHTSHIFT_API_TOKEN/g, "the operator token"],
  [/NIGHTSHIFT_EXTERNAL_CRON/g, "the external scheduler setting"],
  [/NIGHTSHIFT_WATCH_INTERVAL_MS/g, "the watch scan interval"],
  [/NIGHTSHIFT_WATCH_AUTOCHECK/g, "the watch auto-check setting"],
  [/NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS/g, "the default spending ceiling setting"],
  [/NIGHTSHIFT_DATA_DIR/g, "the data directory setting"],
  [/NIGHTSHIFT_CHAIN_RPC_URL/g, "the chain RPC setting"],
  // Anything else that leaked through becomes an honest, non-specific label.
  [/NIGHTSHIFT_[A-Z_]+/g, "a server setting"],
];

export function humanize(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
