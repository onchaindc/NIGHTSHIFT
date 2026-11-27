/**
 * The buyer side of NIGHTSHIFT's ACP commerce — persistence for jobs a
 * customer created against the NIGHTSHIFT provider with their OWN wallet.
 *
 * The provider keeps `acp-job-<key>` (the seller lifecycle). The buyer keeps
 * `acp-buyer-job-<key>` (their reference: tx hashes, the requirement they
 * sent, their progress through payment). Both live in the same swappable
 * named-document store; the key `<chainId>:<jobId>` is the join and the
 * idempotency boundary — registering the same on-chain job twice upserts.
 *
 * A buyer record is WRITE-BOUND to the wallet session that created it: the
 * routes derive `clientAddress` from the verified session cookie and refuse
 * any write whose key belongs to another wallet's record. The provider
 * signer never appears here or anywhere near a browser.
 */

import { persistence } from "@/lib/storage";
import { getAcpJob } from "./store";
import { offeringById, validateRequirement } from "./offerings";
import type { AcpJobRecord } from "./types";

export function buyerJobKey(chainId: number, jobId: string): string {
  return `${chainId}:${jobId}`;
}

function docName(key: string): string {
  return `acp-buyer-job-${key}`;
}

function indexName(address: string): string {
  return `acp-buyer-jobs-${address.toLowerCase()}`;
}

/** The buyer's own record of one ACP job, created with the buyer's wallet. */
export interface BuyerJobRecord {
  /** `${chainId}:${jobId}` — the join with the provider's AcpJobRecord. */
  key: string;
  chainId: number;
  jobId: string;
  offering: string;
  clientAddress: string;
  /** The createJob transaction hash (the job's birth on-chain). */
  txHash: string | null;
  /** The validated subject fields — exactly what the desk engine will run. */
  requirement: Record<string, string>;
  /** The exact JSON sent to the job room as the requirement message. */
  requirementJson: string;
  requirementSentAt: string | null;
  allowanceTxHash: string | null;
  fundedTxHash: string | null;
  /** The buyer's own completion tx (escrow release) when they accept delivery. */
  completedTxHash: string | null;
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export function newBuyerJob(input: {
  chainId: number;
  jobId: string;
  offering: string;
  clientAddress: string;
  txHash: string | null;
  requirement: Record<string, string>;
  requirementJson: string;
}): BuyerJobRecord {
  const now = new Date().toISOString();
  return {
    key: buyerJobKey(input.chainId, input.jobId),
    chainId: input.chainId,
    jobId: input.jobId,
    offering: input.offering,
    clientAddress: input.clientAddress.toLowerCase(),
    txHash: input.txHash,
    requirement: input.requirement,
    requirementJson: input.requirementJson,
    // The requirement rides the job's on-chain description (the createJob
    // description param) — delivered the moment the job exists. The job-room
    // message is an additional channel, not a prerequisite.
    requirementSentAt: now,
    allowanceTxHash: null,
    fundedTxHash: null,
    completedTxHash: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function getBuyerJob(key: string): Promise<BuyerJobRecord | null> {
  const record = await persistence().readNamed<BuyerJobRecord>(docName(key));
  return record && record.key === key ? record : null;
}

export async function saveBuyerJob(job: BuyerJobRecord): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await persistence().writeNamed(docName(job.key), job);
  const index = await persistence().readNamed<string[]>(indexName(job.clientAddress));
  const list = Array.isArray(index) ? index.filter((k) => typeof k === "string") : [];
  if (!list.includes(job.key)) {
    list.push(job.key);
    await persistence().writeNamed(indexName(job.clientAddress), list);
  }
}

export async function listBuyerJobs(clientAddress: string): Promise<BuyerJobRecord[]> {
  const index = await persistence().readNamed<string[]>(indexName(clientAddress.toLowerCase()));
  if (!Array.isArray(index) || index.length === 0) return [];
  const records = await persistence().readManyNamed<BuyerJobRecord>(index.map((k) => docName(k)));
  return records
    .filter((r): r is BuyerJobRecord => Boolean(r && r.key && r.clientAddress === clientAddress.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function appendNote(job: BuyerJobRecord, note: string): void {
  job.notes = [...job.notes, `${new Date().toISOString()} ${note}`.slice(0, 300)].slice(-40);
}

/* ------------------------------------------------------------------ */
/* The merged view: the buyer's record × the provider's lifecycle      */
/* ------------------------------------------------------------------ */

/** Buyer-facing phases — the honest words for where the job stands. */
export type BuyerPhase =
  | "submitted" /** job created on-chain; the provider has not acknowledged it yet */
  | "reading" /** provider saw the job and is validating the requirement */
  | "rejected_intake" /** requirement refused — nothing was priced, nothing to fund */
  | "awaiting_payment" /** provider priced the job; the buyer's payment releases it */
  | "processing" /** funded; investigation opened (operator approval gate may apply) */
  | "review_delivery" /** deliverable submitted — the buyer reviews and releases the escrow */
  | "completed" /** settled on-chain; deliverable final */
  | "rejected" /** deliverable was rejected on-chain */
  | "expired"
  | "failed";

export function buyerPhaseOf(provider: AcpJobRecord | null): BuyerPhase {
  if (!provider) return "submitted";
  switch (provider.status) {
    case "received":
    case "validated":
      return "reading";
    case "rejected_intake":
      return "rejected_intake";
    case "accepted":
      return "awaiting_payment";
    case "funded":
    case "pre_flight":
    case "awaiting_approval":
    case "executing":
      return "processing";
    case "delivered":
      return "review_delivery";
    case "completed":
      return "completed";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
  }
}

export const BUYER_PHASE_LABEL: Record<BuyerPhase, string> = {
  submitted: "Job submitted on-chain",
  reading: "Provider reading the request",
  rejected_intake: "Request refused at intake",
  awaiting_payment: "Waiting for your payment",
  processing: "Processing the investigation",
  review_delivery: "Report delivered — review & release",
  completed: "Completed & settled",
  rejected: "Deliverable rejected",
  expired: "Job expired",
  failed: "Failed",
};

/** What the buyer can DO at this phase — no dead ends. */
export function buyerActionOf(phase: BuyerPhase, job: BuyerJobRecord | null): "fund" | "review" | "none" {
  if (phase === "awaiting_payment") return "fund";
  if (phase === "review_delivery") return "review";
  return "none";
}

/** The merged record the buyer's desk renders. */
export interface BuyerJobView {
  buyer: BuyerJobRecord;
  provider: AcpJobRecord | null;
  phase: BuyerPhase;
  phaseLabel: string;
  action: ReturnType<typeof buyerActionOf>;
}

export async function buildBuyerJobView(buyer: BuyerJobRecord): Promise<BuyerJobView> {
  const provider = await getAcpJob(buyer.key);
  const phase = buyerPhaseOf(provider);
  return { buyer, provider, phase, phaseLabel: BUYER_PHASE_LABEL[phase], action: buyerActionOf(phase, buyer) };
}

/* ------------------------------------------------------------------ */
/* Registration — the one write the buyer's browser performs           */
/* ------------------------------------------------------------------ */

export type RegisterBuyerJobResult =
  | { ok: true; view: BuyerJobView }
  | { ok: false; error: string; status: number };

/**
 * Register (or re-register, idempotently) an on-chain job the buyer created.
 * The clientAddress always comes from the VERIFIED SESSION, never the body —
 * a caller cannot register a job under someone else's wallet.
 */
export async function registerBuyerJob(input: {
  clientAddress: string;
  chainId: number;
  jobId: string;
  offering: string;
  txHash: string | null;
  requirement: Record<string, unknown>;
}): Promise<RegisterBuyerJobResult> {
  const offering = offeringById(input.offering);
  if (!offering) {
    return { ok: false, error: `unknown offering "${input.offering}" — pick one of the published services`, status: 400 };
  }
  if (!/^\d+$/.test(input.jobId) || BigInt(input.jobId) <= 0n) {
    return { ok: false, error: "jobId must be the numeric on-chain job id", status: 400 };
  }
  if (input.txHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    return { ok: false, error: "txHash must be a 32-byte transaction hash", status: 400 };
  }
  const validation = validateRequirement(offering, input.requirement);
  if (!validation.ok) {
    return { ok: false, error: `the request does not satisfy ${offering.id}: ${validation.error}`, status: 400 };
  }

  const key = buyerJobKey(input.chainId, input.jobId);
  const existing = await getBuyerJob(key);
  if (existing && existing.clientAddress !== input.clientAddress.toLowerCase()) {
    return { ok: false, error: "this on-chain job is already registered to a different wallet", status: 403 };
  }
  const job =
    existing ??
    newBuyerJob({
      chainId: input.chainId,
      jobId: input.jobId,
      offering: offering.id,
      clientAddress: input.clientAddress,
      txHash: input.txHash,
      requirement: validation.subject,
      requirementJson: JSON.stringify({ offering: offering.id, inputs: validation.subject }),
    });
  if (input.txHash && !job.txHash) job.txHash = input.txHash;
  await saveBuyerJob(job);
  return { ok: true, view: await buildBuyerJobView(job) };
}

/** A bounded update from the buyer's own browser after SDK actions succeed. */
export async function updateBuyerJob(input: {
  clientAddress: string;
  key: string;
  requirementSent?: true;
  allowanceTxHash?: string | null;
  fundedTxHash?: string | null;
  completedTxHash?: string | null;
  note?: string;
}): Promise<{ ok: true; view: BuyerJobView } | { ok: false; error: string; status: number }> {
  const job = await getBuyerJob(input.key);
  if (!job || job.clientAddress !== input.clientAddress.toLowerCase()) {
    return { ok: false, error: "no such job for this wallet", status: 404 };
  }
  // undefined = "leave this field alone"; null = "explicitly clear it".
  const isTx = (v: unknown): v is string | null | undefined =>
    v === undefined || v === null || (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v));
  if (!isTx(input.allowanceTxHash) || !isTx(input.fundedTxHash) || !isTx(input.completedTxHash)) {
    return { ok: false, error: "a transaction hash must be a full 32-byte hash or null", status: 400 };
  }
  if (input.requirementSent && !job.requirementSentAt) job.requirementSentAt = new Date().toISOString();
  if (input.allowanceTxHash !== undefined) job.allowanceTxHash = input.allowanceTxHash;
  if (input.fundedTxHash !== undefined) job.fundedTxHash = input.fundedTxHash;
  if (input.completedTxHash !== undefined) job.completedTxHash = input.completedTxHash;
  if (input.note) appendNote(job, input.note);
  await saveBuyerJob(job);
  return { ok: true, view: await buildBuyerJobView(job) };
}
