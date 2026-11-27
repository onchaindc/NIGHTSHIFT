/**
 * The chain boundary for buyer transactions — the module that makes it
 * STRUCTURALLY IMPOSSIBLE to sign a Base ACP transaction while the wallet
 * sits on another chain.
 *
 * The failure this module exists for: the buyer's wallet reported chain 1
 * (Ethereum mainnet) while the transaction referenced NIGHTSHIFT's ACP
 * deployment on Base (chain 8453, contract 0x238E541BfefD82238730D00a2208E5497F1832E0).
 * The wallet signed the transaction on Ethereum — where the buyer has no
 * gas — and the send failed with "insufficient funds for gas".
 *
 * The rule, enforced here before EVERY signature:
 *   1. READ the wallet's actual chain (`eth_chainId`) — never trust a
 *      creation-time value or the SDK's request.
 *   2. If it is not Base: explicitly request the switch
 *      (`wallet_switchEthereumChain`), adding Base first when the wallet
 *      does not know it (`wallet_addEthereumChain`).
 *   3. RE-READ after any switch. If the wallet is still not on Base, the
 *      signature is BLOCKED — `eth_sendTransaction` is never reached.
 *
 * Pure EIP-1193: no viem, no SDK imports — testable in node with a fake
 * provider, and safe to import from any bundle.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_ID_HEX = "0x2105";
export const BASE_CHAIN_NAME = "Base";
export const BASE_RPC_URLS = ["https://mainnet.base.org"];
export const BASE_EXPLORER_URL = "https://basescan.org";
export const BASE_CURRENCY = { name: "Ether", symbol: "ETH", decimals: 18 };

/** The parameters a wallet needs to add Base before it can switch to it. */
export const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: BASE_CHAIN_NAME,
  nativeCurrency: BASE_CURRENCY,
  rpcUrls: BASE_RPC_URLS,
  blockExplorerUrls: [BASE_EXPLORER_URL],
} as const;

/** The minimal EIP-1193 surface (mirrors buyer-browser's Eip1193Provider). */
export interface ChainEip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export type WalletChainErrorCode =
  | "wrong_chain" /** the wallet stayed on another chain — signature blocked */
  | "switch_rejected" /** the user declined the switch request */
  | "switch_unavailable" /** the wallet could not perform the switch (locked, pending, no method) */
  | "chain_read_failed"; /** the wallet would not report its chain at all */

export class WalletChainError extends Error {
  readonly code: WalletChainErrorCode;
  /** The chain the wallet was actually on when the check last ran. */
  readonly walletChainId: number | null;
  readonly requiredChainId: number;

  constructor(code: WalletChainErrorCode, walletChainId: number | null, requiredChainId: number, detail?: string) {
    super(detail ?? defaultChainMessage(code, walletChainId, requiredChainId));
    this.name = "WalletChainError";
    this.code = code;
    this.walletChainId = walletChainId;
    this.requiredChainId = requiredChainId;
  }
}

function defaultChainMessage(code: WalletChainErrorCode, walletChainId: number | null, required: number): string {
  const want = chainLabel(required);
  const have = walletChainId === null ? "an unknown chain" : chainLabel(walletChainId);
  switch (code) {
    case "wrong_chain":
      return `the wallet stayed on ${have}; NIGHTSHIFT transactions run on ${want} — signing was blocked`;
    case "switch_rejected":
      return `the switch to ${want} was declined, so the signature was not requested`;
    case "switch_unavailable":
      return `the wallet could not switch to ${want} right now`;
    case "chain_read_failed":
      return `the wallet did not report which chain it is on — the signature was not requested`;
  }
}

export function chainLabel(chainId: number | null): string {
  if (chainId === 8453) return "Base (8453)";
  if (chainId === 1) return "Ethereum mainnet (1)";
  if (chainId === 84532) return "Base Sepolia (84532)";
  return chainId === null ? "unknown chain" : `chain ${chainId}`;
}

function toChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return Number.parseInt(value, 16);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function rpcCode(err: unknown): number | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : null;
}

function rpcMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // Some wallets bury the reason in nested data — include it in the probe text.
  const data = (err as { data?: unknown })?.data;
  return `${raw} ${data === undefined ? "" : JSON.stringify(data)}`.trim();
}

/** Read the wallet's ACTIVE chain. null when the wallet will not say. */
export async function readWalletChainId(eip1193: ChainEip1193): Promise<number | null> {
  try {
    return toChainId(await eip1193.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

/**
 * Verify — and when needed repair — the wallet's chain BEFORE a signature.
 * Returns the wallet's chain id once it provably equals `required`.
 * Throws WalletChainError (never requests a signature on a mismatch).
 */
export async function ensureWalletChain(eip1193: ChainEip1193, required: number = BASE_CHAIN_ID): Promise<number> {
  const current = await readWalletChainId(eip1193);
  if (current === required) return current as number;
  if (current === null) throw new WalletChainError("chain_read_failed", null, required);

  const requiredHex = required === BASE_CHAIN_ID ? BASE_CHAIN_ID_HEX : `0x${required.toString(16)}`;
  try {
    await eip1193.request({ method: "wallet_switchEthereumChain", params: [{ chainId: requiredHex }] });
  } catch (switchErr) {
    const code = rpcCode(switchErr);
    const message = rpcMessage(switchErr);
    const unrecognized =
      code === 4902 ||
      code === -32603 && /unrecognized chain|not added|add.*chain/i.test(message) ||
      /unrecognized chain|not added|missing chain|try adding/i.test(message);
    if (unrecognized) {
      // The wallet does not know the chain — add it (Base only), then switch.
      if (required !== BASE_CHAIN_ID) throw new WalletChainError("switch_unavailable", current, required);
      try {
        await eip1193.request({ method: "wallet_addEthereumChain", params: [{ ...BASE_CHAIN_PARAMS }] });
        await eip1193.request({ method: "wallet_switchEthereumChain", params: [{ chainId: requiredHex }] });
      } catch (addError) {
        if (rpcCode(addError) === 4001 || /user rejected|user denied/i.test(rpcMessage(addError))) {
          throw new WalletChainError("switch_rejected", current, required);
        }
        throw new WalletChainError("switch_unavailable", current, required);
      }
    } else if (code === 4001 || /user rejected|user denied|rejected the request/i.test(message)) {
      throw new WalletChainError("switch_rejected", current, required);
    } else {
      throw new WalletChainError("switch_unavailable", current, required);
    }
  }

  const after = await readWalletChainId(eip1193);
  if (after === required) return after as number;
  throw new WalletChainError("wrong_chain", after, required);
}
