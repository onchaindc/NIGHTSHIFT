/**
 * Next.js instrumentation hook: on Node.js server boot it (1) starts the
 * Protocol Watch auto-scheduler, (2) reconciles the Telegram webhook
 * registration so a deployment always points Telegram at the live public
 * URL (a stale webhook URL was the production failure that made the bot
 * unresponsive), and (3) re-runs Telegram free-mode tasks left `executing`
 * by a dead instance. During production builds this file is not executed as
 * the server, so no check can run while merely building.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startWatchScheduler } = await import("@/lib/watch/scheduler");
    startWatchScheduler();
  } catch (err) {
    console.error("failed to start the protocol watch scheduler:", err);
  }

  // Boot-time Telegram reconciliation: run in the background, never block
  // startup, never escalate — the webhook route keeps working regardless.
  void (async () => {
    try {
      const { reconcileTelegramWebhook } = await import("@/lib/telegram/webhook-register");
      const result = await reconcileTelegramWebhook();
      if (result.action !== "current") {
        console.log(`telegram webhook reconcile at boot: ${result.action} — ${result.detail}`);
      }
    } catch (err) {
      console.error("telegram webhook reconcile failed:", err);
    }
    try {
      const { recoverAbandonedFreeTasks } = await import("@/lib/telegram/recovery");
      const { recovered } = await recoverAbandonedFreeTasks();
      if (recovered.length) console.log(`recovery: resumed ${recovered.length} abandoned task(s)`);
    } catch (err) {
      console.error("abandoned task recovery failed:", err);
    }
  })();
}
