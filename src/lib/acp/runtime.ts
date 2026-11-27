/**
 * The ACP provider runtime: selects and starts the transport once per server
 * process, exposes the handler for entries, and offers one guarded entry
 * point for the boot hook and the API routes.
 *
 * Startup honesty across bundle boundaries: Next compiles `instrumentation.ts`
 * separately from route handlers, so module-level state in the boot bundle is
 * INVISIBLE to /api/acp/status. The authoritative runtime state therefore
 * lives in a persisted named document (`acp-runtime-state`): the boot bundle
 * writes its attempt outcome and stream events there, and the status endpoint
 * reads it back. A configured-but-broken real mode, a hanging connect, and a
 * live connected stream are all distinguishable in production.
 */

import { persistence } from "@/lib/storage";

import { handleAcpEntry, tickAcpJobs } from "./lifecycle";
import { acpConfig, realAcpConfigured, selectAcpTransport, MockAcpTransport, acpSdkInstalled } from "./transport";
import type { AcpConfig } from "./transport";
import type { AcpEntry, AcpProviderStatus, AcpSessionRef, AcpTransport } from "./types";

/** A start() that has not resolved after this long is recorded as failed —
 *  the underlying connect may still be retried by the SDK, but the operator
 *  must see that the runtime never became usable. */
const START_TIMEOUT_MS = 45_000;

const STATE_DOC = "acp-runtime-state";

export interface AcpRuntimeState {
  attemptState: "idle" | "starting" | "started" | "failed";
  startupError: string | null;
  connected: boolean | null;
  mode: "real" | "mock" | null;
  startedAt: string | null;
  streamObservedAt: string | null;
  updatedAt: string;
  note: string | null;
  registration: { found: boolean | null; detail: string | null; checkedAt: string | null };
}

let transport: AcpTransport | null = null;
let startNote = "not started";
let startupError: string | null = null;
let starting: Promise<void> | null = null;

/** Merge-write the persisted runtime state: presence-based merging — a field
 *  present in the patch (even explicitly null, e.g. a successful boot CLEARING
 *  startupError) wins; absent fields keep the previous record. Nullish
 *  coalescing would resurrect stale errors forever, which a live probe
 *  actually demonstrated on production. */
async function writeRuntimeState(patch: Partial<Omit<AcpRuntimeState, "attemptState" | "updatedAt">> & { attemptState: AcpRuntimeState["attemptState"] }): Promise<void> {
  try {
    const prev = await persistence().readNamed<AcpRuntimeState>(STATE_DOC);
    const merged = <K extends keyof Omit<AcpRuntimeState, "attemptState" | "updatedAt">>(key: K): AcpRuntimeState[K] =>
      (key in patch ? (patch as AcpRuntimeState)[key] : (prev ? prev[key] : null)) as AcpRuntimeState[K];
    const next: AcpRuntimeState = {
      attemptState: patch.attemptState,
      startupError: merged("startupError"),
      connected: merged("connected"),
      mode: merged("mode"),
      startedAt: merged("startedAt"),
      streamObservedAt: merged("streamObservedAt"),
      updatedAt: new Date().toISOString(),
      note: merged("note"),
      registration: merged("registration") ?? { found: null, detail: null, checkedAt: null },
    };
    await persistence().writeNamed(STATE_DOC, next);
  } catch (err) {
    console.error("failed to persist the ACP runtime state:", err instanceof Error ? err.message : err);
  }
}

async function readRuntimeState(): Promise<AcpRuntimeState | null> {
  try {
    const stored = await persistence().readNamed<AcpRuntimeState>(STATE_DOC);
    return stored && stored.attemptState ? stored : null;
  } catch {
    return null; // store unreachable — status degrades to local truth only
  }
}

/** Start (once) and return the active transport, or null when off/failed. */
export async function ensureAcpRuntime(): Promise<AcpTransport | null> {
  if (transport) return transport;
  if (starting) return starting.then(() => transport);
  starting = (async () => {
    const selected = await selectAcpTransport();
    if (!selected.transport) {
      startNote = selected.reason;
      transport = null;
      startupError = selected.reason.includes("failed to start") ? selected.reason : null;
      starting = null;
      await writeRuntimeState({
        attemptState: "failed",
        startupError,
        connected: null,
        mode: null,
        startedAt: null,
        streamObservedAt: null,
        note: selected.reason,
      });
      return;
    }
    startingDiagnostics = selected.transport.diagnostics?.bind(selected.transport) ?? null;
    try {
      await Promise.race([
        selected.transport.start({
          onEntry: async (ref, entry) => {
            await handleAcpEntry(selected.transport!, ref, entry);
          },
          onStreamState: (connected) => {
            void writeRuntimeState({
              attemptState: "started",
              startupError: null,
              connected,
              streamObservedAt: new Date().toISOString(),
              note: `live SSE stream ${connected ? "connected" : "closed"}`,
            });
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`transport.start() did not resolve within ${Math.round(START_TIMEOUT_MS / 1000)}s — the SSE connect or session hydration is hanging`)),
            START_TIMEOUT_MS,
          ),
        ),
      ]);
      transport = selected.transport;
      startupError = null;
      startNote = selected.reason;
      // Registration check through the LIVE authenticated client: what does
      // the ACP server actually see for this wallet?
      let registration: AcpRuntimeState["registration"] = { found: null, detail: null, checkedAt: null };
      try {
        const check = await selected.transport.verifyRegistration?.();
        registration = { found: check?.found ?? null, detail: check?.detail ?? null, checkedAt: new Date().toISOString() };
        if (check && !check.found) console.error("ACP registration check failed:", check.detail);
      } catch (err) {
        registration = { found: null, detail: `registration check failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, checkedAt: new Date().toISOString() };
      }
      await writeRuntimeState({
        attemptState: "started",
        startupError: null,
        connected: selected.transport.diagnostics?.().connected ?? null,
        mode: selected.transport.mode,
        startedAt: new Date().toISOString(),
        streamObservedAt: new Date().toISOString(),
        note: selected.reason,
        registration,
      });
    } catch (err) {
      // A start() that merely EXCEEDED the window but whose SSE stream is up
      // (the SDK finished connecting late) is a slow success, not a failure —
      // record it as started; a genuinely broken connect reports failed.
      const diag = startingDiagnostics?.() ?? null;
      if (diag?.connected === true) {
        transport = selected.transport;
        startupError = null;
        startNote = `started slowly (start() exceeded ${Math.round(START_TIMEOUT_MS / 1000)}s) but the SSE stream is connected`;
        await writeRuntimeState({
          attemptState: "started",
          startupError: null,
          connected: true,
          mode: selected.transport.mode,
          startedAt: new Date().toISOString(),
          streamObservedAt: new Date().toISOString(),
          note: startNote,
        });
        return;
      }
      transport = null;
      startupError = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      startNote = `transport startup failed: ${startupError}`;
      await writeRuntimeState({
        attemptState: "failed",
        startupError,
        connected: diag?.connected ?? null,
        mode: realAcpConfigured() ? "real" : "mock",
        startedAt: null,
        streamObservedAt: new Date().toISOString(),
        note: startNote,
      });
    } finally {
      starting = null;
    }
  })();
  await starting;
  return transport;
}

/** Diagnostics of a transport that is constructed but still starting — the
 *  only window into the stream state while hydration is in flight. */
let startingDiagnostics: (() => { connected: boolean | null; lastError: string | null }) | null = null;

/** Process one entry through the real pipeline (used by the simulate action).
 *  When the provider is disabled, a standalone mock still runs the pipeline —
 *  the simulate action is always a simulated buyer, never a live one. */
export async function processAcpEntry(ref: AcpSessionRef, entry: AcpEntry): Promise<void> {
  const active = (await ensureAcpRuntime()) ?? new MockAcpTransport();
  await handleAcpEntry(active, ref, entry);
}

/** Advance every open job (delivery/tick) and refresh the persisted stream
 *  state, so the status stays truthful between stream events. */
export async function runAcpTick(): Promise<{ advanced: number; submitted: string[]; notes: string[] }> {
  const active = await ensureAcpRuntime();
  if (!active) return { advanced: 0, submitted: [], notes: [startNote] };
  const result = await tickAcpJobs(active);
  const diag = active.diagnostics?.() ?? null;
  if (diag) {
    await writeRuntimeState({
      attemptState: "started",
      startupError: null,
      connected: diag.connected,
      streamObservedAt: new Date().toISOString(),
      note: diag.lastError ? `last entry-handler error: ${diag.lastError}` : null,
    });
  }
  return result;
}

/** How stale the persisted stream observation may get before a status call
 *  is allowed to boot (or re-boot) the transport from the route bundle —
 *  a serverless instance can die between stream events, and a record that
 *  nobody refreshes must not masquerade as a live provider. */
const STREAM_STALE_MS = 3 * 60_000;

/** The provider connection status, honest to the field. If the persisted
 *  record is stale (no live writer) and the provider is configured, status
 *  LAZILY BOOTS the transport in this process — self-healing: the status page
 *  is operator-facing and must reflect and restore the actual state, not
 *  repeat a dead instance's last word. */
export async function acpProviderStatus(): Promise<AcpProviderStatus> {
  const cfg = acpConfig();
  const sdkInstalled = cfg.enabled ? await acpSdkInstalled() : false;
  let active = transport;
  // Read the persisted record even when a transport runs in THIS process:
  // the boot bundle wrote the authoritative startup + registration facts.
  let stored = await readRuntimeState();
  const stale =
    cfg.enabled &&
    realAcpConfigured() &&
    !active &&
    (!stored || stored.attemptState !== "started" || !stored.streamObservedAt || Date.now() - Date.parse(stored.streamObservedAt) > STREAM_STALE_MS);
  if (stale) {
    await ensureAcpRuntime();
    active = transport;
    stored = await readRuntimeState();
  }
  const mode: AcpProviderStatus["mode"] = !cfg.enabled ? "disabled" : active ? active.mode : realAcpConfigured() ? "real" : "mock";
  const diag = active?.diagnostics?.() ?? null;
  const started = active !== null || stored?.attemptState === "started";
  const connected = active ? (diag?.connected ?? null) : (stored?.connected ?? null);
  const streamObservedAt = active ? new Date().toISOString() : (stored?.streamObservedAt ?? null);
  const startupError = active ? null : (stored?.startupError ?? null);
  const note = active
    ? diag?.lastError
      ? `${startNote} — last entry-handler error: ${diag.lastError}`
      : startNote
    : !cfg.enabled
      ? "ACP_ENABLED is not set — the ACP provider is off; offerings below are published configuration, not a live connection."
      : stored?.attemptState === "started"
        ? `The live transport started at ${stored.startedAt ?? "?"} (recorded from the server boot) and the SSE stream was last observed ${streamObservedAt}.`
        : stored?.attemptState === "starting"
          ? "A startup attempt is in flight (recorded from the server boot)."
          : startupError
            ? `Live ACP transport is configured but its startup FAILED: ${startupError}`
            : realAcpConfigured()
              ? "Live ACP transport configured; starts with the server boot (instrumentation hook). No boot attempt has been recorded yet."
              : "No ACP credentials configured — the mock transport serves simulated buyers only; nothing connects to the ACP network.";
  return {
    mode,
    enabled: cfg.enabled,
    sdkInstalled,
    credentials: {
      walletAddress: Boolean(cfg.walletAddress),
      walletId: Boolean(cfg.walletId),
      signerKey: Boolean(cfg.signerKey),
    },
    agentWalletAddress: mode === "real" ? cfg.walletAddress || null : null,
    chainId: cfg.chainId,
    note,
    runtimeStarted: started,
    startupError: startupError ?? (diag?.lastError ? `last entry-handler error: ${diag.lastError}` : null),
    connected: mode === "real" ? connected : null,
    attemptState: active ? "started" : (stored?.attemptState ?? "idle"),
    startedAt: stored?.startedAt ?? null,
    streamObservedAt,
    registration: stored?.registration ?? { found: null, detail: null, checkedAt: null },
  };
}

/**
 * The catalog's provider view, computed ONLY from configuration and the
 * persisted runtime record — it never constructs, boots, awaits or touches
 * the transport. The storefront's critical path must not depend on the ACP
 * provider's startup: that coupling was the "offerings never load" failure
 * (a cold catalog request paid the full Privy/ACP handshake inside the
 * request, and a hung handshake hung the storefront forever). Freshness is
 * the instrumentation boot's, the status endpoint's and the tick cron's job;
 * buyer-facing reads stay instant and truthful about what they know.
 */
export function catalogProviderView(
  cfg: AcpConfig,
  stored: AcpRuntimeState | null,
  sdkInstalled: boolean,
  opts: { nowMs?: number } = {},
): AcpProviderStatus {
  const nowMs = opts.nowMs ?? Date.now();
  // Purity rule: everything is derived from the ARGUMENTS — realAcpConfigured()
  // reads process.env, which would make this "pure" view silently depend on
  // the test/server environment instead of the config it was handed.
  const configured = Boolean(cfg.enabled && cfg.walletAddress && cfg.walletId && cfg.signerKey);
  const mode: AcpProviderStatus["mode"] = !cfg.enabled ? "disabled" : configured ? "real" : "mock";
  const attemptState = stored?.attemptState ?? "idle";
  const connected = mode === "real" ? (stored?.connected ?? null) : null;
  const observedAt = stored?.streamObservedAt ?? null;
  const ageMin = observedAt && Number.isFinite(Date.parse(observedAt)) ? Math.max(0, Math.round((nowMs - Date.parse(observedAt)) / 60_000)) : null;
  const note = !cfg.enabled
    ? "ACP_ENABLED is not set — the ACP provider is off; offerings below are published configuration, not a live connection."
    : attemptState === "started"
      ? `The live transport started at ${stored?.startedAt ?? "?"} and the SSE stream was last observed ${observedAt ?? "?"}${ageMin !== null ? ` (${ageMin} min ago)` : ""}. This catalog never waited on the provider to answer.`
      : attemptState === "failed"
        ? `The last recorded provider startup FAILED: ${stored?.startupError ?? "unknown reason"}. Published offerings still list; the provider must recover before it can price jobs.`
        : attemptState === "starting"
          ? "A provider startup attempt is in flight (recorded from the server boot)."
          : configured
            ? "Live ACP transport configured; it starts with the server boot. No boot attempt has been recorded yet."
            : "No ACP credentials configured — the mock transport serves simulated buyers only; nothing connects to the ACP network.";
  return {
    mode,
    enabled: cfg.enabled,
    sdkInstalled,
    credentials: {
      walletAddress: Boolean(cfg.walletAddress),
      walletId: Boolean(cfg.walletId),
      signerKey: Boolean(cfg.signerKey),
    },
    agentWalletAddress: mode === "real" ? cfg.walletAddress || null : null,
    chainId: cfg.chainId,
    note,
    runtimeStarted: attemptState === "started",
    startupError: attemptState === "failed" ? (stored?.startupError ?? null) : null,
    connected,
    attemptState,
    startedAt: stored?.startedAt ?? null,
    streamObservedAt: observedAt,
    registration: stored?.registration ?? { found: null, detail: null, checkedAt: null },
  };
}

/**
 * The provider snapshot for buyer-facing reads (the catalog): configuration
 * plus the persisted record, never a boot. Same shape as acpProviderStatus
 * so consumers cannot tell the difference — they just never wait.
 */
export async function acpProviderSnapshot(): Promise<AcpProviderStatus> {
  const cfg = acpConfig();
  const sdk = cfg.enabled ? await acpSdkInstalled() : false;
  const stored = await readRuntimeState();
  return catalogProviderView(cfg, stored, sdk);
}
