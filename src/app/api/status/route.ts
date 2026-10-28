import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/status - truthful system status for the header and the Settings
 * view. Reports only which integrations are CONFIGURED (names, never values)
 * and whether the task store answers. Nothing is fabricated: a missing
 * integration is reported as unconfigured.
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

  return NextResponse.json({
    ok: store === "ok",
    store,
    services,
    defaultSpendLimitCents: (() => {
      const env = Number(process.env.NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS);
      return Number.isFinite(env) && env > 0 ? env : 100;
    })(),
    watchScheduler: (() => {
      const env = Number(process.env.NIGHTSHIFT_WATCH_INTERVAL_MS);
      const intervalMs = Number.isFinite(env) && env >= 30_000 ? env : 600_000;
      return { autoChecks: process.env.NIGHTSHIFT_WATCH_AUTOCHECK !== "0", intervalMs, freeOnly: true };
    })(),
  });
}
