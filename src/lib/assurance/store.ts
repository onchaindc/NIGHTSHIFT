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
  const records = await Promise.all(ids.map((id) => persistence().readNamed<Investigation>(docName(id))));
  return records.filter((r): r is Investigation => Boolean(r && r.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getInvestigation(id: string): Promise<Investigation | null> {
  const record = await persistence().readNamed<Investigation>(docName(id));
  return record && record.id ? record : null;
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
    reference: inv.reference,
    createdAt: inv.createdAt,
    dataMode: inv.dataMode,
    counterparty: inv.counterparty.legalName,
    amountUsdc: inv.transaction.amountUsdc,
    status: inv.status,
    decision: inv.decision?.outcome ?? null,
    evidenceCount: inv.evidence.length,
    findingCount: inv.findings.length,
  };
}

/** Append an audit entry without letting a caller overwrite the trail. */
export function audit(inv: Investigation, actor: string, action: string, detail: string): void {
  inv.audit.push({ ts: new Date().toISOString(), actor, action, detail });
  if (inv.audit.length > 200) inv.audit = inv.audit.slice(-200);
}
