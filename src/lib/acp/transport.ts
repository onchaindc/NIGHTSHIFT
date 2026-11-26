/**
 * The ACP transport boundary: everything NIGHTSHIFT does with the Virtuals
 * ACP network goes through `AcpTransport`. Two implementations:
 *
 *   MockAcpTransport — the in-process transport that drives the vertical
 *     slice without credentials: a simulated buyer injects job.created /
 *     requirement / fund / evaluator decisions, every call NIGHTSHIFT makes
 *     is recorded, and the full provider pipeline (validation, pricing,
 *     investigation, delivery) is the REAL one. Used by tests and by the
 *     operator-facing simulate action.
 *
 *   createRealAcpTransport — the live adapter for `@virtuals-protocol/acp-node-v2`
 *     (a real dependency). It is wired ONLY when the operator sets
 *     ACP_ENABLED=true plus the three credentials (agent wallet address,
 *     Privy wallet id, signer key from the agent page's Signers tab). The
 *     import stays lazy so server bundles stay light; a real mode whose
 *     startup fails is reported honestly in the status — never a faked
 *     connection.
 */

import { base } from "viem/chains";
import type * as AcpSdk from "@virtuals-protocol/acp-node-v2";

import type { AcpEntry, AcpSessionRef, AcpTransport } from "./types";

export interface MockCall {
  op: "setBudget" | "submit" | "sendMessage";
  ref: AcpSessionRef;
  amountUsdCents?: number;
  content?: string;
}

export class MockAcpTransport implements AcpTransport {
  readonly mode = "mock" as const;
  readonly calls: MockCall[] = [];
  private handlers: { onEntry: (ref: AcpSessionRef, entry: AcpEntry) => Promise<void> } | null = null;
  /** Sessions the evaluator has not yet decided on — the mock's open state. */
  readonly openSessions = new Set<string>();

  async start(handlers: { onEntry: (ref: AcpSessionRef, entry: AcpEntry) => Promise<void> }): Promise<void> {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.handlers = null;
  }

  async setBudget(ref: AcpSessionRef, amountUsdCents: number): Promise<void> {
    this.calls.push({ op: "setBudget", ref, amountUsdCents });
  }

  async submit(ref: AcpSessionRef, deliverable: string): Promise<void> {
    this.calls.push({ op: "submit", ref, content: deliverable });
  }

  async sendMessage(ref: AcpSessionRef, content: string): Promise<void> {
    this.calls.push({ op: "sendMessage", ref, content });
  }

  diagnostics(): { connected: boolean | null; lastError: string | null } {
    return { connected: null, lastError: null };
  }

  /** Simulated buyer: an incoming job with a requirement message. */
  async buyerJob(ref: AcpSessionRef, requirement: string, clientAddress = "0xbuyer"): Promise<void> {
    if (!this.handlers) throw new Error("mock transport not started");
    await this.handlers.onEntry(ref, { kind: "system", event: { type: "job.created" }, clientAddress });
    await this.handlers.onEntry(ref, { kind: "message", contentType: "requirement", content: requirement, clientAddress });
  }

  /** Simulated buyer funding the escrow. */
  async buyerFunded(ref: AcpSessionRef): Promise<void> {
    if (!this.handlers) throw new Error("mock transport not started");
    await this.handlers.onEntry(ref, { kind: "system", event: { type: "job.funded" } });
  }

  /** Simulated evaluator decision. */
  async evaluatorCompleted(ref: AcpSessionRef, reason = "deliverable verified"): Promise<void> {
    if (!this.handlers) throw new Error("mock transport not started");
    await this.handlers.onEntry(ref, { kind: "system", event: { type: "job.completed" } });
    void reason;
  }

  async evaluatorRejected(ref: AcpSessionRef): Promise<void> {
    if (!this.handlers) throw new Error("mock transport not started");
    await this.handlers.onEntry(ref, { kind: "system", event: { type: "job.rejected" } });
  }

  async expired(ref: AcpSessionRef): Promise<void> {
    if (!this.handlers) throw new Error("mock transport not started");
    await this.handlers.onEntry(ref, { kind: "system", event: { type: "job.expired" } });
  }

  callsOf(op: MockCall["op"]): MockCall[] {
    return this.calls.filter((c) => c.op === op);
  }
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface AcpConfig {
  enabled: boolean;
  walletAddress: string;
  walletId: string;
  signerKey: string;
  builderCode: string;
  chainId: number;
}

export function acpConfig(): AcpConfig {
  return {
    enabled: (process.env.ACP_ENABLED ?? "").trim().toLowerCase() === "true",
    walletAddress: (process.env.ACP_PROVIDER_WALLET_ADDRESS ?? "").trim(),
    walletId: (process.env.ACP_WALLET_ID ?? "").trim(),
    signerKey: (process.env.ACP_SIGNER_PRIVATE_KEY ?? "").trim(),
    builderCode: (process.env.ACP_BUILDER_CODE ?? "").trim(),
    chainId: Number((process.env.ACP_CHAIN_ID ?? "8453").trim()) || 8453,
  };
}

export function realAcpConfigured(): boolean {
  const cfg = acpConfig();
  return Boolean(cfg.enabled && cfg.walletAddress && cfg.walletId && cfg.signerKey);
}

/**
 * Whether the v2 SDK is present and loadable in this deployment. The literal
 * specifier keeps the import analyzable: with the package in
 * `serverExternalPackages`, Next resolves it from node_modules at runtime
 * AND Vercel's file tracing ships it inside the serverless bundle (a
 * non-analyzable specifier is NOT traced — that exact gap produced
 * `sdkInstalled: false` on production while package.json listed the SDK).
 */
export async function acpSdkInstalled(): Promise<boolean> {
  try {
    const mod = (await import("@virtuals-protocol/acp-node-v2")) as Record<string, unknown>;
    return typeof mod?.AcpAgent === "function";
  } catch {
    return false;
  }
}

/**
 * The live transport, wired to the ACTUAL `acp-node-v2` v0.1.15 surface
 * (verified against dist/*.d.ts, not the marketing quickstart):
 *
 *   AcpAgent.create({ evmProvider })           — NOT `{ provider }`
 *   PrivyAlchemyEvmProviderAdapter.create({
 *     chains: [base],                          — viem Chain objects
 *     walletAddress, walletId,
 *     signerPrivateKey,                        — the Privy AUTHORIZATION key
 *     builderCode?,                            — from the agent page's Signers tab
 *   })
 *   agent.on("entry", (session, entry) => ...) — entries carry their own
 *                                                onChainJobId + chainId
 *   agent.start(onConnected?)                  — SSE to api.acp.virtuals.io;
 *                                                onConnected fires when the
 *                                                stream is live
 *   session.setBudget(AssetToken.usdc(...))    — the priced acceptance act
 *   session.submit(deliverable)                — result delivery
 *
 * Only construct when `realAcpConfigured()` — the caller surfaces a visible
 * misconfiguration otherwise. The signer key signs Privy wallet-RPC server
 * calls; the EVM key never leaves Privy.
 */
export async function createRealAcpTransport(cfg: AcpConfig): Promise<AcpTransport> {
  const sdk = (await import("@virtuals-protocol/acp-node-v2")) as typeof AcpSdk;

  const provider = await sdk.PrivyAlchemyEvmProviderAdapter.create({
    // The SDK bundles its own viem (2.58.x) and types `chains` against it;
    // the repo resolves a sibling viem (2.57.x). The chain object is plain
    // data and identical at runtime — cast across the type copies.
    chains: [base] as unknown as AcpSdk.PrivyAlchemyChainConfig["chains"],
    walletAddress: cfg.walletAddress as `0x${string}`,
    walletId: cfg.walletId,
    signerPrivateKey: cfg.signerKey,
    ...(cfg.builderCode ? { builderCode: cfg.builderCode } : {}),
  });
  const agent = await sdk.AcpAgent.create({ evmProvider: provider });

  // Live sessions, bound as entries arrive and looked up by session ref for
  // later provider actions (setBudget on funding, submit on delivery).
  const sessions = new Map<string, AcpSdk.JobSession>();
  const keyOf = (ref: AcpSessionRef): string => `${ref.chainId}:${ref.jobId}`;
  type AcpHandlers = Parameters<AcpTransport["start"]>[0];
  let handlers: AcpHandlers | null = null;
  let connected = false;
  let lastError: string | null = null;

  function requireSession(ref: AcpSessionRef): AcpSdk.JobSession {
    const session = sessions.get(keyOf(ref));
    if (!session) throw new Error(`no live ACP session bound for job ${keyOf(ref)}`);
    return session;
  }

  return {
    mode: "real",
    async start(next) {
      handlers = next;
      agent.on("entry", (session, entry) => {
        const ref: AcpSessionRef = { chainId: Number(entry.chainId), jobId: String(entry.onChainJobId) };
        sessions.set(keyOf(ref), session);
        const mapped: AcpEntry =
          entry.kind === "message"
            ? { kind: "message", contentType: entry.contentType, content: entry.content }
            : { kind: "system", event: { type: entry.event.type } };
        handlers
          ?.onEntry(ref, mapped)
          .catch((err: unknown) => {
            lastError = `${new Date().toISOString()} ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
          });
      });
      await agent.start(() => {
        connected = true;
        // The stream is up (before session hydration finishes) — report it so
        // the persisted runtime record can be written outside this bundle.
        try {
          handlers?.onStreamState?.(true);
        } catch { /* state reporting must never break the transport */ }
      });
    },
    async stop() {
      if (connected) {
        try {
          handlers?.onStreamState?.(false);
        } catch { /* ignore */ }
      }
      connected = false;
      await agent.stop();
    },
    async setBudget(ref, amountUsdCents) {
      // Priced acceptance: the provider names the budget in USDC on Base.
      await requireSession(ref).setBudget(sdk.AssetToken.usdc(amountUsdCents / 100, ref.chainId));
    },
    async submit(ref, deliverable) {
      await requireSession(ref).submit(deliverable);
    },
    async sendMessage(ref, content) {
      await requireSession(ref).sendMessage(content);
    },
    diagnostics() {
      return { connected, lastError };
    },
    async verifyRegistration() {
      // The ACP server answers agent lookups only for authenticated callers,
      // so this check runs through the LIVE transport's own client — it is
      // exactly what the network sees for this wallet.
      const detail = await agent.getAgentByWalletAddress(cfg.walletAddress);
      if (!detail) {
        return { found: false, detail: `no agent registered at ${cfg.walletAddress} is visible on the ACP server` };
      }
      const offerings = detail.offerings ?? [];
      const names = offerings.slice(0, 6).map((o) => o.name).filter(Boolean);
      return {
        found: true,
        detail: `registered agent "${detail.name}" (${detail.role ?? "agent"}${detail.isHidden ? ", hidden" : ", visible"}) — ${offerings.length} published offering(s)${names.length ? `: ${names.join(", ")}` : ""} — last active ${detail.lastActiveAt ?? "?"}`,
      };
    },
  };
}

/**
 * The transport this deployment should use: real when enabled AND fully
 * configured, mock when the provider is on without credentials (the vertical
 * slice must still run), disabled otherwise.
 */
export async function selectAcpTransport(): Promise<{ transport: AcpTransport | null; reason: string }> {
  const cfg = acpConfig();
  if (!cfg.enabled) return { transport: null, reason: "ACP_ENABLED is not set — the provider is off" };
  if (realAcpConfigured()) {
    try {
      return { transport: await createRealAcpTransport(cfg), reason: "live ACP transport started" };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { transport: null, reason: `live transport failed to start (${detail.slice(0, 160)})` };
    }
  }
  return { transport: new MockAcpTransport(), reason: "no ACP credentials configured — running the mock transport (simulated buyers only)" };
}
