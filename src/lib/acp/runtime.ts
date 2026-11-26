/**
 * The ACP provider runtime: selects and starts the transport once per server
 * process, exposes the handler for entries, and offers one guarded entry
 * point for the boot hook and the API routes.
 *
 * Startup honesty: `attemptState` says idle / starting / started / failed
 * about the ACTUAL `transport.start(...)` call in THIS server process,
 * `startupError` carries the exact failure, and `connected` reflects the live
 * SSE stream (the SDK's onConnected callback) — readable even while session
 * hydration is still in flight. Configuration alone never reports a
 * connection, and a startup that never resolves is failed visibly after the
 * timeout, not silently forever.
 */

import { handleAcpEntry, tickAcpJobs } from "./lifecycle";
import { acpConfig, realAcpConfigured, selectAcpTransport, MockAcpTransport, acpSdkInstalled } from "./transport";
import type { AcpEntry, AcpProviderStatus, AcpSessionRef, AcpTransport } from "./types";

/** A start() that has not resolved after this long is recorded as failed —
 *  the underlying connect may still be retried by the SDK, but the operator
 *  must see that the runtime never became usable. */
const START_TIMEOUT_MS = 45_000;

let transport: AcpTransport | null = null;
let startNote = "not started";
let attemptState: "idle" | "starting" | "started" | "failed" = "idle";
let startupError: string | null = null;
/** Diagnostics of a transport that is constructed but still starting — the
 *  only window into the stream state while hydration is in flight. */
let startingDiagnostics: (() => { connected: boolean | null; lastError: string | null }) | null = null;
let starting: Promise<void> | null = null;

/** Start (once) and return the active transport, or null when off/failed. */
export async function ensureAcpRuntime(): Promise<AcpTransport | null> {
  if (transport) return transport;
  if (attemptState === "failed") return null; // sticky failure — the status shows why
  if (!starting) {
    attemptState = "starting";
    startupError = null;
    starting = (async () => {
      const selected = await selectAcpTransport();
      if (!selected.transport) {
        startNote = selected.reason;
        attemptState = "failed";
        startupError = selected.reason.includes("failed to start") ? selected.reason : null;
        startingDiagnostics = null;
        return;
      }
      startingDiagnostics = selected.transport.diagnostics?.bind(selected.transport) ?? null;
      try {
        await Promise.race([
          selected.transport.start({
            onEntry: async (ref, entry) => {
              await handleAcpEntry(selected.transport!, ref, entry);
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
        attemptState = "started";
        startupError = null;
        startNote = selected.reason;
      } catch (err) {
        transport = null;
        attemptState = "failed";
        startupError = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        startNote = `transport startup failed: ${startupError}`;
      }
    })();
  }
  await starting;
  return transport;
}

/** Process one entry through the real pipeline (used by the simulate action).
 *  When the provider is disabled, a standalone mock still runs the pipeline —
 *  the simulate action is always a simulated buyer, never a live one. */
export async function processAcpEntry(ref: AcpSessionRef, entry: AcpEntry): Promise<void> {
  const active = (await ensureAcpRuntime()) ?? new MockAcpTransport();
  await handleAcpEntry(active, ref, entry);
}

/** Advance every open job (delivery/tick). */
export async function runAcpTick(): Promise<{ advanced: number; submitted: string[]; notes: string[] }> {
  const active = await ensureAcpRuntime();
  if (!active) return { advanced: 0, submitted: [], notes: [startNote] };
  return tickAcpJobs(active);
}

/** The provider connection status, honest to the field. Never starts the
 *  transport itself — status must stay cheap. */
export async function acpProviderStatus(): Promise<AcpProviderStatus> {
  const cfg = acpConfig();
  const sdkInstalled = cfg.enabled ? await acpSdkInstalled() : false;
  const active = transport;
  const mode: AcpProviderStatus["mode"] = !cfg.enabled ? "disabled" : active ? active.mode : realAcpConfigured() ? "real" : "mock";
  const diag = (active ?? null)?.diagnostics?.() ?? startingDiagnostics?.() ?? null;
  const note = active
    ? diag?.lastError
      ? `${startNote} — last entry-handler error: ${diag.lastError}`
      : startNote
    : !cfg.enabled
      ? "ACP_ENABLED is not set — the ACP provider is off; offerings below are published configuration, not a live connection."
      : startupError
        ? `Live ACP transport is configured but its startup FAILED: ${startupError}`
        : realAcpConfigured()
          ? "Live ACP transport configured; starts with the server boot (instrumentation hook)."
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
    runtimeStarted: attemptState === "started" && active !== null,
    startupError: startupError ?? (diag?.lastError ? `last entry-handler error: ${diag.lastError}` : null),
    connected: mode === "real" ? (diag?.connected ?? null) : null,
    attemptState,
  };
}
