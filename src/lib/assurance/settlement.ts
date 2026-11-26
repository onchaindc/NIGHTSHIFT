/**
 * Settlement assurance.
 *
 * A prepared bundle is a set of REAL SPL-Token + memo instructions built from
 * live Solana state (token accounts and a recent blockhash). It is UNSIGNED
 * and is never broadcast by NIGHTSHIFT. An authorized institutional signer
 * must sign and submit it; only then can a signature be checked, and only a
 * confirmed, error-free transaction is recorded as settled.
 */

import { randomUUID } from "node:crypto";

import { checkSignature, getLatestBlockhash, inspectMint, inspectWallet, isValidSolanaAddress, solanaRpcUrl } from "./solana";
import { buildTransferBundle } from "./solana";
import { audit, saveInvestigation } from "./store";
import type { Investigation, SettlementRecord } from "./types";

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/** Exact decimal → base units, without floating-point drift. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new SettlementError("the transfer amount must be positive");
  const [whole, fraction = ""] = amount.toFixed(decimals).split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function refuse(inv: Investigation, reason: string): never {
  throw new SettlementError(`${reason} Nothing was prepared.`);
}

export async function prepareSettlement(inv: Investigation, actor = "operator"): Promise<SettlementRecord> {
  if (!inv.decision) refuse(inv, "No authorization decision has been recorded for this file.");
  if (inv.decision.outcome !== "CLEARED") {
    refuse(inv, `The authorization decision is ${inv.decision.outcome}; settlement can only be prepared for a CLEARED transaction.`);
  }
  if (!inv.decision.settlementAuthorized || inv.dataMode !== "live") {
    refuse(inv, "This file is not authorized to settle (demonstration data or unverified provenance).");
  }
  const { payerWallet, recipientWallet, tokenMint, amountUsdc, memo } = inv.transaction;
  if (!isValidSolanaAddress(tokenMint)) refuse(inv, "The settlement mint is not a valid Solana address.");
  if (!isValidSolanaAddress(payerWallet)) refuse(inv, "The payer wallet is not a valid Solana address.");
  if (!isValidSolanaAddress(recipientWallet)) refuse(inv, "The recipient wallet is not a valid Solana address.");

  const [mint, payer, recipient, head] = await Promise.all([
    inspectMint(tokenMint),
    inspectWallet(payerWallet, tokenMint),
    inspectWallet(recipientWallet, tokenMint),
    getLatestBlockhash(),
  ]);

  if (!payer.mintAccount) {
    refuse(inv, `The payer holds no token account for mint ${tokenMint} on this cluster, so there is no source account to transfer from.`);
  }
  if (!recipient.mintAccount) {
    refuse(
      inv,
      `The recipient has no associated token account for mint ${tokenMint}. An associated token account must be created and verified by the counterparty before an instruction bundle can reference it.`,
    );
  }

  const amountBaseUnits = toBaseUnits(amountUsdc, mint.decimals);
  if (BigInt(payer.mintAccount.amountRaw) < amountBaseUnits) {
    refuse(
      inv,
      `The payer's live token balance (${payer.mintAccount.amountRaw} base units) is below the transfer amount (${amountBaseUnits.toString()} base units).`,
    );
  }

  const bundle = buildTransferBundle({
    sourceTokenAccount: payer.mintAccount.address,
    destinationTokenAccount: recipient.mintAccount.address,
    owner: payerWallet,
    mint: tokenMint,
    amountBaseUnits,
    memo: memo?.trim() || `NIGHTSHIFT ${inv.reference}`,
    recentBlockhash: head.blockhash,
    lastValidBlockHeight: head.lastValidBlockHeight,
    rpcUrl: head.rpcUrl,
  });

  const settlement: SettlementRecord = {
    id: randomUUID(),
    preparedAt: new Date().toISOString(),
    status: "prepared",
    recentBlockhash: bundle.recentBlockhash,
    lastValidBlockHeight: bundle.lastValidBlockHeight,
    sourceTokenAccount: bundle.sourceTokenAccount,
    destinationTokenAccount: bundle.destinationTokenAccount,
    mint: bundle.mint,
    amountBaseUnits: bundle.amountBaseUnits,
    instructions: bundle.instructions,
    signedByNightshift: false,
    broadcastByNightshift: false,
    signature: null,
    verification: null,
  };

  inv.settlement = settlement;
  inv.status = "settlement_prepared";
  audit(
    inv,
    actor,
    "settlement_prepared",
    `Unsigned SPL transfer bundle prepared from blockhash ${bundle.recentBlockhash}; ${bundle.amountBaseUnits} base units to ${bundle.destinationTokenAccount}. Not signed, not broadcast.`,
  );
  await saveInvestigation(inv);
  return settlement;
}

export async function verifySettlementSignature(
  inv: Investigation,
  signature: string,
  actor = "operator",
): Promise<SettlementRecord> {
  if (!inv.settlement) refuse(inv, "No settlement bundle has been prepared for this file.");
  const sig = signature.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) {
    throw new SettlementError("That is not a plausible Solana transaction signature.");
  }

  const status = await checkSignature(sig);
  const confirmed = status.status === "confirmed" && !status.err;

  inv.settlement.signature = sig;
  inv.settlement.verification = {
    checkedAt: new Date().toISOString(),
    status: status.status,
    slot: status.slot,
    confirmationStatus: status.confirmationStatus,
    err: status.err,
    rpcUrl: status.rpcUrl,
  };
  inv.settlement.status = confirmed
    ? "confirmed_on_chain"
    : status.status === "failed"
      ? "failed"
      : "pending_confirmation";
  if (confirmed) inv.status = "settled";

  audit(
    inv,
    actor,
    "settlement_signature_checked",
    `Signature ${sig.slice(0, 12)}… read from ${status.rpcUrl}: ${status.status}${status.slot ? ` at slot ${status.slot}` : ""}${status.err ? ` (err ${status.err})` : ""}.`,
  );
  await saveInvestigation(inv);
  return inv.settlement;
}
