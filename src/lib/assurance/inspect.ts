/**
 * Free, real Solana inspection of one investigation.
 *
 * These are genuine reads: public JSON-RPC, no signing, no payment. If an RPC
 * read fails the inspection fails; it never substitutes a plausible value.
 */

import { randomUUID } from "node:crypto";

import { inspectMint, inspectWallet, isValidSolanaAddress, solanaCluster, solanaRpcUrl } from "./solana";
import type { AssuranceEvidence, Investigation } from "./types";

function walletFacts(wallet: Awaited<ReturnType<typeof inspectWallet>>): Record<string, string | number | boolean | null> {
  return {
    address: wallet.address,
    valid: wallet.valid,
    exists: wallet.exists,
    lamports: wallet.lamports,
    solBalance: wallet.solBalance,
    mintAccountAddress: wallet.mintAccount?.address ?? null,
    mintAccountExists: Boolean(wallet.mintAccount),
    mintUiAmount: wallet.mintAccount?.uiAmount ?? null,
    mintRawAmount: wallet.mintAccount?.amountRaw ?? null,
    signatureCount: wallet.signatures.length,
    newestSignatureBlockTime: wallet.newestSignatureBlockTime,
  };
}

export interface InspectionResult {
  evidence: AssuranceEvidence[];
  /** Non-fatal facts worth showing (e.g. history endpoint rate-limited). */
  notes: string[];
}

/** Replaces any previous Solana evidence so a re-run cannot duplicate facts. */
export async function inspectInvestigation(inv: Investigation): Promise<InspectionResult> {
  const { payerWallet, recipientWallet, tokenMint } = inv.transaction;
  const evidence: AssuranceEvidence[] = [];
  const notes: string[] = [];
  const observedAt = new Date().toISOString();
  const rpcUrl = solanaRpcUrl();
  const cluster = solanaCluster();

  const mint = isValidSolanaAddress(tokenMint) ? await inspectMint(tokenMint) : null;
  if (mint) {
    evidence.push({
      id: randomUUID(),
      class: "source_verified",
      capability: "solana_mint",
      title: "Live SPL mint read",
      detail: `${cluster} mint ${mint.address}: ${mint.decimals} decimals, ${mint.supply} base units, freeze authority ${mint.freezeAuthority ?? "none"}, mint authority ${mint.mintAuthority ?? "none"}.`,
      facts: {
        address: mint.address,
        decimals: mint.decimals,
        supply: mint.supply,
        mintAuthority: mint.mintAuthority,
        freezeAuthority: mint.freezeAuthority,
        isInitialized: mint.isInitialized,
        programOwner: mint.programOwner,
        cluster,
      },
      source: { kind: "solana_rpc", ref: mint.rpcUrl, label: `Solana ${cluster} RPC`, observedAt },
    });
  } else {
    notes.push(`The settlement mint (${tokenMint}) is not a valid Solana address, so no mint read was possible.`);
  }

  // Invalid addresses are recorded as facts (valid=false) without an RPC call;
  // that is a finding, not an inspection failure.
  const payer = isValidSolanaAddress(payerWallet) ? await inspectWallet(payerWallet, tokenMint) : null;
  if (payer) {
    if ("historyUnavailable" in payer && payer.historyUnavailable) {
      notes.push(`Payer signature history was unavailable: ${String((payer as unknown as { historyUnavailable: string }).historyUnavailable)}. Balance and token-account reads succeeded.`);
    }
    evidence.push({
      id: randomUUID(),
      class: "source_verified",
      capability: "solana_wallet_payer",
      title: "Live payer wallet read",
      detail: `Payer ${payer.address} on ${cluster}: ${payer.solBalance ?? "?"} SOL, ${payer.mintAccount?.uiAmount ?? 0} settlement tokens, ${payer.signatures.length} recent signature(s).`,
      facts: { ...walletFacts(payer), cluster },
      source: { kind: "solana_rpc", ref: payer.rpcUrl, label: `Solana ${cluster} RPC`, observedAt },
    });
  } else {
    evidence.push({
      id: randomUUID(),
      class: "source_verified",
      capability: "solana_wallet_payer",
      title: "Payer address format check",
      detail: `The payer address ${payerWallet || "(empty)"} is not a valid 32-byte Solana address; no chain read was attempted.`,
      facts: { address: payerWallet, valid: false, cluster },
      source: { kind: "solana_rpc", ref: rpcUrl, label: `Solana ${cluster} RPC (no call made)`, observedAt },
    });
  }

  const recipient = isValidSolanaAddress(recipientWallet) ? await inspectWallet(recipientWallet, tokenMint) : null;
  if (recipient) {
    if ("historyUnavailable" in recipient && recipient.historyUnavailable) {
      notes.push(`Recipient signature history was unavailable: ${String((recipient as unknown as { historyUnavailable: string }).historyUnavailable)}. Balance and token-account reads succeeded.`);
    }
    evidence.push({
      id: randomUUID(),
      class: "source_verified",
      capability: "solana_wallet_recipient",
      title: "Live recipient wallet read",
      detail: `Recipient ${recipient.address} on ${cluster}: ${recipient.solBalance ?? "?"} SOL, ${recipient.mintAccount?.uiAmount ?? 0} settlement tokens, ${recipient.signatures.length} recent signature(s).`,
      facts: { ...walletFacts(recipient), cluster },
      source: { kind: "solana_rpc", ref: recipient.rpcUrl, label: `Solana ${cluster} RPC`, observedAt },
    });
  } else {
    evidence.push({
      id: randomUUID(),
      class: "source_verified",
      capability: "solana_wallet_recipient",
      title: "Recipient address format check",
      detail: `The recipient address ${recipientWallet || "(empty)"} is not a valid 32-byte Solana address; no chain read was attempted.`,
      facts: { address: recipientWallet, valid: false, cluster },
      source: { kind: "solana_rpc", ref: rpcUrl, label: `Solana ${cluster} RPC (no call made)`, observedAt },
    });
  }

  return { evidence, notes };
}
