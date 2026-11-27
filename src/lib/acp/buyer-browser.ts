/**
 * The BUYER rail — the browser-side half of NIGHTSHIFT's ACP commerce.
 *
 * Everything here runs in the buyer's browser with the buyer's own wallet
 * (Privy embedded or connected), through the REAL `@virtuals-protocol/acp-node-v2`
 * buyer surface:
 *
 *   EvmAcpClient  — createJob / approveAllowance / fund / complete, each
 *                   returning prepared contract calls that THIS module
 *                   executes via the wallet's EIP-1193 provider, one
 *                   eth_sendTransaction per call (Base-only).
 *   AcpApiClient + SseTransport — the authenticated job-room API (the same
 *                   signed `acp-auth` challenge the SDK's own transports
 *                   perform), used to send the requirement message and to
 *                   read the room history (proposal, deliverable, notes).
 *
 * Imports are subpath-limited to the client-safe modules: the Privy server
 * adapter (which loads @privy-io/server-auth) is never pulled into a
 * browser bundle. The provider's signer exists only in NIGHTSHIFT's server
 * environment — nothing here touches it.
 */

import { createPublicClient, http, toHex } from "viem";
import { base } from "viem/chains";

import type { Call, Log } from "viem";

type Hex = `0x${string}`;
import { EvmAcpClient } from "@virtuals-protocol/acp-node-v2/dist/clients/evmAcpClient.js";
import type { IEvmProviderAdapter, ReadContractParams, GetLogsParams } from "@virtuals-protocol/acp-node-v2/dist/providers/types.js";
import { ACP_CONTRACT_ADDRESSES, USDC_ADDRESSES } from "@virtuals-protocol/acp-node-v2/dist/core/constants.js";
import { createEvmNetworkContext } from "@virtuals-protocol/acp-node-v2/dist/core/chains.js";
import { parseJobIdFromReceipt } from "@virtuals-protocol/acp-node-v2/dist/utils/events.js";
import type { JobCreatedFilter } from "@virtuals-protocol/acp-node-v2/dist/utils/events.js";
import type { TransactionReceipt } from "viem";

// THE chain guarantee: before every signature the wallet's ACTIVE chain is
// read (eth_chainId), repaired when needed (explicit switch request), and
// signing is blocked outright when the wallet is not on Base. See
// wallet-chain.ts for the enforcement and tests/acp-chain-guard.test.ts
// for the regression contract.
import { BASE_CHAIN_ID, ensureWalletChain, WalletChainError } from "./wallet-chain";
import { classifyTxError } from "./tx-errors";

export { BASE_CHAIN_ID, ensureWalletChain, readWalletChainId, chainLabel, WalletChainError } from "./wallet-chain";
export { classifyTxError } from "./tx-errors";
export type { TxErrorView, TxErrorCode } from "./tx-errors";

/** Minimal EIP-1193 surface the Privy wallet provider exposes. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

const USDC_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * The adapter the SDK drives. Reads go to a public Base RPC (independent of
 * the wallet's RPC); writes are signed by the wallet via EIP-1193. Batched
 * calls execute SEQUENTIALLY (allowance before funding) — each is its own
 * wallet confirmation, which is exactly the explicit approval the desk shows.
 */
class BrowserWalletAdapter implements IEvmProviderAdapter {
  readonly providerName = "nightshift-buyer-browser";

  constructor(
    private readonly eip1193: Eip1193Provider,
    private readonly address: string,
    private readonly chainId: number,
  ) {}

  private publicClient() {
    return createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  }

  async getAddress(): Promise<Hex> {
    return this.address as Hex;
  }

  async getSupportedChainIds(): Promise<number[]> {
    return [this.chainId];
  }

  async getNetworkContext(chainId: number) {
    return createEvmNetworkContext(chainId);
  }

  private guardChain(chainId: number): void {
    if (Number(chainId) !== this.chainId) {
      throw new Error(`this wallet is on chain ${this.chainId}; the job needs ${chainId}`);
    }
  }

  private async sendOne(call: Call): Promise<Hex> {
    // Per-transaction verification: the wallet's ACTIVE chain is read again
    // immediately before each eth_sendTransaction — batched calls are
    // sequential, and a chain change mid-flow must block, never silently
    // sign on the wrong network. Throws WalletChainError when not on Base.
    await ensureWalletChain(this.eip1193, this.chainId);
    const params: Record<string, string> = { from: this.address, to: call.to, data: (call.data ?? "0x") as string };
    if (call.value !== undefined && call.value !== null && call.value !== 0n) params.value = toHex(call.value);
    const hash = (await this.eip1193.request({ method: "eth_sendTransaction", params: [params] })) as string;
    if (typeof hash !== "string" || !hash.startsWith("0x")) {
      throw new Error("the wallet did not return a transaction hash");
    }
    return hash as Hex;
  }

  async sendTransaction(chainId: number, call: Call | Call[]): Promise<Hex> {
    this.guardChain(chainId);
    // First signature barrier: verify (and if needed request) the wallet's
    // chain BEFORE any signing — the observed failure was exactly here:
    // guardChain compared two configuration values while the wallet itself
    // sat on Ethereum mainnet, so a Base transaction got signed on chain 1.
    await ensureWalletChain(this.eip1193, this.chainId);
    if (Array.isArray(call)) {
      const hashes: Hex[] = [];
      for (const c of call) hashes.push(await this.sendOne(c));
      return hashes[0];
    }
    return this.sendOne(call);
  }

  async sendCalls(chainId: number, calls: Call[]): Promise<Hex | Hex[]> {
    this.guardChain(chainId);
    await ensureWalletChain(this.eip1193, this.chainId);
    const hashes: Hex[] = [];
    for (const c of calls) hashes.push(await this.sendOne(c));
    return hashes.length === 1 ? hashes[0] : hashes;
  }

  async getTransactionReceipt(chainId: number, hash: string): Promise<TransactionReceipt> {
    this.guardChain(chainId);
    return (await this.publicClient().waitForTransactionReceipt({
      hash: hash as `0x${string}`,
      confirmations: 1,
      timeout: 90_000,
    })) as TransactionReceipt;
  }

  async readContract(chainId: number, params: ReadContractParams): Promise<unknown> {
    this.guardChain(chainId);
    return await this.publicClient().readContract(params as Parameters<ReturnType<typeof this.publicClient>["readContract"]>[0]);
  }

  async getLogs(chainId: number, params: GetLogsParams): Promise<Log[]> {
    this.guardChain(chainId);
    const client = this.publicClient();
    const events = Array.isArray(params.events) ? params.events : [params.events];
    const collected: Log[] = [];
    for (const event of events) {
      const logs = await client.getLogs({
        address: params.address,
        event: event as never,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock === undefined ? "latest" : params.toBlock === "latest" ? "latest" : params.toBlock,
      });
      collected.push(...logs);
    }
    return collected;
  }

  async getBlockNumber(chainId: number): Promise<bigint> {
    this.guardChain(chainId);
    return await this.publicClient().getBlockNumber();
  }

  /** The native balance (Base ETH) of any address — the gas read. */
  async getBalance(chainId: number, address: string): Promise<bigint> {
    this.guardChain(chainId);
    return await this.publicClient().getBalance({ address: address as `0x${string}` });
  }

  async signMessage(chainId: number, message: string): Promise<string> {
    this.guardChain(chainId);
    await ensureWalletChain(this.eip1193, this.chainId);
    return (await this.eip1193.request({ method: "personal_sign", params: [message, this.address] })) as string;
  }

  async signTypedData(chainId: number, typedData: unknown): Promise<string> {
    this.guardChain(chainId);
    await ensureWalletChain(this.eip1193, this.chainId);
    return (await this.eip1193.request({
      method: "eth_signTypedData_v4",
      params: [this.address, JSON.stringify(typedData)],
    })) as string;
  }
}

export function contractAddress(chainId: number): string {
  const address = ACP_CONTRACT_ADDRESSES[chainId];
  if (!address) throw new Error(`no ACP contract address for chain ${chainId}`);
  return address;
}

export function usdcAddress(chainId: number): string {
  const address = USDC_ADDRESSES[chainId];
  if (!address) throw new Error(`no USDC address for chain ${chainId}`);
  return address;
}

/** The buyer rail: one instance per signed-in wallet, lives for the page. */
export interface BuyerRail {
  address: string;
  chainId: number;
  /** Read the USDC allowance the ACP contract has over the buyer's wallet. */
  usdcAllowance(): Promise<bigint>;
  usdcBalance(): Promise<bigint>;
  /** The wallet's native Base ETH — the gas the signatures will spend. */
  gasBalance(): Promise<bigint>;
  /** Read the on-chain job (source of truth: status, budget, parties). */
  readJob(jobId: string): Promise<OnChainJobView | null>;
  /** Create the on-chain job and resolve its id from the receipt. */
  createJob(input: { providerAddress: string; evaluatorAddress: string; expiredAtSeconds: number; description: string }): Promise<{ txHash: string; jobId: string }>;
  /** Prepare-and-execute the USDC allowance for the escrow. */
  approveAllowance(amountBaseUnits: bigint): Promise<string>;
  /** Fund the escrow (the explicit payment). */
  fund(jobId: string, expectedBudgetBaseUnits: bigint): Promise<string>;
  /** Release the escrow: the buyer accepts the deliverable on-chain. */
  complete(jobId: string, reason: string): Promise<string>;
  /** Authenticated job-room access (signed with the buyer's wallet). */
  openJobRoom(): Promise<JobRoomRail>;
}

export interface OnChainJobView {
  id: string;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  /** 0 OPEN · 1 FUNDED · 2 SUBMITTED · 3 COMPLETED · 4 REJECTED · 5 EXPIRED */
  status: number;
}

export interface JobRoomRail {
  /** Post a message to the job room (the requirement, contentType "requirement"). */
  postMessage(jobId: string, content: string, contentType?: string): Promise<void>;
  /** The room history: requirement, provider notes, the deliverable message. */
  getHistory(jobId: string): Promise<RoomEntry[]>;
}

export interface RoomEntry {
  kind: "system" | "message";
  event?: { type: string };
  contentType?: string;
  content?: string;
  from?: string;
  timestamp?: number;
}

export async function createBuyerRail(input: {
  eip1193: Eip1193Provider;
  address: string;
  chainId: number;
}): Promise<BuyerRail> {
  // The rail is Base-only. A caller asking for another chain is a bug, not
  // a configuration — refuse it instead of building a rail that signs
  // somewhere else.
  if (input.chainId !== BASE_CHAIN_ID) {
    throw new WalletChainError("wrong_chain", input.chainId, BASE_CHAIN_ID, `buyer rail refused: NIGHTSHIFT ACP jobs run on Base (${BASE_CHAIN_ID}), not chain ${input.chainId}`);
  }
  const adapter = new BrowserWalletAdapter(input.eip1193, input.address, input.chainId);
  const contract = contractAddress(input.chainId);
  const client = await EvmAcpClient.create({ contractAddresses: { [input.chainId]: contract }, provider: adapter });
  const usdc = usdcAddress(input.chainId);
  const lower = input.address.toLowerCase();

  return {
    address: lower,
    chainId: input.chainId,

    async usdcAllowance(): Promise<bigint> {
      return (await adapter.readContract(input.chainId, {
        address: usdc as `0x${string}`,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [lower, contract],
      })) as bigint;
    },

    async usdcBalance(): Promise<bigint> {
      return (await adapter.readContract(input.chainId, {
        address: usdc as `0x${string}`,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [lower],
      })) as bigint;
    },

    /** The wallet's native Base ETH — the gas the signatures will spend. */
    async gasBalance(): Promise<bigint> {
      return await adapter.getBalance(input.chainId, lower);
    },

    async readJob(jobId: string): Promise<OnChainJobView | null> {
      const job = await client.getJob(input.chainId, jobId);
      if (!job) return null;
      return {
        id: String(job.id),
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        description: job.description,
        budget: job.budget,
        expiredAt: job.expiredAt,
        status: job.status,
      };
    },

    async createJob({ providerAddress, evaluatorAddress, expiredAtSeconds, description }) {
      const prepared = await client.createJob(input.chainId, {
        providerAddress,
        evaluatorAddress,
        expiredAt: expiredAtSeconds,
        description,
      });
      const txHashes = await client.execute(input.chainId, prepared.tx);
      const txHash = Array.isArray(txHashes) ? txHashes[0] : txHashes;
      const filter: JobCreatedFilter = { provider: providerAddress };
      const jobId = await client.getJobIdFromTxHash(input.chainId, txHash, filter);
      if (jobId === null) {
        throw new Error(`the job creation transaction ${txHash} landed, but no JobCreated event was found for this provider`);
      }
      return { txHash, jobId: jobId.toString() };
    },

    async approveAllowance(amountBaseUnits: bigint) {
      const prepared = await client.approveAllowance(input.chainId, {
        tokenAddress: usdc,
        spenderAddress: contract,
        amount: amountBaseUnits,
      });
      const hashes = await client.execute(input.chainId, prepared.tx);
      return Array.isArray(hashes) ? hashes[0] : hashes;
    },

    async fund(jobId: string, expectedBudgetBaseUnits: bigint) {
      const prepared = await client.fund(input.chainId, { jobId, expectedBudget: expectedBudgetBaseUnits });
      const hashes = await client.execute(input.chainId, prepared.tx);
      return Array.isArray(hashes) ? hashes[0] : hashes;
    },

    async complete(jobId: string, reason: string) {
      const prepared = await client.complete(input.chainId, { jobId, reason });
      const hashes = await client.execute(input.chainId, prepared.tx);
      return Array.isArray(hashes) ? hashes[0] : hashes;
    },

    async openJobRoom(): Promise<JobRoomRail> {
      // The same SDK transports the provider agent uses, driven by the
      // BUYER's signature: signMessage comes from the browser wallet.
      const [{ AcpApiClient }, { SseTransport }] = await Promise.all([
        import("@virtuals-protocol/acp-node-v2/dist/events/acpApiClient.js"),
        import("@virtuals-protocol/acp-node-v2/dist/events/sseTransport.js"),
      ]);
      const transport = new SseTransport();
      const api = new AcpApiClient();
      const ctx = {
        agentAddresses: { evm: lower },
        contractAddresses: { [input.chainId]: contract },
        providerSupportedChainIds: [input.chainId],
        getClientForChain: () => client,
        signMessage: (chainId: number, message: string) => adapter.signMessage(chainId, message),
      };
      // Both clients authenticate by signing the challenge with the buyer's
      // wallet; the chat transport opens its SSE stream for live room entries.
      transport.setContext(ctx as never);
      api.setContext(ctx as never);
      await transport.connect(undefined, ["chat"]);

      return {
        async postMessage(jobId: string, content: string, contentType = "requirement") {
          await transport.postMessage(input.chainId, jobId, content, contentType);
        },
        async getHistory(jobId: string): Promise<RoomEntry[]> {
          const entries = await transport.getHistory(input.chainId, jobId);
          return (entries ?? []).map((e) => ({
            kind: e.kind,
            event: e.kind === "system" ? { type: String((e as { event?: { type?: string } }).event?.type) } : undefined,
            contentType: e.kind === "message" ? (e as { contentType?: string }).contentType : undefined,
            content: e.kind === "message" ? (e as { content?: string }).content : undefined,
            from: e.kind === "message" ? (e as { from?: string }).from : undefined,
            timestamp: (e as { timestamp?: number }).timestamp,
          }));
        },
      };
    },
  };
}

/** The exact requirement payload the provider's intake validates. */
export function buildRequirement(offeringId: string, subject: Record<string, string>): string {
  return JSON.stringify({ offering: offeringId, inputs: subject });
}

/** USDC is 6 decimals on Base; cents → base units, exactly. */
export function usdcBaseUnits(usdCents: number): bigint {
  return BigInt(Math.round(usdCents)) * 10_000n;
}

export function formatUsdc(baseUnits: bigint): string {
  return `$${(Number(baseUnits) / 1_000_000).toFixed(2)}`;
}

/** Job expiry: 24 h by default (long enough for the operator approval gate). */
export const JOB_EXPIRY_SECONDS = 24 * 60 * 60;
