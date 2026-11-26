/**
 * The ACP provider runtime: selects and starts the transport once per server
 * process, exposes the handler for entries, and offers one guarded entry
 * point for the boot hook and the API routes.
 *
 * Startup honesty: `runtimeStarted` is true only after a transport's
 * `start(...)` resolved, `startupError` carries the exact failure otherwise,
 * and `connected` reflects the live SSE stream (the SDK's onConnected
 * callback). Configuration alone never reports a connection.
 */

import { handleAcpEntry, tickAcpJobs } from "./lifecycle";
import { acpConfig, realAcpConfigured, selectAcpTransport, MockAcpTransport, acpSdkInstalled } from "./transport";
import type { AcpEntry, AcpProviderStatus, AcpSessionRef, AcpTransport } from "./types";

let transport: AcpTransport | null = null;
let startNote = "not started";
let runtimeStarted = false;
let startupError: string | null = null;
let starting: Promise<void> | null = null;

/** Start (once) and return the active transport, or null when disabled. */
export async function ensureAcpRuntime(): Promise<AcpTransport | null> {
  if (transport) return transport;
  if (starting) return starting.then(() => transport);
  starting = (async () => {
    const selected = await selectAcpTransport();
    if (!selected.transport) {
      startNote = selected.reason;
      transport = null;
      runtimeStarted = false;
      startupError = selected.reason.includes("failed to start") ? selected.reason : null;
      return;
    }
    try {
      await selected.transport.start({
        onEntry: async (ref, entry) => {
          await handleAcpEntry(selected.transport!, ref, entry);
        },
      });
      transport = selected.transport;
      runtimeStarted = true;
      startupError = null;
      startNote = selected.reason;
    } catch (err) {
      transport = null;
      runtimeStarted = false;
      startupError = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      startNote = `transport startup failed: ${startupError}`;
    }
  })();
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
  const diag = active?.diagnostics?.() ?? null;
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
    runtimeStarted: runtimeStarted && active !== null,
    startupError: startupError ?? (diag?.lastError ? `last entry-handler error: ${diag.lastError}` : null),
    connected: mode === "real" ? (diag?.connected ?? null) : null,
  };
}
