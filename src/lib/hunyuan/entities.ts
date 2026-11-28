/**
 * Entity identity for the Hunyuan missions.
 *
 * Both missions operate on TRACKED ENTITIES — the counterparties and subjects
 * the existing NIGHTSHIFT records already investigate. The entity key is a
 * stable, human-derived string (never a model output) so evidence gathered at
 * different times by different workflows maps onto the same tracked entity.
 */

import type { Investigation } from "@/lib/assurance/types";
import { deskSubjectLine } from "@/lib/desk/create";
import type { DeskInvestigation } from "@/lib/desk/types";

export type TrackedScope = "assurance" | "desk";

/** Stable key for a settlement-assurance counterparty; null when unnamed. */
export function entityKeyForAssurance(inv: Investigation): string | null {
  const name = inv.counterparty?.legalName?.trim();
  if (!name) return null;
  const jurisdiction = inv.transaction?.jurisdiction?.trim().toLowerCase() ?? "";
  return `registry:${jurisdiction}:${name.toLowerCase()}`;
}

/** Stable key for a desk subject; null when the form was never answered. */
export function entityKeyForDesk(inv: DeskInvestigation): string | null {
  const subject = deskSubjectLine(inv)?.trim();
  if (!subject || subject.startsWith("Unnamed")) return null;
  return `desk:${inv.type}:${subject.toLowerCase()}`;
}

export function entityLabel(inv: Investigation | DeskInvestigation, scope: TrackedScope): string {
  if (scope === "assurance") return (inv as Investigation).counterparty?.legalName?.trim() || "Unnamed counterparty";
  return deskSubjectLine(inv as DeskInvestigation) || "Unnamed desk subject";
}
