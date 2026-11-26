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
 *   createRealAcpTransport — the live adapter for `@virtuals-protocol/acp-node-v2`.
 *     It is wired ONLY when the operator sets ACP_ENABLED=true plus the three
 *     credentials (agent wallet address, Privy wallet id, signer private key).
 *     The SDK is loaded through a non-static specifier so deployments without
 *     the package build and run fine; a real mode without the SDK installed
 *     is a hard, visible misconfiguration — never a faked connection.
 */

import type { AcpEntry, AcpSessionRef, AcpSystemEventType, AcpTransport } from "./types";

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
 * Whether the v2 SDK is present in this deployment — checked WITHOUT
 * importing it, so status endpoints stay cheap and builds stay hermetic.
 */
export async function acpSdkInstalled(): Promise<boolean> {
  try {
    // Non-static specifier: the bundler cannot resolve it at build time, so
    // deployments without the package never break; a real deployment with
    // the package installed resolves it at runtime.
    const specifier = ["@virtuals-protocol", "acp-node-v2"].join("/");
    const mod = (await import(/* webpackIgnore: true */ specifier)) as Record<string, unknown>;
    return typeof mod?.AcpAgent === "function";
  } catch {
    return false;
  }
}

/**
 * The live transport. `acp-node-v2`'s seller flow: `AcpAgent.create({provider})
 * → agent.on("entry", handler) → agent.start()`, provider acts are
 * `session.setBudget(AssetToken.usdc(...))` / `session.submit(deliverable)` /
 * `session.sendMessage(...)`. Only construct when `realAcpConfigured()` —
 * the caller surfaces a visible misconfiguration otherwise.
 */
export async function createRealAcpTransport(cfg: AcpConfig): Promise<AcpTransport> {
  const specifier = ["@virtuals-protocol", "acp-node-v2"].join("/");
  const sdk = (await import(/* webpackIgnore: true */ specifier)) as Record<string, unknown>;
  const { AcpAgent, PrivyAlchemyEvmProviderAdapter, base, AssetToken } = sdk as {
    AcpAgent: { create: (opts: unknown) => Promise<RealAgent> };
    PrivyAlchemyEvmProviderAdapter: { create: (opts: unknown) => Promise<unknown> };
    base: { id: number };
    AssetToken: { usdc: (amount: number, chainId: number) => unknown };
  };

  interface RealAgent {
    start(onConnected?: () => void): Promise<void>;
    stop(): Promise<void>;
    on(event: "entry", handler: (session: RealSession, entry: Record<string, unknown>) => void): void;
  }
  interface RealSession {
    jobId: string | number | bigint;
    chainId: number;
    setBudget(token: unknown): Promise<void>;
    submit(deliverable: string, transferAmount?: unknown): Promise<void>;
    sendMessage(content: string, contentType?: string): Promise<void>;
  }

  const provider = await PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: cfg.walletAddress,
    walletId: cfg.walletId,
    signerPrivateKey: cfg.signerKey,
    chains: [base],
    ...(cfg.builderCode ? { builderCode: cfg.builderCode } : {}),
  });
  const agent = await AcpAgent.create({ provider });

  // Live sessions, bound as entries arrive and looked up by session ref for
  // later provider actions (setBudget on funding, submit on delivery).
  const sessions = new Map<string, RealSession>();
  const refOf = (session: RealSession): AcpSessionRef => ({ chainId: Number(session.chainId), jobId: String(session.jobId) });
  const keyOf = (ref: AcpSessionRef): string => `${ref.chainId}:${ref.jobId}`;
  let handlers: { onEntry: (ref: AcpSessionRef, entry: AcpEntry) => Promise<void> } | null = null;

  function requireSession(ref: AcpSessionRef): RealSession {
    const session = sessions.get(keyOf(ref));
    if (!session) throw new Error(`no live ACP session bound for job ${keyOf(ref)}`);
    return session;
  }

  return {
    mode: "real",
    async start(next) {
      handlers = next;
      agent.on("entry", (session, entry) => {
        sessions.set(keyOf(refOf(session)), session);
        const raw = entry as { kind?: unknown; event?: { type?: unknown }; contentType?: unknown; content?: unknown };
        const mapped: AcpEntry = {
          kind: raw.kind === "message" ? "message" : "system",
          ...(raw.event?.type ? { event: { type: String(raw.event.type) as AcpSystemEventType } } : {}),
          ...(raw.contentType ? { contentType: String(raw.contentType) } : {}),
          ...(raw.content !== undefined && raw.content !== null ? { content: String(raw.content) } : {}),
        };
        void handlers?.onEntry(refOf(session), mapped);
      });
      await agent.start();
    },
    async stop() {
      await agent.stop();
    },
    async setBudget(ref, amountUsdCents) {
      // Priced acceptance: the provider names the budget in USDC on Base.
      await requireSession(ref).setBudget(AssetToken.usdc(amountUsdCents / 100, base.id));
    },
    async submit(ref, deliverable) {
      await requireSession(ref).submit(deliverable);
    },
    async sendMessage(ref, content) {
      await requireSession(ref).sendMessage(content);
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
