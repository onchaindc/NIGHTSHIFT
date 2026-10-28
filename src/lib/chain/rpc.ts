/**
 * Minimal read-only on-chain lookup tool for NIGHTSHIFT's verification step.
 *
 * This is a REAL permitted tool: it only reads public chain data (no signing,
 * no state changes) and is used to independently confirm a settlement recorded
 * in a Telegraph x402 receipt WITHOUT taking the miner's word for it.
 */

export const DEFAULT_BASE_SEPOLIA_RPC = "https://sepolia.base.org";

/** Public read-only JSON-RPC endpoints used for independent chain reads. */
export const PUBLIC_CHAIN_RPCS: Record<string, string> = {
  base: "https://base-rpc.publicnode.com",
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  "base-sepolia": "https://sepolia.base.org",
};

export interface ChainGasPrice {
  chain: string;
  gasPriceWei: number;
  gasPriceGwei: number;
  rpcUrl: string;
}

/** Reads the current suggested gas price from a public RPC for a named chain. */
export async function getGasPrice(chain: string, rpcOverride?: string): Promise<ChainGasPrice> {
  const rpcUrl = rpcOverride || PUBLIC_CHAIN_RPCS[chain] || DEFAULT_BASE_SEPOLIA_RPC;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
    });
    if (!res.ok) throw new Error(`node returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    if (!body.result) throw new Error("no result");
    const wei = Number(BigInt(body.result));
    return { chain, gasPriceWei: wei, gasPriceGwei: wei / 1e9, rpcUrl };
  } catch (err) {
    throw new ChainReadError(`gas read failed for ${chain}: ${err instanceof Error ? err.message : err}`);
  }
}

export interface ChainReceipt {
  found: boolean;
  status: "success" | "reverted" | "pending" | "not_found";
  blockNumber: number | null;
  to: string | null;
  rpcUrl: string;
}

export class ChainReadError extends Error {}

export async function getTransactionReceipt(
  txHash: string,
  rpcUrl: string = (process.env.NIGHTSHIFT_CHAIN_RPC_URL as string) || DEFAULT_BASE_SEPOLIA_RPC,
): Promise<ChainReceipt> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txHash] },
        { jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [txHash] },
      ]),
    });
    if (!res.ok) throw new Error(`node returned HTTP ${res.status}`);
    const body = (await res.json()) as Array<{ result?: unknown; error?: { message: string } }>;
    const txErr = body.find((x) => x.error);
    if (txErr) throw new Error(txErr.error!.message);
    const tx = body[0]?.result as { to?: string } | null | undefined;
    const receipt = body[1]?.result as { status?: string; blockNumber?: string } | null | undefined;

    if (!tx && !receipt) {
      return { found: false, status: "not_found", blockNumber: null, to: null, rpcUrl };
    }
    const mined = receipt !== undefined && receipt !== null;
    return {
      found: mined,
      status: mined ? (receipt!.status === "0x1" ? "success" : "reverted") : "pending",
      blockNumber: receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
      to: tx?.to ?? null,
      rpcUrl,
    };
  } catch (err) {
    throw new ChainReadError(`Base Sepolia read failed for ${txHash.slice(0, 18)}…: ${err instanceof Error ? err.message : err}`);
  }
}
