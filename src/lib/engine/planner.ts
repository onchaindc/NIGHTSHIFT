import type { PlanStep, VerificationCriteria } from "./types";

/**
 * Deterministic planner.
 *
 * It builds the self-auditing workflow that tonight's capabilities actually
 * support: (1) purchase the answer from the Telegraph Engine auto route,
 * (2) independently verify that the payment's settlement transaction was mined
 * on the public chain (a free, read-only action fed by the purchase's own
 * receipt), (3) when the goal allows it, cross-check the purchased answer
 * against our own chain telemetry, (4) verify every success criterion —
 * including GOAL-SPECIFIC ones parsed from the goal text — against recorded
 * evidence.
 *
 * Goal-specific criteria are the difference between "the tool call worked" and
 * "the goal is done": a price lookup only completes a goal that asked for that
 * asset; a gas answer only completes a goal that asked about that chain and,
 * where stated, only when the goal's cost threshold is met by real evidence.
 */

export interface TaskPlan {
  steps: PlanStep[];
  criteria: VerificationCriteria;
  /** Non-secret assumptions the planner made, surfaced in the events timeline. */
  assumptions: string[];
}

const ASSET_TOKENS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "LINK", "AVAX"] as const;

const CHAIN_TOKENS = ["base", "ethereum", "arbitrum", "optimism", "polygon"] as const;

const GWEI_KEYS = /gwei/i;
const USD_KEYS = /usd/i;

export function parseGoal(goal: string): {
  isGasGoal: boolean;
  isPriceGoal: boolean;
  expectedChain?: string;
  expectedAsset?: string;
  maxFeeUsdFor21000Gas?: number;
  assumptions: string[];
} {
  const assumptions: string[] = [];
  const isGasGoal = /\bgas\b|\bfee(s)?\b|gas ?price/i.test(goal);
  const isPriceGoal = /\bprice\b|worth|cost/i.test(goal) && !isGasGoal;

  let expectedChain: string | undefined;
  for (const c of CHAIN_TOKENS) {
    if (new RegExp(`\\b${c}\\b`, "i").test(goal)) {
      expectedChain = c === "ethereum" ? "ethereum" : c;
      break;
    }
  }

  let expectedAsset: string | undefined;
  for (const a of ASSET_TOKENS) {
    if (new RegExp(`\\b${a}\\b`, "i").test(goal)) {
      expectedAsset = a;
      break;
    }
  }

  let maxFeeUsdFor21000Gas: number | undefined;
  const threshold = /(?:under|below|less than|<)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(goal);
  if (isGasGoal && threshold) {
    maxFeeUsdFor21000Gas = Number(threshold[1]);
  }

  if (isGasGoal && !expectedChain) {
    expectedChain = "base";
    assumptions.push("no chain was named in the goal, so the gas telemetry checks Base (stated explicitly, not guessed silently)");
  }

  return { isGasGoal, isPriceGoal, expectedChain, expectedAsset, maxFeeUsdFor21000Gas, assumptions };
}

export function planForGoal(goal: string, maxEstimateUsdCents: number): TaskPlan {
  const trimmed = goal.trim();
  const parsed = parseGoal(trimmed);
  const assumptions = [...parsed.assumptions];

  const steps: PlanStep[] = [
    {
      id: "ask-telegraph",
      kind: "telegraph_ask",
      description: `Purchase an answer from the Telegraph network for: "${trimmed}"`,
      maxCostUsdCents: maxEstimateUsdCents,
    },
    {
      id: "check-settlement",
      kind: "verify_settlement",
      description:
        "Read the payment's settlement transaction on the public chain RPC (free, read-only) and require mined inclusion with success status",
    },
  ];

  if (parsed.isGasGoal) {
    steps.push({
      id: "cross-check",
      kind: "cross_check",
      description: `Read live gas telemetry for ${parsed.expectedChain} from our own public RPC and cross-check the purchased answer's figures against it (free, read-only)`,
    });
  }

  steps.push({
    id: "verify-evidence",
    kind: "verify_evidence",
    description: "Check every success criterion against recorded evidence before completing",
  });

  const criteria: VerificationCriteria = {
    primaryVerifiedAgainstNodeSignal: true,
    answerSane: true,
    answerMaxAgeSeconds: 600,
    ownPaymentSettledOnChain: true,
    reconcileLedgerEntries: true,
  };
  if (parsed.isGasGoal) {
    criteria.expectedChain = parsed.expectedChain;
    criteria.crossCheckChainTelemetry = true;
    criteria.maxFeeUsdFor21000Gas = parsed.maxFeeUsdFor21000Gas;
    criteria.agreementToleranceRatio = 0.5;
  }
  if (parsed.isPriceGoal) {
    criteria.expectedAsset = parsed.expectedAsset;
  }

  return { steps, criteria, assumptions };
}

/** Extracts a human-usable gas number (gwei) from an arbitrary answer shape. */
export function extractGasGwei(answer: Record<string, unknown>): number | null {
  let found: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const visit = (node: unknown, keyPath: string[] = []) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, keyPath));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "number" || (typeof value === "string" && value !== "" && !Number.isNaN(Number(value)))) {
        const n = Number(value);
        if (Number.isFinite(n) && GWEI_KEYS.test(key)) {
          // A gwei-labeled value near plausible gas prices wins.
          const distance = Math.abs(Math.log10(Math.max(Math.abs(n), 1e-9)));
          if (found === null || distance < bestDistance) {
            found = n;
            bestDistance = distance;
          }
        }
      }
      visit(value, [...keyPath, key]);
    }
  };
  visit(answer);
  return found;
}

/**
 * Extracts the miner's own USD estimate for a 21000-gas transfer, if the answer
 * reports one. Strictly labeled: a field must read as a cost/fee (optionally a
 * 21000-gas transfer); an unrelated "eth_price_usd" must NOT be mistaken for
 * the transfer cost — no USD-labeled number is assumed to be the fee.
 */
export function extractUsdCost(answer: Record<string, unknown>): number | null {
  const numericByKey = new Map<string, number>();
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "number" || (typeof value === "string" && value !== "" && !Number.isNaN(Number(value)))) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) numericByKey.set(key.toLowerCase(), n);
      }
      visit(value);
    }
  };
  visit(answer);

  for (const [re, label] of [
    [/transfer/i, "transfer"],
    [/21_?000/i, "21k"],
    [/(?:cost|fee)/i, "cost"],
  ] as const) {
    for (const [key, value] of numericByKey) {
      if (re.test(key) && USD_KEYS.test(key)) return value;
    }
    if (label === "cost") break;
  }
  // Last resort: a plain "cost_usd"/"fee_usd"-style key is still REQUIRED to
  // carry the transfer words above; without them there is nothing verifiable.
  return null;
}
