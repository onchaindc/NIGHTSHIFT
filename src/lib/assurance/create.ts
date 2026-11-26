import { isValidSolanaAddress } from "./solana";
import { newInvestigationId, newReference, audit } from "./store";
import { USDC_MINT_MAINNET, type Investigation, type InvestigationTransaction } from "./types";

export interface CreateInvestigationBody {
  payerWallet?: unknown;
  recipientWallet?: unknown;
  amountUsdc?: unknown;
  tokenMint?: unknown;
  jurisdiction?: unknown;
  approvedBeneficiary?: unknown;
  contractRef?: unknown;
  memo?: unknown;
  counterpartyName?: unknown;
  registrationNumber?: unknown;
  contact?: unknown;
  walletLabel?: unknown;
  ownershipRequired?: unknown;
  documents?: unknown;
  contractText?: unknown;
  spendLimitUsdCents?: unknown;
}

function str(v: unknown, max = 400): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function parseCreateBody(body: CreateInvestigationBody, createdBy = "operator", owner: string | null = null): { ok: true; investigation: Investigation } | { ok: false; error: string } {
  const payerWallet = str(body.payerWallet, 64);
  const recipientWallet = str(body.recipientWallet, 64);
  const amountUsdc = Number(body.amountUsdc);
  const tokenMint = str(body.tokenMint, 64) || USDC_MINT_MAINNET;
  const approvedBeneficiary = str(body.approvedBeneficiary, 160);
  const counterpartyName = str(body.counterpartyName, 160);
  const jurisdiction = str(body.jurisdiction, 60);

  if (!payerWallet) return { ok: false, error: "payerWallet is required" };
  if (!recipientWallet) return { ok: false, error: "recipientWallet is required" };
  if (!isValidSolanaAddress(payerWallet)) return { ok: false, error: "payerWallet is not a valid Solana address" };
  if (!isValidSolanaAddress(recipientWallet)) return { ok: false, error: "recipientWallet is not a valid Solana address" };
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return { ok: false, error: "amountUsdc must be a positive number" };
  if (!isValidSolanaAddress(tokenMint)) return { ok: false, error: "tokenMint is not a valid Solana address" };
  if (approvedBeneficiary.length < 2) return { ok: false, error: "approvedBeneficiary is required" };
  if (counterpartyName.length < 2) return { ok: false, error: "counterpartyName is required" };
  if (!jurisdiction) return { ok: false, error: "jurisdiction is required" };

  const documents = Array.isArray(body.documents)
    ? body.documents
        .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
        .slice(0, 10)
        .map((d) => ({
          name: str(d.name, 200) || "Untitled document",
          sha256: str(d.sha256, 128) || undefined,
          note: str(d.note, 600) || undefined,
          content: str(d.content, 20_000) || undefined,
        }))
    : [];

  const limit = Number(body.spendLimitUsdCents);
  const spendLimitUsdCents = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 10; // $0.10 default

  const transaction: InvestigationTransaction = {
    payerWallet,
    recipientWallet,
    amountUsdc,
    tokenMint,
    jurisdiction,
    approvedBeneficiary,
    contractRef: str(body.contractRef, 200),
    memo: str(body.memo, 200),
    documents,
    ownershipRequired: body.ownershipRequired !== false,
    ...(str(body.contractText, 20_000) ? { contractText: str(body.contractText, 20_000) } : {}),
  };

  const investigation: Investigation = {
    id: newInvestigationId(),
    reference: newReference(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "draft",
    dataMode: "live",
    owner: owner ? owner.toLowerCase() : null,
    transaction,
    counterparty: {
      legalName: counterpartyName,
      registrationNumber: str(body.registrationNumber, 120) || undefined,
      walletLabel: str(body.walletLabel, 160) || undefined,
      contact: str(body.contact, 160) || undefined,
    },
    evidence: [],
    findings: [],
    decision: null,
    intelligenceRuns: [],
    settlement: null,
    spendLimitUsdCents,
    operator: { createdBy, tenant: "nightshift-institutional" },
    audit: [],
    limitations: [],
  };
  audit(investigation, createdBy, "investigation_created", `File opened for ${approvedBeneficiary} · ${amountUsdc.toLocaleString("en-US")} USDC.`);
  return { ok: true, investigation };
}
