/**
 * Bitcoin Mining Intelligence — product inputs and planning.
 *
 * The Mind is a fixed, three-dimension investigation over the verified
 * Telegraph mining capabilities. The product layer only supplies the
 * objective (block height, ERCOT zone, settlement interval); the existing
 * capability planner builds the engine steps and approval gate.
 */

import {
  CapabilityPlanError,
  planCapabilityRun,
  type CapabilityRunMode,
  type CapabilityRunPlan,
} from "@/lib/minds/capability-plan";

export const BITCOIN_MINING_SLUG = "bitcoin-mining-intelligence";

export interface BitcoinMiningObjective {
  blockHeight: number;
  zone: string;
  intervalStart: string;
}

export class BitcoinInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitcoinInputError";
  }
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateBitcoinObjective(input: {
  blockHeight?: unknown;
  zone?: unknown;
  intervalStart?: unknown;
}): BitcoinMiningObjective {
  const rawHeight =
    typeof input.blockHeight === "string" && input.blockHeight.trim() === ""
      ? undefined
      : input.blockHeight;
  const blockHeight =
    typeof rawHeight === "number"
      ? rawHeight
      : typeof rawHeight === "string" && /^\d+$/.test(rawHeight.trim())
        ? Number(rawHeight.trim())
        : NaN;
  if (!Number.isInteger(blockHeight) || blockHeight < 1 || blockHeight > 10_000_000) {
    throw new BitcoinInputError("blockHeight must be a positive Bitcoin block height");
  }

  const zone = typeof input.zone === "string" ? input.zone.trim().toUpperCase() : "";
  if (!/^[A-Z0-9_]{2,24}$/.test(zone)) {
    throw new BitcoinInputError("zone must be an ERCOT hub or load zone such as HB_WEST");
  }

  const intervalStart = typeof input.intervalStart === "string" ? input.intervalStart.trim() : "";
  if (!RFC3339.test(intervalStart) || !Number.isFinite(Date.parse(intervalStart))) {
    throw new BitcoinInputError(
      "intervalStart must be an RFC 3339 timestamp with a timezone, e.g. 2026-11-23T00:00:00-06:00",
    );
  }
  const intervalMs = Date.parse(intervalStart);
  if (intervalMs > Date.now() + 60 * 60 * 1000) {
    throw new BitcoinInputError("intervalStart cannot be more than one hour in the future");
  }

  return { blockHeight, zone, intervalStart };
}

/** The canonical per-dimension inputs the capability runner expects. */
export function buildBitcoinInputs(objective: BitcoinMiningObjective): Record<string, Record<string, unknown>> {
  return {
    hashprice_network: { block_height: objective.blockHeight },
    btc_price: { symbol: "BTC" },
    energy_price: { node_or_zone: objective.zone, interval_start: objective.intervalStart },
  };
}

export function planBitcoinMining(
  objective: BitcoinMiningObjective,
  mode: CapabilityRunMode,
): CapabilityRunPlan {
  try {
    return planCapabilityRun(BITCOIN_MINING_SLUG, buildBitcoinInputs(objective), mode);
  } catch (err) {
    if (err instanceof CapabilityPlanError) throw new BitcoinInputError(err.message);
    throw err;
  }
}

/**
 * The tip height is not a paid data claim; it only keeps the default objective
 * current. A failure is surfaced so the caller can ask for an explicit height.
 */
export async function fetchLatestBlockHeight(fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl("https://mempool.space/api/blocks/tip/height", {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "text/plain" },
  });
  if (!res.ok) throw new BitcoinInputError(`latest block lookup returned HTTP ${res.status}`);
  const text = (await res.text()).trim();
  const height = Number(text);
  if (!Number.isInteger(height) || height < 1) {
    throw new BitcoinInputError("latest block lookup returned an unusable height");
  }
  return height;
}

/** Read the objective back from a capability config for the report. */
export function objectiveFromInputs(inputs: Record<string, Record<string, unknown>>): BitcoinMiningObjective | null {
  const height = inputs.hashprice_network?.block_height;
  const zone = inputs.energy_price?.node_or_zone;
  const intervalStart = inputs.energy_price?.interval_start;
  if (typeof height !== "number" || typeof zone !== "string" || typeof intervalStart !== "string") return null;
  return { blockHeight: height, zone, intervalStart };
}
