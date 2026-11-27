import { describe, expect, it, vi } from "vitest";

import {
  BASE_CHAIN_ID,
  BASE_CHAIN_ID_HEX,
  BASE_CHAIN_PARAMS,
  ensureWalletChain,
  readWalletChainId,
  WalletChainError,
} from "@/lib/acp/wallet-chain";
import { classifyTxError } from "@/lib/acp/tx-errors";

/**
 * The chain regression contract — written for the observed failure: the
 * buyer's wallet sat on Ethereum mainnet (chain 1) while the transaction
 * referenced NIGHTSHIFT's ACP deployment on Base (chain 8453), and the
 * wallet signed on chain 1 where it had no gas. These tests pin the rule:
 * the wallet's ACTIVE chain is verified before every signature, repaired
 * with an explicit switch request when possible, and signing is BLOCKED
 * outright when networks disagree.
 */

type SwitchFailure = "none" | "reject" | "unrecognized" | "silent-ignore";

interface FakeWalletOptions {
  chain: number | null;
  switchFailure?: SwitchFailure;
}

/** A scripted EIP-1193 provider with a call log, for node tests. */
function fakeWallet(options: FakeWalletOptions) {
  const { chain: initialChain, switchFailure = "none" } = options;
  const log: string[] = [];
  let chain = initialChain;
  let switchAttempts = 0;
  const request = vi.fn(async (args: { method: string; params?: unknown[] | object }) => {
    log.push(args.method);
    switch (args.method) {
      case "eth_chainId":
        if (chain === null) throw new Error("wallet locked");
        return `0x${chain.toString(16)}`;
      case "wallet_switchEthereumChain": {
        if (switchFailure === "reject") {
          const err = new Error("user rejected the request") as Error & { code: number };
          err.code = 4001;
          throw err;
        }
        if (switchFailure === "unrecognized") {
          // Real wallets fail the FIRST switch with 4902; after the chain is
          // added, the retry succeeds.
          switchAttempts += 1;
          if (switchAttempts === 1) {
            const err = new Error("Unrecognized chain.") as Error & { code: number };
            err.code = 4902;
            throw err;
          }
        }
        const wanted = (args.params as Array<{ chainId: string }>)[0].chainId;
        if (switchFailure === "silent-ignore") return null; // wallet "succeeds" but never switches
        chain = Number.parseInt(wanted, 16);
        return null;
      }
      case "wallet_addEthereumChain":
        return null;
      case "eth_sendTransaction":
        return `0x${"5".repeat(64)}`;
      case "personal_sign":
        return `0x${"6".repeat(64)}`;
      default:
        throw new Error(`unexpected method ${args.method}`);
    }
  });
  return { provider: { request } as unknown as { request(a: { method: string; params?: unknown[] | object }): Promise<unknown> }, log, raw: request };
}

describe("ensureWalletChain — the signature barrier", () => {
  it("passes when the wallet is already on Base and requests no switch", async () => {
    const w = fakeWallet({ chain: 8453 });
    const chain = await ensureWalletChain(w.provider);
    expect(chain).toBe(8453);
    expect(w.log).toEqual(["eth_chainId"]); // verified, nothing else requested
  });

  it("switches explicitly when the wallet sits on Ethereum mainnet — then verifies", async () => {
    const w = fakeWallet({ chain: 1 });
    const chain = await ensureWalletChain(w.provider);
    expect(chain).toBe(8453);
    // The switch was REQUESTED with Base's exact chain id — never a silent reroute.
    expect(w.raw.mock.calls).toContainEqual([{ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_ID_HEX }] }]);
  });

  it("adds Base first when the wallet does not know the chain (4902), then switches", async () => {
    const w = fakeWallet({ chain: 1, switchFailure: "unrecognized" });
    const chain = await ensureWalletChain(w.provider);
    expect(chain).toBe(8453);
    expect(w.log).toContain("wallet_addEthereumChain");
    // The add carries Base's full parameters — rpc, explorer, currency.
    const addCall = w.raw.mock.calls.find((c) => (c[0] as { method: string }).method === "wallet_addEthereumChain");
    expect(((addCall as unknown[])?.[0] as { params: [Record<string, unknown>] } | undefined)?.params?.[0]).toMatchObject({
      chainId: BASE_CHAIN_ID_HEX,
      chainName: BASE_CHAIN_PARAMS.chainName,
      blockExplorerUrls: BASE_CHAIN_PARAMS.blockExplorerUrls,
    });
  });

  it("BLOCKS signing when the user declines the switch — no eth_sendTransaction is ever requested", async () => {
    const w = fakeWallet({ chain: 1, switchFailure: "reject" });
    await expect(ensureWalletChain(w.provider)).rejects.toMatchObject({
      code: "switch_rejected",
      walletChainId: 1,
      requiredChainId: 8453,
    });
    expect(w.log).not.toContain("eth_sendTransaction");
  });

  it("BLOCKS signing when the wallet ignores the switch and stays on the wrong chain", async () => {
    const w = fakeWallet({ chain: 1, switchFailure: "silent-ignore" });
    await expect(ensureWalletChain(w.provider)).rejects.toMatchObject({ code: "wrong_chain", walletChainId: 1 });
    expect(w.log).not.toContain("eth_sendTransaction");
  });

  it("BLOCKS when the wallet will not even report its chain", async () => {
    const w = fakeWallet({ chain: null });
    await expect(ensureWalletChain(w.provider)).rejects.toMatchObject({ code: "chain_read_failed" });
    expect(w.log).not.toContain("eth_sendTransaction");
  });

  it("a WalletChainError carries the exact networks for the UI", async () => {
    const err = new WalletChainError("wrong_chain", 1, BASE_CHAIN_ID);
    expect(err.walletChainId).toBe(1);
    expect(err.requiredChainId).toBe(BASE_CHAIN_ID);
    expect(err.message).toContain("blocked");
  });
});

describe("readWalletChainId", () => {
  it("reads hex chain ids and returns null on refusal", async () => {
    const w = fakeWallet({ chain: 1 });
    expect(await readWalletChainId(w.provider)).toBe(1);
    const dead = fakeWallet({ chain: null });
    expect(await readWalletChainId(dead.provider)).toBeNull();
  });
});

describe("classifyTxError — the buyer's error language", () => {
  it("names insufficient gas with the exact mandated copy — no raw payload", () => {
    const view = classifyTxError(new Error("insufficient funds for gas * 21000 + value"));
    expect(view.code).toBe("insufficient_gas");
    expect(view.title).toBe("Insufficient Base ETH");
    expect(view.explanation).toBe(
      "Your wallet does not have enough ETH on Base to pay transaction gas. No transaction was submitted.",
    );
    expect(view.actions.length).toBeGreaterThan(0);
    // The human surface must not leak the raw internals.
    expect(view.explanation).not.toMatch(/21000/);
    expect(view.technical).toContain("insufficient funds");
  });

  it("separates rejected signatures, USDC, network, RPC, revert and job-creation failures", () => {
    expect(classifyTxError({ code: 4001, message: "user rejected transaction" }).code).toBe("user_rejected");
    expect(classifyTxError(new Error("transfer amount exceeds balance 1234")).code).toBe("insufficient_usdc");
    expect(classifyTxError(new Error("transfer amount exceeds allowance")).code).toBe("usdc_allowance");
    expect(classifyTxError(new WalletChainError("wrong_chain", 1, 8453)).code).toBe("wrong_network");
    expect(classifyTxError(new WalletChainError("switch_rejected", 1, 8453)).code).toBe("switch_rejected");
    expect(classifyTxError(new Error("Failed to fetch")).code).toBe("rpc_failure");
    expect(classifyTxError(new Error("rate limit reached, 429")).code).toBe("rpc_failure");
    expect(classifyTxError(new Error("execution reverted: bad requirement")).code).toBe("tx_reverted");
    expect(classifyTxError(new Error("the job creation transaction 0x… landed, but no JobCreated event was found")).code).toBe("job_creation_failed");
    expect(classifyTxError(new Error("mystery")).code).toBe("unknown");
  });

  it("every error class ships a title, an explanation and at least one recovery action", () => {
    for (const view of [
      classifyTxError({ code: 4001, message: "x" }),
      classifyTxError(new Error("insufficient funds")),
      classifyTxError(new Error("transfer amount exceeds balance")),
      classifyTxError(new WalletChainError("wrong_chain", 1, 8453)),
      classifyTxError(new WalletChainError("switch_rejected", 1, 8453)),
      classifyTxError(new Error("Failed to fetch")),
      classifyTxError(new Error("execution reverted")),
      classifyTxError(new Error("no JobCreated event")),
      classifyTxError(new Error("mystery")),
    ]) {
      expect(view.title.length).toBeGreaterThan(3);
      expect(view.explanation.length).toBeGreaterThan(20);
      expect(view.actions.length).toBeGreaterThan(0);
    }
  });
});
