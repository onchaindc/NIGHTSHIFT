import { describe, expect, it } from "vitest";

import { catalogProviderView, type AcpRuntimeState } from "@/lib/acp/runtime";
import type { AcpConfig } from "@/lib/acp/transport";

/**
 * The catalog's provider view — the "offerings never load" regression
 * contract. The view must be computable from configuration and the persisted
 * runtime record ALONE (cold and warm independently): it must never need the
 * transport to boot, and its honesty fields (connected, attemptState, note)
 * must reflect exactly the record it was given — never a fabricated success.
 */

const CFG: AcpConfig = {
  enabled: true,
  walletAddress: "0x00000000000000000000000000000000000provider",
  walletId: "wallet-id",
  signerKey: "signer-key",
  builderCode: "",
  chainId: 8453,
};

function storedRecord(over: Partial<AcpRuntimeState> = {}): AcpRuntimeState {
  const now = new Date().toISOString();
  return {
    attemptState: "started",
    startupError: null,
    connected: true,
    mode: "real",
    startedAt: now,
    streamObservedAt: now,
    updatedAt: now,
    note: null,
    registration: { found: true, detail: "registered", checkedAt: now },
    ...over,
  };
}

describe("catalogProviderView — cold (no persisted record)", () => {
  const view = catalogProviderView(CFG, null, true, { nowMs: 1_700_000_000_000 });

  it("stays honest: nothing started, nothing connected", () => {
    expect(view.attemptState).toBe("idle");
    expect(view.runtimeStarted).toBe(false);
    expect(view.connected).toBe(null);
    expect(view.mode).toBe("real");
  });

  it("never fabricates a live provider from configuration alone", () => {
    // The catalog route's live badge is mode === "real" && connected === true;
    // cold means connected is null, so the badge CANNOT claim live.
    expect(view.connected).not.toBe(true);
  });

  it("says that no boot attempt has been recorded", () => {
    expect(view.note).toContain("No boot attempt has been recorded yet");
  });

  it("still carries the provider wallet and chain for the desk", () => {
    expect(view.agentWalletAddress).toBe(CFG.walletAddress);
    expect(view.chainId).toBe(8453);
  });
});

describe("catalogProviderView — warm (fresh started record)", () => {
  const nowMs = 1_700_000_000_000;
  const view = catalogProviderView(CFG, storedRecord({ streamObservedAt: new Date(nowMs - 60_000).toISOString() }), true, { nowMs });

  it("reports the transport as started and connected", () => {
    expect(view.attemptState).toBe("started");
    expect(view.runtimeStarted).toBe(true);
    expect(view.connected).toBe(true);
  });

  it("anchors the note to the record's age", () => {
    expect(view.note).toContain("1 min ago");
    expect(view.note).toContain("never waited on the provider");
  });
});

describe("catalogProviderView — stale and failed records stay truthful", () => {
  it("reports the age of an old record instead of hiding it", () => {
    const nowMs = 1_700_000_000_000;
    const view = catalogProviderView(CFG, storedRecord({ streamObservedAt: new Date(nowMs - 3 * 60 * 60_000).toISOString() }), true, { nowMs });
    expect(view.note).toContain("180 min ago");
    expect(view.connected).toBe(true); // still the record's word, now with its age attached
  });

  it("surfaces a failed startup as failed — never as connected", () => {
    const view = catalogProviderView(
      CFG,
      storedRecord({ attemptState: "failed", connected: null, startupError: "transport.start() did not resolve within 45s" }),
      true,
    );
    expect(view.attemptState).toBe("failed");
    expect(view.startupError).toContain("did not resolve");
    expect(view.connected).toBe(null);
    expect(view.note).toContain("FAILED");
  });

  it("disconnected record reports disconnected", () => {
    const view = catalogProviderView(CFG, storedRecord({ connected: false }), true);
    expect(view.connected).toBe(false);
  });
});

describe("catalogProviderView — configuration honesty", () => {
  it("disabled provider is disabled", () => {
    const view = catalogProviderView({ ...CFG, enabled: false }, storedRecord(), true);
    expect(view.mode).toBe("disabled");
    expect(view.note).toContain("ACP_ENABLED is not set");
    expect(view.agentWalletAddress).toBe(null);
  });

  it("enabled but uncredentialed falls back to the mock transport", () => {
    const view = catalogProviderView({ ...CFG, walletAddress: "", walletId: "", signerKey: "" }, null, false);
    expect(view.mode).toBe("mock");
    expect(view.note).toContain("mock transport");
  });
});
