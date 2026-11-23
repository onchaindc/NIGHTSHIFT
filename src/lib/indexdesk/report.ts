/**
 * Index Reconstitution Desk — the proposal deliverable.
 *
 * Honesty invariants (mirroring the Mind investigation report):
 *  - Every verified figure traces to a recorded signal hash and receipt; a
 *    figure the network did not return is labelled declared (user input) or
 *    missing, never guessed.
 *  - The proposal states its methodology rules verbatim and lists every
 *    excluded and provisional asset with its reason.
 *  - The missing-dimension ledger is part of the deliverable: what the
 *    network cannot answer (float, volumes) is a stated limitation of the
 *    proposal, not a silent gap.
 */

import type { IndexDefinition } from "./intel";
import type { IndexMethodologyOutcome, WeightedAsset, MissingDimensionEntry } from "./method";

export interface IndexDeskReport {
  /** The index definition exactly as the user declared it (verbatim provenance). */
  definition: IndexDefinition;
  mode: "free" | "intel";
  /** What the unpaid baseline established per asset (probe verdicts + pricing). */
  baseline: {
    /** Per asset, per dimension: "challenge" (routable at $X), "rejected", "unavailable", "not_askable". */
    probes: Array<{
      symbol: string;
      dimension: string;
      status: "challenge" | "rejected" | "unavailable" | "not_askable";
      priceUsdCents?: number;
      miner: string;
      detail: string;
    }>;
    /** The total the FULL paid plan would cost, from live probe prices. */
    plannedCostUsdCents: number;
  };
  /** What the paid asks actually established (intel mode only). */
  intelUsed: boolean;
  methodology: IndexMethodologyOutcome;
  /** Per-asset deliverable rows (same order as the definition). */
  assets: WeightedAsset[];
  missingDimensions: MissingDimensionEntry[];
  reasoning: string[];
  confidence: "signal-verified" | "partially-verified" | "unverified";
  generatedAt: number;
}

export function buildIndexReasoning(args: {
  definition: IndexDefinition;
  mode: "free" | "intel";
  baseline: IndexDeskReport["baseline"];
  methodology: IndexMethodologyOutcome;
  approvedByHuman?: boolean;
  spendUsdCents: number;
  verifiedAsks: number;
  paidAsks: number;
}): string[] {
  const r: string[] = [];
  const { definition, baseline, methodology } = args;
  r.push(
    `Universe accepted as declared: ${definition.assets.length} asset(s) — ${definition.assets
      .map((a) => a.symbol)
      .join(", ")}. The desk investigates this universe; it never invents constituents.`,
  );
  r.push(
    `Methodology: ${definition.methodology.scheme} weighting${
      definition.methodology.scheme === "custom" ? " (declared percent weights, normalized)" : ""
    }${definition.methodology.notes ? `; operator notes recorded verbatim: "${definition.methodology.notes}"` : ""}.`,
  );
  const challengeProbes = baseline.probes.filter((p) => p.status === "challenge");
  r.push(
    `Unpaid pre-flight: ${challengeProbes.length}/${baseline.probes.length} dimension asks are routable, each challenging at the node's live price (${
      baseline.plannedCostUsdCents / 100 >= 0 ? `$${(baseline.plannedCostUsdCents / 100).toFixed(2)}` : "n/a"
    } for the full plan). Nothing was signed at this stage.`,
  );
  if (args.mode === "intel") {
    if (args.approvedByHuman) {
      r.push("Human approval was given for this exact plan (engine approval gate) before anything was signed.");
    }
    r.push(
      `Paid asks: ${args.verifiedAsks}/${args.paidAsks} verified against the signal registry (keccak re-derivation over the recorded payload), spending $${(
        args.spendUsdCents / 100
      ).toFixed(2)} of the task budget. Every ask ran once; nothing was retried after signing.`,
    );
  } else {
    r.push("Free mode: no purchase path ran. Weighting inputs are declared-only and labelled; every network-verifiable dimension is listed in the missing-dimension ledger.");
  }
  const p = methodology.proposal;
  if (p) {
    r.push(
      `Proposal: ${p.weights.length} constituent(s) under the ${p.scheme} rule — ${p.weights
        .map((w) => `${w.symbol} ${w.weightPct.toFixed(2)}%`)
        .join(", ")}. Concentration: HHI ${p.concentration.hhi}, effective N ${p.concentration.effectiveN}, top-1 ${p.concentration.top1Pct.toFixed(2)}%, top-3 ${p.concentration.top3Pct.toFixed(2)}%.`,
    );
    const provisional = methodology.weightedAssets.filter((a) => a.status === "provisional");
    if (provisional.length > 0) {
      r.push(
        `Provisional constituents (issuer not verified, kept and flagged): ${provisional.map((a) => a.symbol).join(", ")}.`,
      );
    }
  } else {
    r.push(`No weighting proposed: ${methodology.proposalBlocker}`);
  }
  const excluded = methodology.weightedAssets.filter((a) => a.status === "excluded");
  if (excluded.length > 0) {
    r.push(
      `Excluded by the stated rules: ${excluded.map((a) => `${a.symbol} (${a.exclusionReason ?? "rule exclusion"})`).join("; ")}.`,
    );
  }
  if (methodology.missingDimensions.length > 0) {
    r.push(
      `Missing-dimension ledger: ${methodology.missingDimensions.length} entr${methodology.missingDimensions.length === 1 ? "y" : "ies"} — including the two the network cannot answer at all (circulating float, trading volumes). Missing data is reported, never fabricated.`,
    );
  }
  return r;
}

export function indexDeskConfidence(args: {
  mode: "free" | "intel";
  verifiedAsks: number;
  paidAsks: number;
}): IndexDeskReport["confidence"] {
  if (args.mode === "free") return "unverified";
  if (args.paidAsks === 0) return "unverified";
  if (args.verifiedAsks === args.paidAsks) return "signal-verified";
  return "partially-verified";
}
