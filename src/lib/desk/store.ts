import { randomUUID } from "node:crypto";

import { persistence } from "@/lib/storage";
import type { AuditEntry } from "@/lib/assurance/types";
import type { DeskInvestigation, DeskInvestigationSummary, DeskInvestigationType } from "./types";
import { deskEvidenceCounts, DESK_TYPE_LABEL } from "./types";
import { deskSubjectLine } from "./create";

/**
 * Desk investigation persistence. Same swappable backend as tasks, watches
 * and settlement files (Postgres in production, JSON files locally) through
 * named documents:
 *
 *   desk-index      — the ordered id list
 *   desk-inv-<id>   — one whole desk investigation record
 */

const INDEX = "desk-index";

function docName(id: string): string {
  return `desk-inv-${id}`;
}

async function readIndex(): Promise<string[]> {
  const stored = await persistence().readNamed<string[]>(INDEX);
  return Array.isArray(stored) ? stored.filter((v) => typeof v === "string") : [];
}

export async function listDeskInvestigations(): Promise<DeskInvestigation[]> {
  const ids = await readIndex();
  const records = await Promise.all(ids.map((id) => persistence().readNamed<DeskInvestigation>(docName(id))));
  return records
    .filter((r): r is DeskInvestigation => Boolean(r && r.id && r.kind === "desk"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listDeskInvestigationsByType(type: DeskInvestigationType): Promise<DeskInvestigation[]> {
  return (await listDeskInvestigations()).filter((inv) => inv.type === type);
}

export async function getDeskInvestigation(id: string): Promise<DeskInvestigation | null> {
  const record = await persistence().readNamed<DeskInvestigation>(docName(id));
  return record && record.id && record.kind === "desk" ? record : null;
}

export async function saveDeskInvestigation(inv: DeskInvestigation): Promise<void> {
  inv.updatedAt = new Date().toISOString();
  await persistence().writeNamed(docName(inv.id), inv);
  const ids = await readIndex();
  if (!ids.includes(inv.id)) {
    ids.push(inv.id);
    await persistence().writeNamed(INDEX, ids);
  }
}

export function newDeskInvestigationId(): string {
  return randomUUID();
}

const REFERENCE_PREFIX: Record<DeskInvestigationType, string> = {
  counterparty_due_diligence: "NS-CP",
  asset_intelligence: "NS-AS",
  trade_supplier_intelligence: "NS-TR",
};

export function newDeskReference(type: DeskInvestigationType): string {
  return `${REFERENCE_PREFIX[type]}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function summarizeDesk(inv: DeskInvestigation): DeskInvestigationSummary {
  const counts = deskEvidenceCounts(inv);
  return {
    id: inv.id,
    reference: inv.reference,
    type: inv.type,
    createdAt: inv.createdAt,
    status: inv.status,
    subject: deskSubjectLine(inv),
    evidenceCount: inv.evidence.length,
    verifiedCount: counts.verified,
    missingCount: counts.missing,
    findingCount: inv.findings.length || inv.report?.findings.length || 0,
    runs: inv.runs.length,
    confidence: inv.report?.confidence ?? null,
  };
}

/** Append an audit entry without letting a caller overwrite the trail. */
export function auditDesk(inv: DeskInvestigation, actor: string, action: string, detail: string): void {
  const entry: AuditEntry = { ts: new Date().toISOString(), actor, action, detail };
  inv.audit.push(entry);
  if (inv.audit.length > 200) inv.audit = inv.audit.slice(-200);
}

export function deskTypeLabel(type: DeskInvestigationType): string {
  return DESK_TYPE_LABEL[type];
}
