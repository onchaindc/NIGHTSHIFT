import { randomUUID } from "node:crypto";

import { persistence } from "@/lib/storage";
import type { Investigation, InvestigationSummary } from "./types";

/**
 * Investigation persistence. Uses the same swappable backend as tasks and
 * watches (Postgres in production, JSON files locally) through named
 * documents, so a serverless restart never loses an investigation.
 *
 *   assurance-index      — the ordered id list
 *   assurance-inv-<id>   — one whole investigation record
 */

const INDEX = "assurance-index";

function docName(id: string): string {
  return `assurance-inv-${id}`;
}

async function readIndex(): Promise<string[]> {
  const stored = await persistence().readNamed<string[]>(INDEX);
  return Array.isArray(stored) ? stored.filter((v) => typeof v === "string") : [];
}

export async function listInvestigations(): Promise<Investigation[]> {
  const ids = await readIndex();
  // One bulk read — the per-id fan-out through the shared pool is the same
  // hang class the desk list had (see readManyNamed).
  const records = await persistence().readManyNamed<Investigation>(ids.map((id) => docName(id)));
  return records
    .filter((r): r is Investigation => Boolean(r && r.id))
    .map(normalizeInvestigation)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export async function getInvestigation(id: string): Promise<Investigation | null> {
  const record = await persistence().readNamed<Investigation>(docName(id));
  return record && record.id ? normalizeInvestigation(record) : null;
}

/**
 * Legacy or shape-drifted assurance records must never break a read. Files
 * saved before the transaction step and the counterparty step had filled in
 * (a draft held open across a schema change, or a partially-completed create)
 * are real production data: the Overview server render died on exactly such a
 * record with "Cannot read properties of undefined (reading 'legalName')".
 * Every read therefore returns a record whose declared fields actually exist
 * — the same contract the task store has honored since normalizeTaskForDisplay.
 */
function normalizeInvestigation(inv: Investigation): Investigation {
  return {
    ...inv,
    createdAt: inv.createdAt ?? "",
    updatedAt: inv.updatedAt ?? inv.createdAt ?? "",
    status: inv.status ?? "draft",
    dataMode: inv.dataMode ?? "live",
    owner: inv.owner ?? null,
    transaction: inv.transaction ?? {
      payerWallet: "",
      recipientWallet: "",
      amountUsdc: 0,
      tokenMint: "",
      jurisdiction: "",
      approvedBeneficiary: "",
      contractRef: "",
      memo: "",
      documents: [],
    },
    counterparty: inv.counterparty ?? { legalName: "" },
    evidence: Array.isArray(inv.evidence) ? inv.evidence : [],
    findings: Array.isArray(inv.findings) ? inv.findings : [],
    decision: inv.decision ?? null,
    intelligenceRuns: Array.isArray(inv.intelligenceRuns) ? inv.intelligenceRuns : [],
    settlement: inv.settlement ?? null,
    spendLimitUsdCents: typeof inv.spendLimitUsdCents === "number" ? inv.spendLimitUsdCents : 100,
    operator: inv.operator ?? { createdBy: "", tenant: "" },
    limitations: Array.isArray(inv.limitations) ? inv.limitations : [],
    audit: Array.isArray(inv.audit) ? inv.audit : [],
  };
}

export async function saveInvestigation(inv: Investigation): Promise<void> {
  inv.updatedAt = new Date().toISOString();
  await persistence().writeNamed(docName(inv.id), inv);
  const ids = await readIndex();
  if (!ids.includes(inv.id)) {
    ids.push(inv.id);
    await persistence().writeNamed(INDEX, ids);
  }
}

export function newInvestigationId(): string {
  return randomUUID();
}

export function newReference(): string {
  return `NS-TX-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function summarize(inv: Investigation): InvestigationSummary {
  return {
    id: inv.id,
    reference: inv.reference ?? "",
    createdAt: inv.createdAt ?? "",
    dataMode: inv.dataMode ?? "live",
    counterparty: inv.counterparty?.legalName ?? "",
    amountUsdc: typeof inv.transaction?.amountUsdc === "number" ? inv.transaction.amountUsdc : 0,
    status: inv.status ?? "draft",
    decision: inv.decision?.outcome ?? null,
    evidenceCount: (inv.evidence ?? []).length,
    findingCount: (inv.findings ?? []).length,
  };
}

/** Append an audit entry without letting a caller overwrite the trail. */
export function audit(inv: Investigation, actor: string, action: string, detail: string): void {
  // Records written before the audit trail existed still accept entries.
  if (!Array.isArray(inv.audit)) inv.audit = [];
  inv.audit.push({ ts: new Date().toISOString(), actor, action, detail });
  if (inv.audit.length > 200) inv.audit = inv.audit.slice(-200);
}
