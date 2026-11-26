/**
 * Next.js instrumentation hook: on Node.js server boot it (1) starts the
 * Protocol Watch auto-scheduler, (2) boots the ACP provider runtime (real
 * transport with credentials, mock for simulated buyers, nothing when
 * ACP_ENABLED is unset) and advances any open ACP jobs, (3) reconciles the
 * Telegram webhook registration so a deployment always points Telegram at
 * the live public URL (a stale webhook URL was the production failure that
 * made the bot unresponsive), and (4) re-runs Telegram free-mode tasks left
 * `executing` by a dead instance. During production builds this file is not
 * executed as the server, so no check can run while merely building.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startWatchScheduler } = await import("@/lib/watch/scheduler");
    startWatchScheduler();
  } catch (err) {
    console.error("failed to start the protocol watch scheduler:", err);
  }

  // ACP provider boot: start the transport (real when credentials are set,
  // mock for the simulated-buyer slice, nothing at all when ACP_ENABLED is
  // unset) and advance any open jobs. Background, never blocks startup.
  void (async () => {
    try {
      const { ensureAcpRuntime, runAcpTick } = await import("@/lib/acp/runtime");
      const transport = await ensureAcpRuntime();
      if (transport) {
        console.log(`ACP provider runtime started (${transport.mode} transport)`);
        const tick = await runAcpTick();
        if (tick.submitted.length) console.log(`ACP tick at boot: submitted ${tick.submitted.length} deliverable(s)`);
      }
    } catch (err) {
      console.error("ACP provider boot failed:", err);
    }
  })();

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
