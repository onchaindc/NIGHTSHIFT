import type { PlanStep, VerificationCriteria } from "@/lib/engine/types";
import type { IndexDefinition } from "./intel";

/**
 * Index Reconstitution Desk planner — deterministic, like the Mind planner.
 *
 *   index_baseline — FREE: the unpaid per-asset, per-dimension pre-flight
 *                    (validation + live pricing) and the declared-input dossier.
 *   index_data_ask — PAID: one drift-checked, budget-guarded ask per asset per
 *                    dimension whose probe challenged. Only runs after the
 *                    human approves the plan (engine gate).
 *   index_report   — FREE: the deterministic proposal, evidence and
 *                    missing-dimension ledger (the completion step).
 */

export type IndexDeskMode = "free" | "intel";

export interface IndexDeskPlan {
  steps: PlanStep[];
  criteria: VerificationCriteria;
  blocker?: string;
}

/** Upper bound on asks per asset (all six dimensions), for the step's cost ceiling. */
export const MAX_ASKS_PER_ASSET = 6;
/** Every verified intent on this desk challenges at 10000 uUSDC = 1¢ (live 2026-11-23). */
export const INDEX_ASK_PRICE_USD_CENTS = 1;

export function planIndexDesk(definition: IndexDefinition, mode: IndexDeskMode): IndexDeskPlan {
  const target = JSON.stringify(definition);
  const plannedCostCeiling = definition.assets.length * MAX_ASKS_PER_ASSET * INDEX_ASK_PRICE_USD_CENTS;

  const criteria: VerificationCriteria = {
    primaryVerifiedAgainstNodeSignal: mode === "intel",
    answerSane: mode === "intel",
    answerMaxAgeSeconds: 0,
    ownPaymentSettledOnChain: false,
    reconcileLedgerEntries: mode === "intel",
    primarySource: mode === "intel" ? "telegraph" : "free",
    goalIntent: "information",
  };

  const steps: PlanStep[] = [
    {
      id: "index-baseline",
      kind: "index_baseline",
      description: `Unpaid pre-flight for ${definition.name}: probe every askable dimension of every declared asset against the network and assemble the declared-input dossier`,
      target,
    },
  ];
  if (mode === "intel") {
    steps.push({
      id: "index-data-ask",
      kind: "index_data_ask",
      description: `PAID data asks for ${definition.name}: one attempt per asset per dimension the probe priced (≤ $${(
        plannedCostCeiling / 100
      ).toFixed(2)}), each drift-checked against its approved offer and budget-guarded; a bare refusal after signing is terminal, never retried`,
      target,
      maxCostUsdCents: plannedCostCeiling,
    });
  }
  steps.push({
    id: "index-report",
    kind: "index_report",
    description: `Deterministic constituent and weighting proposal for ${definition.name} under the ${definition.methodology.scheme} rule, with per-asset evidence and the missing-dimension ledger`,
    target,
  });

  return { steps, criteria };
}
