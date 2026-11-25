/**
 * Generic planner for a Mind capability run.
 *
 * A run is built only from the capability matrix: unsupported dimensions are
 * never planned. Inputs are supplied per dimension and validated against the
 * canonical Telegraph request schema before a task exists. The paid variant
 * always requires human approval; the free variant never plans a purchase.
 */

import type { PlanStep, VerificationCriteria } from "@/lib/engine/types";
import { CAPABILITIES, DEFAULT_ASK_PRICE_USD_CENTS, type MindCapabilities } from "./capabilities";
import { mindBySlug } from "./registry";
import { buildCapabilitySpec } from "./capability-runner";

export type CapabilityRunMode = "free" | "intel";

export interface CapabilityRunConfig {
  slug: string;
  mode: CapabilityRunMode;
  inputs: Record<string, Record<string, unknown>>;
}

export interface CapabilityRunPlan {
  steps: PlanStep[];
  criteria: VerificationCriteria;
  config: CapabilityRunConfig;
  /** Supported dimensions with their input labels, for a pre-flight UI. */
  requiredInputs: Array<{ dimension: string; label: string; params: string[] }>;
  budgetCeilingUsdCents: number;
}

export class CapabilityPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityPlanError";
  }
}

export function planCapabilityRun(
  slug: string,
  inputs: Record<string, Record<string, unknown>>,
  mode: CapabilityRunMode,
  spendLimitUsdCents?: number,
): CapabilityRunPlan {
  const mind = mindBySlug(slug);
  if (!mind) throw new CapabilityPlanError(`unknown Mind: ${slug}`);
  const caps: MindCapabilities | undefined = CAPABILITIES[slug];
  if (!caps) throw new CapabilityPlanError(`no capability matrix for ${mind.name}`);
  if (mode !== "free" && mode !== "intel") throw new CapabilityPlanError('mode must be "free" or "intel"');

  const supported = caps.dimensions.filter((d) => d.status !== "gap");
  if (supported.length === 0) throw new CapabilityPlanError(`${mind.name} has no verified dimensions to run`);
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new CapabilityPlanError("inputs must be an object keyed by dimension id");
  }

  const cleanInputs: Record<string, Record<string, unknown>> = {};
  const requiredInputs: CapabilityRunPlan["requiredInputs"] = [];
  for (const dim of supported) {
    const raw = inputs[dim.id];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new CapabilityPlanError(
        `Missing inputs for "${dim.label}". Supply an object with: ${Object.keys(dim.params ?? {}).join(", ")}.`,
      );
    }
    try {
      buildCapabilitySpec(dim, raw as Record<string, unknown>);
    } catch (err) {
      throw new CapabilityPlanError(
        `Inputs for "${dim.label}" are incomplete: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    cleanInputs[dim.id] = raw as Record<string, unknown>;
    requiredInputs.push({ dimension: dim.id, label: dim.label, params: Object.keys(dim.params ?? {}) });
  }

  const requestedLimit =
    typeof spendLimitUsdCents === "number" && spendLimitUsdCents > 0
      ? Math.round(spendLimitUsdCents)
      : undefined;
  if (requestedLimit !== undefined && requestedLimit < 1) {
    throw new CapabilityPlanError("spendLimitUsdCents must be at least 1 cent");
  }

  const ceiling = supported.reduce(
    (sum, d) => sum + (d.priceUsdCents ?? DEFAULT_ASK_PRICE_USD_CENTS),
    0,
  );
  const config: CapabilityRunConfig = { slug, mode, inputs: cleanInputs };
  const target = JSON.stringify(config);
  const paid = mode === "intel";

  const criteria: VerificationCriteria = {
    primaryVerifiedAgainstNodeSignal: paid,
    answerSane: paid,
    answerMaxAgeSeconds: 0,
    ownPaymentSettledOnChain: false,
    reconcileLedgerEntries: paid,
    primarySource: paid ? "telegraph" : "free",
    goalIntent: "information",
  };

  const steps: PlanStep[] = [
    {
      id: "capability-baseline",
      kind: "capability_baseline",
      description: `Unpaid pre-flight for ${mind.name}: probe ${supported.length} supported dimension(s) with their canonical schema and record the live price for each; gaps stay unsupported and are never asked`,
      target,
    },
  ];
  if (paid) {
    steps.push({
      id: "capability-ask",
      kind: "capability_ask",
      description: `PAID capability run for ${mind.name}: one attempt per routable dimension (ceiling ${(ceiling / 100).toFixed(2)} USD), each re-checked against its approved live offer and skipped if the remaining budget cannot cover it`,
      target,
      maxCostUsdCents: requestedLimit ?? ceiling,
    });
  }
  steps.push({
    id: "capability-report",
    kind: "capability_report",
    description: `Structured ${mind.name} report: per-dimension verified/recorded/missing status, the gap ledger, receipts and spend reconciliation`,
    target,
  });

  return {
    steps,
    criteria,
    config,
    requiredInputs,
    budgetCeilingUsdCents: ceiling,
  };
}

/** HTTP-facing description of the inputs a run needs, with safe samples. */
export function capabilityRunInputs(slug: string): Array<{
  dimension: string;
  label: string;
  params: Array<{ name: string; required: boolean; description: string; sample?: string | number }>;
}> {
  const caps = CAPABILITIES[slug];
  if (!caps) return [];
  return caps.dimensions
    .filter((d) => d.status !== "gap")
    .map((d) => ({
      dimension: d.id,
      label: d.label,
      params: Object.entries(d.params ?? {}).map(([name, spec]) => ({
        name,
        required: spec.required,
        description: spec.description,
        ...(spec.sample !== undefined ? { sample: spec.sample } : {}),
      })),
    }));
}
