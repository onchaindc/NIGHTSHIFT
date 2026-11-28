/**
 * applyAssessment — one deterministic refresh of a file's recorded decision.
 *
 * The decision is a snapshot of the evidence ledger at assessment time.
 * Before this existed, a later Solana inspection or intelligence sync left
 * the recorded decision stale: the file kept listing MISSING checks that the
 * fresh evidence had already satisfied — the exact "still showing missing"
 * dead end observed live (provenance counted 3 Solana reads while the
 * decision panel, hours older, still said none were recorded). Every
 * evidence-changing endpoint now refreshes the decision through this helper;
 * the explicit /assess route adds Minds delivery on top of the same core.
 */
import { assessInvestigation, type AssessmentResult } from "@/lib/assurance/assess";
import { syncIntelligence } from "@/lib/assurance/run";
import { audit } from "@/lib/assurance/store";
import type { Investigation } from "@/lib/assurance/types";

export async function applyAssessment(
  inv: Investigation,
  actor: string,
): Promise<{ assessment: AssessmentResult; added: number }> {
  const synced = await syncIntelligence(inv);
  const assessment = assessInvestigation(inv);
  inv.findings = assessment.findings;
  inv.decision = assessment.decision;
  inv.limitations = [...new Set([...inv.limitations, ...assessment.limitations])];
  inv.status = "assessed";
  audit(inv, actor, "intelligence_synced", `${synced.added} evidence record(s) absorbed before assessment.`);
  audit(
    inv,
    actor,
    "assessment_recorded",
    `${assessment.decision.outcome}: ${assessment.findings.length} finding(s), ${assessment.decision.criteria.filter((c) => c.status === "missing").length} missing check(s).`,
  );
  return { assessment, added: synced.added };
}
