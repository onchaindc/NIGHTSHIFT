import { NextResponse } from "next/server";
import { apiAuthMode } from "@/lib/api/auth";
import {
  choosePersistence,
  dataDir,
  persistenceMode,
} from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/status - truthful system status for the header and the Settings
 * view. Reports only which integrations are CONFIGURED (names, never values)
 * and whether the task store answers. Nothing is fabricated: a missing
 * integration is reported as unconfigured, a degraded scheduler is named as
 * degraded with its reason.
 */
export async function GET() {
  const configured = (key: string) => Boolean(process.env[key]);
  const services = {
    telegraph: configured("TELEGRAPH_EVM_PRIVATE_KEY"),
    telegram: configured("TELEGRAM_BOT_TOKEN"),
    chainRpc: true, // the engine falls back to its bundled public Base Sepolia RPC
  };

  let store: "ok" | "unavailable" = "unavailable";
  try {
    const { listTasks } = await import("@/lib/engine/store");
    await listTasks();
    store = "ok";
  } catch {
    store = "unavailable";
  }

  /** Truthful persistence reporting: provider, backend mode, directory (file
   * backends only), and a live durability verdict backed by an actual
   * round-trip-capable store check — never a fabricated "durable" claim. */
  let persistenceReport: {
    mode: string;
    provider: "postgres" | "file";
    dir: string | null;
    durable: boolean;
    connection: "ok" | "unreachable" | "unconfigured";
    reason: string | null;
  };
  try {
    const decision = choosePersistence();
    const chosen = decision.persistence;
    const isPostgres = chosen.provider === "postgres";
    let connection: "ok" | "unreachable" | "unconfigured" = isPostgres ? "unreachable" : "unconfigured";
    if (isPostgres) {
      try {
        await chosen.ready();
        connection = await chosen.health();
      } catch (err) {
        // A configured database that cannot be reached must NOT be silently
        // downgraded to a non-durable story in the report: keep provider truth.
        connection = "unreachable";
        console.error("persistence health check failed:", err instanceof Error ? err.message : err);
      }
    }
    persistenceReport = {
      mode: persistenceMode(),
      provider: chosen.provider,
      dir: isPostgres ? null : dataDir(),
      durable: isPostgres,
      connection,
      reason: decision.reason,
    };
  } catch (err) {
    persistenceReport = {
      mode: persistenceMode(),
      provider: "file",
      dir: null,
      durable: false,
      connection: "unreachable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // The scheduler reports its persisted tick state; a stopped or restarted
  // process cannot claim to have been monitoring while it was not running.
  let watchScheduler: { autoChecks: boolean; intervalMs: number; freeOnly: boolean; workerMode: "in-process" | "external-trigger"; degraded: boolean; degradedReason: string | null } = {
    autoChecks: false,
    intervalMs: 600_000,
    freeOnly: true,
    workerMode: "in-process",
    degraded: true,
    degradedReason: "scheduler status unavailable",
  };
  try {
    const { schedulerStatus } = await import("@/lib/watch/scheduler");
    const s = await schedulerStatus();
    watchScheduler = {
      autoChecks: s.autoChecks,
      intervalMs: s.intervalMs,
      freeOnly: true,
      workerMode: s.workerMode,
      degraded: s.degraded,
      degradedReason: s.degradedReason,
    };
  } catch {
    // keep the honest default above
  }

  return NextResponse.json({
    ok: store === "ok",
    store,
    services,
    defaultSpendLimitCents: (() => {
      const env = Number(process.env.NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS);
      return Number.isFinite(env) && env > 0 ? env : 100;
    })(),
    apiAuth: apiAuthMode(),
    persistence: persistenceReport,
    watchScheduler,
  });
}
