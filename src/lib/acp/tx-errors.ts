/**
 * The buyer's error language — the one place a raw transaction failure
 * becomes something a customer can act on.
 *
 * The problem this replaces: the desk surfaced wallet/RPC errors verbatim —
 * request URLs, signed-transaction fragments, provider internals — as the
 * whole error surface. The rule now:
 *
 *   - a SHORT human title ("Insufficient Base ETH"),
 *   - one clear explanation of what happened and what did NOT happen
 *     ("No transaction was submitted."),
 *   - specific recovery actions,
 *   - the raw detail only inside an expandable technical section.
 *
 * Every class the desk must distinguish has its own entry: rejected
 * signatures, insufficient gas, insufficient USDC, wrong network, RPC
 * failures, reverted transactions and failed job creation.
 */

import { WalletChainError } from "./wallet-chain";

export type TxErrorCode =
  | "user_rejected" /** the buyer declined a signature — nothing moved */
  | "insufficient_gas" /** no Base ETH for gas — nothing was submitted */
  | "insufficient_usdc" /** not enough USDC for the escrow */
  | "usdc_allowance" /** the escrow's USDC allowance is short */
  | "wrong_network" /** wallet on another chain — signing blocked */
  | "switch_rejected" /** buyer declined the network switch */
  | "rpc_failure" /** the wallet RPC / network call failed */
  | "tx_reverted" /** the transaction landed and reverted */
  | "job_creation_failed" /** the job tx landed but no JobCreated event */
  | "unknown";

export interface TxErrorView {
  code: TxErrorCode;
  title: string;
  explanation: string;
  /** Specific recovery actions, in the order the buyer should try them. */
  actions: string[];
  /** The raw detail — for the expandable technical section only. */
  technical: string | null;
}

function rawOf(err: unknown): string {
  if (err instanceof WalletChainError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function rpcCode(err: unknown): number | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : null;
}

/** Cap the raw detail; a signed payload never belongs in any UI surface. */
function sanitizeTechnical(err: unknown): string {
  const raw = rawOf(err).replace(/\s+/g, " ").trim();
  return raw.length > 420 ? `${raw.slice(0, 420)}…` : raw;
}

const CATALOG: Record<TxErrorCode, Omit<TxErrorView, "code" | "technical">> = {
  user_rejected: {
    title: "Signature declined",
    explanation: "You declined the request in your wallet, so nothing was signed and nothing was submitted. Your funds are untouched.",
    actions: ["Start the step again when you are ready — you will be asked to confirm in your wallet once more."],
  },
  insufficient_gas: {
    title: "Insufficient Base ETH",
    explanation:
      "Your wallet does not have enough ETH on Base to pay transaction gas. No transaction was submitted.",
    actions: [
      "Add a small amount of ETH on Base to this wallet — roughly $1 of gas covers a full purchase (job creation, allowance and funding).",
      "Bridge ETH to Base, buy ETH on Base through your wallet, or deposit from an exchange that supports Base withdrawals.",
      "Retry the step once the wallet shows a non-zero Base balance.",
    ],
  },
  insufficient_usdc: {
    title: "Not enough USDC on Base",
    explanation: "The wallet's USDC balance on Base is below the job's price. Nothing was funded and no USDC moved.",
    actions: [
      "Add the missing USDC on Base to this wallet (native USDC, contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).",
      "Retry the payment step once the balance covers the price.",
    ],
  },
  usdc_allowance: {
    title: "USDC permission is short",
    explanation: "The ACP escrow does not have permission to take the job's USDC from your wallet yet, so the payment could not complete.",
    actions: ["Approve the allowance again (the first wallet confirmation of the payment step), then fund the escrow."],
  },
  wrong_network: {
    title: "Wrong network",
    explanation: "Your wallet is not on Base, so signing was blocked — a NIGHTSHIFT transaction was never requested on another chain.",
    actions: ["Switch the wallet to Base (chain 8453), then retry the step."],
  },
  switch_rejected: {
    title: "Network switch declined",
    explanation: "The switch to Base was declined in your wallet. Without Base, no NIGHTSHIFT transaction can be signed.",
    actions: ["Retry the step and accept the network-switch prompt in your wallet, or switch to Base manually in the wallet's network menu."],
  },
  rpc_failure: {
    title: "The wallet's connection hiccuped",
    explanation: "The request to the wallet's network service failed before your transaction could be built. Nothing was submitted.",
    actions: ["Retry the step in a moment — most failures clear on the second attempt.", "If it repeats, check the wallet's connection or try again on a steadier network."],
  },
  tx_reverted: {
    title: "Transaction reverted",
    explanation: "The transaction reached Base and the contract refused it, so no state changed. Gas may still have been spent.",
    actions: ["Check the linked transaction on Basescan for the revert reason.", "Retry the step; if it reverts again, contact support with the transaction hash."],
  },
  job_creation_failed: {
    title: "Job creation did not confirm",
    explanation: "The creation transaction landed, but the job id could not be read back from it. The desk will not pretend the job exists.",
    actions: [
      "Open the linked transaction on Basescan to confirm what happened.",
      "If the transaction reverted, retry; if it landed, retry once more — the desk reads the job id from the receipt.",
    ],
  },
  unknown: {
    title: "The step did not complete",
    explanation: "Something failed before the step could finish. Nothing was submitted unless a transaction hash appears below or on Basescan.",
    actions: ["Retry the step once.", "If it keeps failing, expand the technical details and report them."],
  },
};

/** Map any thrown failure to the buyer's error language. */
export function classifyTxError(err: unknown): TxErrorView {
  const technical = sanitizeTechnical(err);
  const raw = rawOf(err).toLowerCase();
  const code = err instanceof WalletChainError ? err.code : rpcCode(err);

  if (err instanceof WalletChainError) {
    if (err.code === "wrong_chain") return { code: "wrong_network", technical, ...CATALOG.wrong_network };
    if (err.code === "switch_rejected") return { code: "switch_rejected", technical, ...CATALOG.switch_rejected };
    if (err.code === "chain_read_failed") return { code: "rpc_failure", technical, ...CATALOG.rpc_failure };
    return { code: "switch_rejected", technical, ...CATALOG.switch_rejected };
  }
  if (code === 4001 || /user rejected|user denied|rejected the request|declined/i.test(raw)) {
    return { code: "user_rejected", technical, ...CATALOG.user_rejected };
  }
  if (/insufficient funds|not enough.*gas|gas required exceeds allowance|insufficient.*eth/i.test(raw)) {
    return { code: "insufficient_gas", technical, ...CATALOG.insufficient_gas };
  }
  if (/exceeds allowance|insufficient allowance/i.test(raw)) {
    return { code: "usdc_allowance", technical, ...CATALOG.usdc_allowance };
  }
  if (/exceeds balance|insufficient balance|transfer amount exceeds/i.test(raw)) {
    return { code: "insufficient_usdc", technical, ...CATALOG.insufficient_usdc };
  }
  if (/execution reverted|revert|out of gas|expired while pending|dropped|replaced/i.test(raw)) {
    return { code: "tx_reverted", technical, ...CATALOG.tx_reverted };
  }
  if (/no jobcreated|jobcreation|could not be read back/i.test(raw)) {
    return { code: "job_creation_failed", technical, ...CATALOG.job_creation_failed };
  }
  if (
    /failed to fetch|load failed|network ?error|rate limit|too many requests|429|-32005|timeout|timed out|internal json-rpc|-32603|connection/i.test(raw)
  ) {
    return { code: "rpc_failure", technical, ...CATALOG.rpc_failure };
  }
  return { code: "unknown", technical, ...CATALOG.unknown };
}
