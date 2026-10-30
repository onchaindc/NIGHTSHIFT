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
  /** Set for execution goals: the engine must NOT build a spending plan. It
   * stops with this plain-language explanation instead of buying advice that
   * might be mistaken for a completed action. */
  executionBlocker?: string;
}

/**
 * Goal intent, derived from the goal text BEFORE execution and fixed at task
 * creation. Three kinds exist:
 *  - information: the deliverable IS the researched answer (price, gas, status).
 *  - preparation: the deliverable is guidance/plan material for an action the
 *    user (or a later integration step) performs; nothing is executed here.
 *  - execution: the goal asks for an external consequence (swap, deployment,
 *    transfer...). This system has no wallet, exchange or deployment
 *    integration, so it can never honestly claim such a goal completed.
 */
export type GoalIntent = "information" | "preparation" | "execution";

/** Explicit execution orders. Bare verbs; framing words rule goals out first. */
const EXECUTION_VERB =
  /\b(?:swap|buy|sell|send this transaction|execute this transaction|sign this transaction|submit this transaction|deploy|mint|burn|bridge|stake|unstake|withdraw|deposit|pay to|move (?:the )?funds|transfer (?:the )?funds|place (?:a|this) (?:order|trade))\b/i;

/** Guidance/deliverable framing: the user asks for advice, not for action. */
const PREPARATION_FRAME =
  /\b(?:how (?:do|can|should|would|about)|what (?:do|should)|should i|advice|recommend|suggest|guide me|walk me through|steps? (?:for|to)|plan for|prepare|draft|outline|write me|strategy)\b/i;

/** Informational framing: researched facts are the deliverable. */
const INFORMATION_FRAME =
  /\b(?:price|worth|cost|gas|fee|fees|how much|how many|what is|what's|when|where|who|why|monitor|watch|report|research|analy[sz]e|analys|summar|overview|status|history|compare|current|latest|today|tell me|list|show|did|does|is there)\b/i;

export function classifyGoal(goal: string): { intent: GoalIntent; evidence: string } {
  const g = goal.trim();
  if (PREPARATION_FRAME.test(g)) {
    return { intent: "preparation", evidence: 'guidance framing ("how to"/"should I"/"prepare"), so the deliverable is advice or preparation material, not an execution' };
  }
  const info = INFORMATION_FRAME.exec(g);
  if (info) {
    return { intent: "information", evidence: `informational framing (${info[0]})` };
  }
  const exec = EXECUTION_VERB.exec(g);
  if (exec) {
    return { intent: "execution", evidence: `external action "${exec[0]}" with no informational framing` };
  }
  return { intent: "information", evidence: "no external action detected" };
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

export type PlanMode = "auto" | "free" | "paid";

/**
 * Execution modes the caller can choose explicitly (web UI, API):
 *  - "free": ONLY free steps are allowed. If the question has no free
 *    capability, the plan says so honestly and nothing is launched.
 *  - "paid": the Telegraph purchase plan, clearly labeled, with its ceiling.
 *  - "auto": no explicit choice was made, the planner decides (a paid plan is
 *    built when the question has no free capability, and every paid step's
 *    description carries the ceiling and the Telegraph label).
 */

/* ------------------------------------------------------------------ */
/* Free sources                                                         */
/* ------------------------------------------------------------------ */

/** CoinGecko (public, key-less) symbols for the assets the parser knows. */
export const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  DOGE: "dogecoin",
  LINK: "chainlink",
  AVAX: "avalanche-2",
};

/** The native token whose price converts gas (gwei) into USD per chain. */
export const CHAIN_NATIVE: Record<string, string> = {
  base: "ETH",
  ethereum: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  polygon: "MATIC",
};

/** CoinGecko id for a native token symbol. Null when unknown (no guessing). */
export function nativeCoinId(symbol: string): string | null {
  if (symbol === "ETH") return "ethereum";
  if (symbol === "MATIC") return "matic-network";
  return null;
}

/**
 * Whether this question has a genuine FREE capability today: gas telemetry
 * (read from a public chain RPC) or a single-asset USD price (public APIs).
 * Anything else has no free path (inventing one would be fabrication).
 */
export function isFreeCapableGoal(goal: string): boolean {
  const parsed = parseGoal(goal);
  return parsed.isGasGoal || (parsed.isPriceGoal && Boolean(parsed.expectedAsset));
}

function freeFailedCriteria(intent: GoalIntent): VerificationCriteria {
  return {
    primaryVerifiedAgainstNodeSignal: false,
    answerSane: false,
    answerMaxAgeSeconds: 0,
    ownPaymentSettledOnChain: false,
    reconcileLedgerEntries: false,
    goalIntent: intent,
    primarySource: "free",
  };
}

/** The genuinely free plan for a question with a matching free capability. */
function freePlanForGoal(trimmed: string, parsed: ReturnType<typeof parseGoal>, intent: GoalIntent): TaskPlan {
  const assumptions = [
    "this operation runs on free public sources and read-only chain RPC only; it spends $0.00 and never signs a payment",
  ];
  if (parsed.isGasGoal) {
    const chain = parsed.expectedChain ?? "base";
    const steps: PlanStep[] = [
      {
        id: "free-gas-read",
        kind: "free_chain_read",
        description: `Read the live gas price for ${chain} directly from a public, read-only chain RPC (free)`,
      },
    ];
    const native = CHAIN_NATIVE[chain] ?? "ETH";
    const nativeId = nativeCoinId(native);
    if (parsed.maxFeeUsdFor21000Gas != null && nativeId) {
      steps.push({
        id: "free-native-price",
        kind: "free_public_lookup",
        target: nativeId,
        description: `Read the current ${native} USD price from a public key-less price source (free) so the 21000-gas transfer fee can be computed in USD`,
      });
    }
    steps.push({
      id: "verify-evidence",
      kind: "verify_evidence",
      description: "Check every success criterion against the recorded free-read evidence before completing",
    });
    const criteria: VerificationCriteria = {
      ...freeFailedCriteria(intent),
      goalIntent: intent,
      primarySource: "free",
      freeChainRead: chain,
      expectedChain: chain,
      answerSane: true,
    };
    if (parsed.maxFeeUsdFor21000Gas != null) {
      criteria.maxFeeUsdFor21000Gas = parsed.maxFeeUsdFor21000Gas;
      if (nativeId) criteria.freeAssetLookup = native;
    }
    return { steps, criteria, assumptions };
  }

  // Single-asset USD price goal.
  const asset = parsed.expectedAsset!;
  const coinId = COINGECKO_IDS[asset];
  const criteria: VerificationCriteria = {
    ...freeFailedCriteria(intent),
    goalIntent: intent,
    primarySource: "free",
    freeAssetLookup: asset,
    expectedAsset: asset,
    answerSane: true,
  };
  return {
    steps: [
      {
        id: "free-price-lookup",
        kind: "free_public_lookup",
        target: coinId,
        description: `Read the current ${asset} USD price from a public, key-less price source (free)`,
      },
      { id: "verify-evidence", kind: "verify_evidence", description: "Check the recorded free-read evidence before completing" },
    ],
    criteria,
    assumptions,
  };
}

export function planForGoal(goal: string, maxEstimateUsdCents: number, mode: PlanMode = "auto"): TaskPlan {
  const trimmed = goal.trim();
  const intent = classifyGoal(trimmed);

  // EXECUTION goals never reach the purchase path, in every mode. Every
  // external consequence (a swap, deployment, transfer...) would need
  // third-party evidence of execution: a mined receipt for the action itself
  // plus an independent outcome check. A purchased inference answer, its
  // payment receipt or a self-reported score is not sufficient, so instead of
  // paying for advice an execution goal stops here.
  if (intent.intent === "execution") {
    const blockExplanation =
      `Execution goals are not supported yet: NIGHTSHIFT has no wallet, exchange or deployment integration, so the requested action (${intent.evidence}) cannot be carried out, verified or paid for safely. Nothing was purchased. Submit the same intent as research or transaction preparation (for example "how do I ..." or "what would ... cost") if that is useful.`;
    const criteria: VerificationCriteria = {
      primaryVerifiedAgainstNodeSignal: false,
      answerSane: false,
      answerMaxAgeSeconds: 0,
      ownPaymentSettledOnChain: false,
      reconcileLedgerEntries: false,
      goalIntent: "execution",
      requiresExecutionEvidence: true,
    };
    return {
      steps: [],
      criteria,
      assumptions: [
        "the goal reads as an execution order, so finishing it would require external-action verification (transaction receipt plus an independent outcome check) that no current integration can produce",
      ],
      executionBlocker: blockExplanation,
    };
  }

  // FREE mode (explicit user choice): if this question has no free
  // capability, stop honestly instead of silently starting a paid operation.
  if (mode === "free" && !isFreeCapableGoal(trimmed)) {
    const blocker =
      `No free capability for this question: NIGHTSHIFT can answer gas questions (public chain RPC) and single-asset USD prices (public price APIs) for free, but this goal needs paid intelligence. Re-run with the paid mode and a spending ceiling, or ask a free-answerable question.`;
    return {
      steps: [],
      criteria: freeFailedCriteria(intent.intent),
      assumptions: [],
      executionBlocker: blocker,
    };
  }
  // A deliberate free request (or an unconstrained auto choice) uses the free
  // plan whenever one covers the goal.
  if (mode === "free" || (mode === "auto" && isFreeCapableGoal(trimmed))) {
    return freePlanForGoal(trimmed, parseGoal(trimmed), intent.intent);
  }

  const parsed = parseGoal(trimmed);
  const assumptions = [...parsed.assumptions];
  if (intent.intent === "preparation") {
    assumptions.push(
      `the goal is a request for preparation material or guidance (${intent.evidence}), so the deliverable is advice rather than a carried-out action`,
    );
  }

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
    goalIntent: intent.intent,
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
