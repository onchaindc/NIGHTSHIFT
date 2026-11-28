import { NextRequest, NextResponse, after } from "next/server";
import { autoCheckEnabled, runAutoScanOnce } from "@/lib/watch/scheduler";
import { cronAuthorized, requestAuthorized } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tick may run free source checks for every due watch; the scan continues
// in the background after this response (after()).
export const maxDuration = 300;

/**
 * GET/POST /api/watches/scheduler-tick - one scheduled Protocol Watch scan.
 *
 * Serverless deployments have no long-lived process, so the in-process
 * interval timer cannot be the worker there. Vercel Cron (or any external
 * scheduler) calls this endpoint; each call performs ONE due-scan exactly
 * like the local worker would: free checks only, lease-guarded against
 * duplicate workers, idempotent via persisted fingerprints (a repeated tick
 * can never double-report a change).
 *
 * Auth: the operator token, or the CRON_SECRET Vercel Cron presents as its
 * bearer token. Fails closed when neither is configured.
 */
async function tick(req: NextRequest) {
  if (!requestAuthorized(req) && !cronAuthorized(req)) {
    return NextResponse.json(
      { error: "authorization required: this deployment gates watch management behind a bearer token (NIGHTSHIFT_API_TOKEN)" },
      { status: 401 },
    );
  }
  if (!autoCheckEnabled()) {
    return NextResponse.json({ ok: true, started: false, reason: "auto checks disabled (NIGHTSHIFT_WATCH_AUTOCHECK=0)" });
  }
  after(async () => {
    // Stall reaper FIRST: any run left mid-flight by a dead execution window is
    // failed cleanly before the scan, so no task sits "executing" forever even
    // when nobody ever reads it (read paths reap too; this is the heartbeat
    // for the nobody-watching case).
    try {
      const { reapStalledTasks } = await import("@/lib/engine/engine");
      const reaped = await reapStalledTasks(Date.now());
      if (reaped > 0) console.log(`stall reaper: failed ${reaped} interrupted run(s)`);
    } catch (err) {
      console.error("stall reaper failed:", err);
    }
    try {
      await runAutoScanOnce();
    } catch (err) {
      console.error("scheduler tick failed:", err);
    }
    // The daily tick is also the slow heartbeat for Telegram reliability
    // jobs that must eventually reconcile even without a fresh deploy or
    // user message: re-register the webhook if the deployment URL drifted,
    // and re-run free Telegram tasks abandoned mid-run. Both are no-ops
    // when there is nothing to do and never fail the watch scan itself.
    try {
      const { reconcileTelegramWebhook } = await import("@/lib/telegram/webhook-register");
      const result = await reconcileTelegramWebhook();
      if (result.action === "registered") console.log(`telegram webhook: ${result.detail}`);
    } catch (err) {
      console.error("telegram webhook reconcile failed:", err);
    }
    try {
      const { recoverAbandonedFreeTasks } = await import("@/lib/telegram/recovery");
      const { recovered } = await recoverAbandonedFreeTasks();
      if (recovered.length) console.log(`recovery finished for: ${recovered.join(", ")}`);
    } catch (err) {
      console.error("abandoned task recovery failed:", err);
    }
    // Mission #02 — Continuous Enterprise Intelligence: the daily cron is the
    // recurring heartbeat for one continuum pass over every tracked entity.
    // Lease-guarded and fingerprint-deduplicated, so a retried or overlapping
    // tick never double-reports; deterministic detections persist even when
    // Hunyuan is unconfigured (the run record states that honestly).
    try {
      const { autoContinuumEnabled, runContinuumTick } = await import("@/lib/hunyuan/continuum");
      if (autoContinuumEnabled()) {
        const result = await runContinuumTick({ trigger: "scheduler" });
        if (result.skippedByOtherWorker) console.log("hunyuan continuum: skipped, another worker holds the tick lease");
        else console.log(`hunyuan continuum: ${result.newEvents} new event(s), ${result.enriched} provider-assessed, ${result.baselinesEstablished} baseline(s)${result.providerError ? `, provider error: ${result.providerError}` : ""}`);
      }
    } catch (err) {
      console.error("hunyuan continuum tick failed:", err);
    }
  });
  return NextResponse.json({ ok: true, started: true });
}

export async function GET(req: NextRequest) {
  return tick(req);
}

export async function POST(req: NextRequest) {
  return tick(req);
}
