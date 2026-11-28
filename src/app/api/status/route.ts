import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { apiAuthMode } from "@/lib/api/auth";
import { readAuthorized } from "@/lib/api/public";
import {
  choosePersistence,
  dataDir,
  persistenceMode,
} from "@/lib/storage";
import { isDatabaseConfigured, resolveDatabase } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/status - truthful system status for the header and the Settings
 * view. Reports only which integrations are CONFIGURED (names, never values)
 * and whether the task store answers. Nothing is fabricated: a missing
 * integration is reported as unconfigured, a degraded scheduler is named as
 * degraded with its reason.
 */
/**
 * Expensive store probes, cached briefly.
 *
 * Every open dashboard tab polls /api/status, and a full probe runs several
 * live database roundtrips. Polling a database on a tighter loop than the
 * compute's auto-suspend threshold (Neon: 5 min) keeps the database awake
 * around the clock, which exhausted free-tier compute quotas in under a
 * month. A short-lived cache shrinks that to a few connection windows per
 * hour while staying honest: the worst case is a status that is up to
 * PROBE_TTL_MS stale, and a real outage is still reported within minutes.
 */
const PROBE_TTL_MS = 4 * 60_000;
let probed: { at: number; store: "ok" | "unavailable"; connection: "ok" | "unreachable" } | null = null;

async function probeStore(): Promise<{ store: "ok" | "unavailable"; connection: "ok" | "unreachable" }> {
  if (probed && Date.now() - probed.at < PROBE_TTL_MS) {
    return { store: probed.store, connection: probed.connection };
  }
  let store: "ok" | "unavailable" = "unavailable";
  try {
    const { listTasks } = await import("@/lib/engine/store");
    await listTasks();
    store = "ok";
  } catch {
    store = "unavailable";
  }
  let connection: "ok" | "unreachable" = store === "ok" ? "ok" : "unreachable";
  probed = { at: Date.now(), store, connection };
  return { store, connection };
}

export async function GET(req: Request) {
  // Health (services, store verdict, persistence mode, scheduler state) stays
  // public: it is what a status page is for. Infrastructure identifiers —
  // which database ENDPOINT this deployment talks to (hostnames, tried
  // endpoints) and the connect-target digest — are operator-only: they name
  // the private backend and are of no use to an anonymous visitor.
  const operatorView = readAuthorized(req);
  const configured = (key: string) => Boolean(process.env[key]);
  const services = {
    telegraph: configured("TELEGRAPH_EVM_PRIVATE_KEY"),
    telegram: configured("TELEGRAM_BOT_TOKEN"),
    // Tencent Hunyuan (missions #01/#02): server-side inference only; the key
    // never reaches the browser, so this reports configuration, not a value.
    hunyuan: configured("HUNYUAN_API_KEY"),
    chainRpc: true, // the engine falls back to its bundled public Base Sepolia RPC
  };

  let store: "ok" | "unavailable" = "unavailable";
  try {
    const probe = await probeStore();
    store = probe.store;
  } catch {
    store = "unavailable";
  }

  /** Truthful persistence reporting: provider, backend mode, directory (file
   * backends only), and a live durability verdict backed by an actual
   * round-trip-capable store check — never a fabricated "durable" claim.
   * hosts/target (which database endpoint) are operator-only and omitted
   * entirely from anonymous responses. */
  let persistenceReport: {
    mode: string;
    provider: "postgres" | "file";
    dir: string | null;
    durable: boolean;
    connection: "ok" | "unreachable" | "unconfigured";
    reason: string | null;
    hosts?: string[];
    /** Env variable NAMES that supplied candidates (never values). */
    sources: string[];
    /** Short digest of the connect target, so two deployments can be compared
     *  without publishing a project id or a password. Operator-only. */
    target?: string | null;
  };
  try {
    const decision = choosePersistence();
    const chosen = decision.persistence;
    const isPostgres = chosen.provider === "postgres";
    // The expensive live check already ran inside probeStore (cached); a
    // readable store means a connected database. Only the "which backend"
    // decision and non-database configuration are computed per request.
    let connection: "ok" | "unreachable" | "unconfigured" = isPostgres
      ? store === "ok"
        ? "ok"
        : "unreachable"
      : "unconfigured";
    if (isPostgres && !isDatabaseConfigured()) connection = "unconfigured";

    // Which endpoint this deployment is actually talking to. Hostnames only,
    // never credentials: this is the one fact needed to tell "wrong database
    // configured" apart from "database is down" without opening a dashboard.
    // Operator-only: an anonymous status page reports the connection verdict,
    // not the endpoint behind it.
    let hosts: string[] = [];
    if (operatorView && isPostgres && isDatabaseConfigured()) {
      try {
        const resolved = await resolveDatabase();
        hosts = resolved.ok
          ? resolved.host
            ? [resolved.host]
            : []
          : resolved.tried.map((t) => `${t.host ?? "unknown host"} (${t.error ?? "unreachable"})`);
      } catch {
        hosts = [];
      }
    }

    const sources = ["NIGHTSHIFT_DATABASE_URL", "DATABASE_URL", "DATABASE_URL_UNPOOLED"].filter((k) =>
      Boolean(process.env[k]?.trim()),
    );
    let target: string | null = null;
    if (operatorView && isPostgres && isDatabaseConfigured()) {
      try {
        const { databaseUrl } = await import("@/lib/db/client");
        const url = databaseUrl();
        if (url) {
          // username + host identify the tenant; the digest keeps it private.
          const parsed = new URL(url);
          target = createHash("sha256").update(`${parsed.username}@${parsed.host}${parsed.pathname}`).digest("hex").slice(0, 10);
        }
      } catch {
        target = null;
      }
    }

    persistenceReport = {
      mode: persistenceMode(),
      provider: chosen.provider,
      dir: isPostgres ? null : dataDir(),
      durable: isPostgres,
      connection,
      reason: decision.reason,
      // JSON.stringify drops undefined keys: anonymous responses omit the
      // endpoint identifiers entirely instead of sending empty values.
      hosts: operatorView ? hosts : undefined,
      sources,
      target: operatorView ? target : undefined,
    };
  } catch (err) {
    persistenceReport = {
      mode: persistenceMode(),
      provider: "file",
      dir: null,
      durable: false,
      connection: "unreachable",
      reason: err instanceof Error ? err.message : String(err),
      hosts: operatorView ? [] : undefined,
      sources: [],
      target: null,
    };
  }

  // The scheduler reports its persisted tick state; a stopped or restarted
  // process cannot claim to have been monitoring while it was not running.
  let watchScheduler: {
    autoChecks: boolean;
    intervalMs: number;
    freeOnly: boolean;
    workerMode: "in-process" | "external-trigger";
    degraded: boolean;
    degradedReason: string | null;
    lastSuccessAt: number | null;
    consecutiveFailures: number;
    cronHint: string;
  } = {
    autoChecks: false,
    intervalMs: 600_000,
    freeOnly: true,
    workerMode: "in-process",
    degraded: true,
    degradedReason: "scheduler status unavailable",
    lastSuccessAt: null,
    consecutiveFailures: 0,
    cronHint: "vercel.json cron: once daily (Hobby limit)",
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
      lastSuccessAt: s.lastSuccessAt,
      consecutiveFailures: s.consecutiveFailures,
      cronHint: s.workerMode === "external-trigger" ? "vercel.json cron: once daily" : "in-process interval",
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
    operatorSession: operatorView,
    persistence: persistenceReport,
    watchScheduler,
  });
}
