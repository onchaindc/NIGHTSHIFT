/**
 * Solana inspection and settlement preparation.
 *
 * Read-only JSON-RPC against a public (or operator-configured) Solana endpoint.
 * Nothing here signs, submits or simulates a settlement: the one action that
 * could move funds produces an UNSIGNED instruction bundle and the caller is
 * told, in the record itself, that NIGHTSHIFT did not sign or broadcast it.
 *
 * `SOLANA_RPC_URL` overrides the endpoint (devnet, Helius, Triton, ...).
 * `SOLANA_CLUSTER` labels the reads (defaults to mainnet-beta when the default
 * endpoint is used).
 */

import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./types";

export const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

export class SolanaReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaReadError";
  }
}

export function solanaRpcUrl(): string {
  return (process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC).replace(/\/+$/, "");
}

export function solanaCluster(): string {
  const explicit = (process.env.SOLANA_CLUSTER || "").trim();
  if (explicit) return explicit;
  const url = solanaRpcUrl();
  if (url.includes("devnet")) return "devnet";
  if (url.includes("testnet")) return "testnet";
  return "mainnet-beta";
}

/* ------------------------------------------------------------------ */
/* Base58 (addresses only; no signing key material is ever handled)    */
/* ------------------------------------------------------------------ */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array | null {
  if (!input) return null;
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = B58_ALPHABET.indexOf(ch);
    if (value < 0) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1' characters are leading zero bytes.
  for (let i = 0; i < input.length && input[i] === "1"; i++) bytes.push(0);
  while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop();
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/** A Solana address is exactly 32 base58-decoded bytes; the string form is canonical. */
export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return false;
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 32) return false;
  return base58Encode(decoded) === address;
}

/* ------------------------------------------------------------------ */
/* JSON-RPC                                                            */
/* ------------------------------------------------------------------ */

interface RpcEnvelope<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface RpcContext {
  slot: number;
}

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[], timeoutMs = 12_000): Promise<{ result: T; slot: number | null; rpcUrl: string }> {
  const rpcUrl = solanaRpcUrl();
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SolanaReadError(`Solana RPC unreachable (${rpcUrl}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new SolanaReadError(`Solana RPC returned HTTP ${res.status} for ${method}`);
  }
  const body = (await res.json()) as RpcEnvelope<T>;
  if (body.error) {
    throw new SolanaReadError(`Solana RPC ${method} failed: ${body.error.message} (${body.error.code})`);
  }
  if (body.result === undefined) {
    throw new SolanaReadError(`Solana RPC ${method} returned no result`);
  }
  return { result: body.result, slot: null, rpcUrl };
}

export interface TokenAccount {
  address: string;
  mint: string;
  owner: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number | null;
}

export interface WalletInspection {
  address: string;
  valid: boolean;
  exists: boolean;
  lamports: number | null;
  solBalance: number | null;
  tokenAccounts: TokenAccount[];
  /** Token account for the inspected mint, when one exists. */
  mintAccount: TokenAccount | null;
  signatures: Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>;
  oldestSignatureBlockTime: number | null;
  newestSignatureBlockTime: number | null;
  /** Present when history could not be read (rate limit) — absence of history is NOT reported as no activity. */
  historyUnavailable?: string;
  rpcUrl: string;
  slot: number | null;
  readAt: string;
}

export interface MintInspection {
  address: string;
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
  programOwner: string;
  rpcUrl: string;
  slot: number | null;
  readAt: string;
}

interface ParsedTokenAccount {
  account: {
    data: {
      parsed?: {
        info?: {
          mint?: string;
          owner?: string;
          tokenAmount?: { amount?: string; decimals?: number; uiAmount?: number | null };
        };
      };
    };
    owner?: string;
  };
  pubkey: string;
}

async function getTokenAccountsByOwner(address: string): Promise<{ accounts: TokenAccount[]; rpcUrl: string; slot: number | null }> {
  const { result, rpcUrl } = await rpc<{ context: RpcContext; value: ParsedTokenAccount[] }>(
    "getTokenAccountsByOwner",
    [address, { programId: TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }],
  );
  const accounts: TokenAccount[] = [];
  for (const entry of result.value ?? []) {
    const info = entry.account?.data?.parsed?.info;
    if (!info?.mint || !info.owner) continue;
    const amountRaw = info.tokenAmount?.amount ?? "0";
    accounts.push({
      address: entry.pubkey,
      mint: info.mint,
      owner: info.owner,
      amountRaw,
      decimals: info.tokenAmount?.decimals ?? 0,
      uiAmount: info.tokenAmount?.uiAmount ?? null,
    });
  }
  return { accounts, rpcUrl, slot: result.context?.slot ?? null };
}

/** Real Solana reads for one wallet. Throws instead of inventing state. */
export async function inspectWallet(address: string, mint: string): Promise<WalletInspection> {
  const valid = isValidSolanaAddress(address);
  if (!valid) {
    return {
      address,
      valid: false,
      exists: false,
      lamports: null,
      solBalance: null,
      tokenAccounts: [],
      mintAccount: null,
      signatures: [],
      oldestSignatureBlockTime: null,
      newestSignatureBlockTime: null,
      rpcUrl: solanaRpcUrl(),
      slot: null,
      readAt: new Date().toISOString(),
    };
  }

  const balance = await rpc<{ context: RpcContext; value: number }>("getBalance", [address, { commitment: "confirmed" }]);
  const tokenState = await getTokenAccountsByOwner(address);

  // Signature history is best-effort: a fresh wallet legitimately has none, and
  // an RPC that rate-limits history must not be reported as "no activity".
  let signatures: WalletInspection["signatures"] = [];
  let historyUnavailable: string | null = null;
  try {
    const history = await rpc<Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>>(
      "getSignaturesForAddress",
      [address, { limit: 10, commitment: "confirmed" }],
      10_000,
    );
    signatures = history.result ?? [];
  } catch (err) {
    historyUnavailable = err instanceof Error ? err.message : String(err);
  }

  const blockTimes = signatures.map((s) => s.blockTime).filter((t): t is number => typeof t === "number");
  const mintAccount = tokenState.accounts.find((a) => a.mint === mint) ?? null;

  return {
    address,
    valid: true,
    exists: balance.result.value > 0 || tokenState.accounts.length > 0 || signatures.length > 0,
    lamports: balance.result.value,
    solBalance: balance.result.value / 1e9,
    tokenAccounts: tokenState.accounts,
    mintAccount,
    signatures,
    oldestSignatureBlockTime: blockTimes.length > 0 ? Math.min(...blockTimes) : null,
    newestSignatureBlockTime: blockTimes.length > 0 ? Math.max(...blockTimes) : null,
    rpcUrl: tokenState.rpcUrl,
    slot: tokenState.slot ?? balance.result.context?.slot ?? null,
    readAt: new Date().toISOString(),
    ...(historyUnavailable ? { historyUnavailable } : {}),
  } as WalletInspection;
}

/** Real SPL mint metadata: decimals, authorities, supply. */
export async function inspectMint(mint: string): Promise<MintInspection> {
  if (!isValidSolanaAddress(mint)) {
    throw new SolanaReadError(`mint ${mint} is not a valid Solana address`);
  }
  const { result, rpcUrl } = await rpc<{
    context: RpcContext;
    value: {
      owner: string;
      data: {
        parsed?: {
          info?: {
            decimals?: number;
            supply?: string;
            mintAuthority?: string | null;
            freezeAuthority?: string | null;
            isInitialized?: boolean;
          };
        };
      };
    } | null;
  }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);

  const value = result.value;
  if (!value) throw new SolanaReadError(`mint account ${mint} not found on ${solanaCluster()}`);
  const info = value.data.parsed?.info;
  if (!info || typeof info.decimals !== "number") {
    throw new SolanaReadError(`account ${mint} is not a parsed SPL token mint`);
  }
  return {
    address: mint,
    decimals: info.decimals,
    supply: info.supply ?? "0",
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    isInitialized: info.isInitialized !== false,
    programOwner: value.owner,
    rpcUrl,
    slot: result.context?.slot ?? null,
    readAt: new Date().toISOString(),
  };
}

export async function getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number; rpcUrl: string }> {
  const { result, rpcUrl } = await rpc<{ context: RpcContext; value: { blockhash: string; lastValidBlockHeight: number } }>(
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
  );
  return { ...result.value, rpcUrl };
}

export interface SignatureStatus {
  found: boolean;
  status: string;
  slot: number | null;
  confirmationStatus: string | null;
  err: string | null;
  rpcUrl: string;
}

/**
 * Independently check a settlement signature. Only a confirmed, error-free
 * transaction is reported as on-chain; everything else stays unverified.
 */
export async function checkSignature(signature: string): Promise<SignatureStatus> {
  const rpcUrl = solanaRpcUrl();
  const { result } = await rpc<{
    context: RpcContext;
    value: Array<{ slot: number; confirmations: number | null; err: unknown; confirmationStatus?: string } | null>;
  }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);

  const entry = result.value?.[0] ?? null;
  if (!entry) {
    return { found: false, status: "not_found", slot: null, confirmationStatus: null, err: null, rpcUrl };
  }
  const err = entry.err ? JSON.stringify(entry.err) : null;
  const confirmed = entry.confirmationStatus === "confirmed" || entry.confirmationStatus === "finalized" || entry.confirmations === null;
  return {
    found: true,
    status: err ? "failed" : confirmed ? "confirmed" : "pending",
    slot: entry.slot ?? null,
    confirmationStatus: entry.confirmationStatus ?? (entry.confirmations === null ? "finalized" : null),
    err,
    rpcUrl,
  };
}

/* ------------------------------------------------------------------ */
/* SPL transfer instruction construction (unsigned)                    */
/* ------------------------------------------------------------------ */

function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bs58Bytes(value: string): Uint8Array {
  const decoded = base58Decode(value);
  if (!decoded || decoded.length !== 32) throw new SolanaReadError(`not a Solana address: ${value}`);
  return decoded;
}

export interface PreparedBundle {
  recentBlockhash: string;
  lastValidBlockHeight: number;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  mint: string;
  amountBaseUnits: string;
  decimals: number;
  instructions: Array<{ programId: string; keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; data: string; description: string }>;
  rpcUrl: string;
}

/**
 * Build the exact SPL-Token transfer + memo instructions an institutional
 * signer would sign. The instruction data is real wire format; nothing is
 * serialized into a signed transaction and nothing is submitted.
 */
export function buildTransferBundle(input: {
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  owner: string;
  mint: string;
  amountBaseUnits: bigint;
  memo: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  rpcUrl: string;
}): PreparedBundle {
  // SPL Token `Transfer` (instruction index 3) followed by a little-endian u64.
  const transferData = new Uint8Array(9);
  transferData[0] = 3;
  transferData.set(u64Le(input.amountBaseUnits), 1);
  const transferB64 = Buffer.from(transferData).toString("base64");

  // Memo instruction data is UTF-8 memo bytes (length-prefixed is only needed
  // for multi-instruction memos; a single memo string is sent as-is).
  const memoData = new TextEncoder().encode(input.memo.slice(0, 566));
  const memoB64 = Buffer.from(memoData).toString("base64");

  return {
    recentBlockhash: input.recentBlockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
    sourceTokenAccount: input.sourceTokenAccount,
    destinationTokenAccount: input.destinationTokenAccount,
    mint: input.mint,
    amountBaseUnits: input.amountBaseUnits.toString(),
    decimals: 6,
    rpcUrl: input.rpcUrl,
    instructions: [
      {
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: input.owner, isSigner: true, isWritable: false }],
        data: memoB64,
        description: "Memo carrying the investigation reference for settlement reconciliation",
      },
      {
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: input.sourceTokenAccount, isSigner: false, isWritable: true },
          { pubkey: input.destinationTokenAccount, isSigner: false, isWritable: true },
          { pubkey: input.owner, isSigner: true, isWritable: false },
        ],
        data: transferB64,
        description: "SPL Token transfer of the approved amount to the counterparty token account",
      },
    ],
  };
}

/** Address bytes for a key, used only to prove the bundle references real keys. */
export function addressBytes(address: string): Uint8Array {
  return bs58Bytes(address);
}
