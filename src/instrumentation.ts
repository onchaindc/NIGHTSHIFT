/**
 * Next.js instrumentation hook: starts the Protocol Watch auto-scheduler when
 * the Node.js server process boots. During production builds this file is not
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
}
