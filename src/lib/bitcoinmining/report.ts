/**
 * Bitcoin Mining Intelligence — deterministic report from committed answers.
 *
 * Everything below is computed from paid, hash-committed dimensions. There is
 * one explicit derivation: the hashprice provider returns sats but leaves USD
 * unavailable (it fetches no BTC/USD rate). We multiply the committed sats
 * value by the separately committed BTC price and say so. Provider USD is used
 * when present; it is never invented.
 *
 * The Mind does not pretend to know pool concentration or fleet uptime. Those
 * remain named gaps with a concrete route to close them.
 */

import { CAPABILITIES, type CapabilityDimension } from "@/lib/minds/capabilities";
import type { CapabilityReport, CommittedDimension } from "@/lib/minds/capability-runner";
import { BITCOIN_MINING_SLUG, objectiveFromInputs, type BitcoinMiningObjective } from "./intel";

export interface BitcoinMiningGap {
  dimension: string;
  label: string;
  reason: string;
  resolution: string;
}

export interface BitcoinMiningReport {
  slug: typeof BITCOIN_MINING_SLUG;
  mode: "free" | "intel";
  preparedAt: string;
  objective: BitcoinMiningObjective | null;
  findings: {
    blockHeight: number | null;
    blockTime: string | null;
    hashrateEhS: number | null;
    hashpriceSatsPerPhDay: number | null;
    hashpriceUsdPerPhDay: number | null;
    hashpriceUsdBasis: "provider" | "derived_from_btc" | null;
    btcPriceUsd: number | null;
    btcVerifiedAt: string | null;
    lmpUsdPerMwh: number | null;
    energyZone: string | null;
    energyIntervalStart: string | null;
    energyMarket: string | null;
  };
  breakEven: {
    efficiencyJPerTh: number;
    formula: string;
    note: string;
  } | null;
  alignment: {
    aligned: boolean;
    notes: string[];
  };
  gaps: BitcoinMiningGap[];
  caveats: string[];
  confidence: "signal-verified" | "partial" | "unverified";
  spendUsdCents: number;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function verifiedDimension(committed: CommittedDimension[], id: string): CommittedDimension | null {
  const found = committed.find((c) => c.dimension === id);
  return found && found.verification === "verified" ? found : null;
}

/** Break-even fleet efficiency in J/TH at the observed hashprice and power price. */
export function breakEvenEfficiencyJPerTh(hashpriceUsdPerPhDay: number, lmpUsdPerMwh: number): number | null {
  if (!(hashpriceUsdPerPhDay > 0) || !(lmpUsdPerMwh > 0)) return null;
  // 1 PH/s = 1000 TH/s. At e J/TH that is e kW, or 24e kWh/day.
  // Energy cost = 24e * LMP / 1000 dollars/day. Set equal to hashprice:
  // e = 1000 * hashprice / (24 * LMP).
  return (1000 * hashpriceUsdPerPhDay) / (24 * lmpUsdPerMwh);
}

const GAP_FALLBACK =
  "No verified Telegraph route exists for this dimension. Keep it out of the findings and close it with a purpose-built source; never infer it from an unrelated intent.";

function gapResolution(gap: CapabilityDimension): string {
  return gap.resolution ?? GAP_FALLBACK;
}

export function buildBitcoinMiningReport(input: {
  mode: "free" | "intel";
  inputs: Record<string, Record<string, unknown>>;
  committed: CommittedDimension[];
  preparedAt: string;
  spendUsdCents: number;
  capabilityReport?: CapabilityReport;
}): BitcoinMiningReport {
  const caps = CAPABILITIES[BITCOIN_MINING_SLUG];
  const hash = verifiedDimension(input.committed, "hashprice_network");
  const btc = verifiedDimension(input.committed, "btc_price");
  const energy = verifiedDimension(input.committed, "energy_price");

  const blockHeight =
    numeric(hash?.values.block_height) ??
    numeric(input.inputs.hashprice_network?.block_height);
  const hashrateEhS = numeric(hash?.values.hashrate_eh_s);
  const hashpriceSats = numeric(hash?.values.hashprice_sats_per_ph_day);
  const providerUsd = numeric(hash?.values.hashprice_usd_per_ph_day);
  const btcPriceUsd = numeric(btc?.values.price_usd);
  const lmp = numeric(energy?.values.lmp_usd_per_mwh);

  const derivedUsd =
    providerUsd ?? (hashpriceSats !== null && btcPriceUsd !== null ? (hashpriceSats / 1e8) * btcPriceUsd : null);
  const usdBasis: BitcoinMiningReport["findings"]["hashpriceUsdBasis"] =
    providerUsd !== null ? "provider" : derivedUsd !== null ? "derived_from_btc" : null;

  const breakEven =
    derivedUsd !== null && lmp !== null && breakEvenEfficiencyJPerTh(derivedUsd, lmp) !== null
      ? {
          efficiencyJPerTh: breakEvenEfficiencyJPerTh(derivedUsd, lmp) as number,
          formula: "break-even J/TH = 1000 × hashprice (USD/PH/day) ÷ (24 × LMP (USD/MWh))",
          note:
            "This is the fleet efficiency at which power cost exactly consumes gross hash revenue at the observed prices. It is a break-even, not a measurement of the investigated fleet.",
        }
      : null;

  const preparedMs = Date.parse(input.preparedAt);
  const blockMs = hash?.values.block_time ? Date.parse(String(hash.values.block_time)) : NaN;
  const energyMs = energy?.values.interval_start ? Date.parse(String(energy.values.interval_start)) : NaN;
  const alignmentNotes: string[] = [];
  if (Number.isFinite(blockMs)) {
    const ageHours = (preparedMs - blockMs) / 3_600_000;
    if (ageHours > 72) {
      alignmentNotes.push(
        `The hashprice block is historical: block ${blockHeight ?? "unknown"} was mined ${Math.round(ageHours / 24)} day(s) before this run. Its hashprice is not a current market observation.`,
      );
    } else if (ageHours < -1) {
      alignmentNotes.push("The hashprice block timestamp is in the future relative to this run; treat the alignment as unknown.");
    } else {
      alignmentNotes.push("The hashprice block is recent relative to this run.");
    }
  } else {
    alignmentNotes.push("The hashprice answer carried no usable block timestamp.");
  }
  if (derivedUsd !== null && usdBasis === "derived_from_btc") {
    alignmentNotes.push(
      "USD hashprice is derived: the provider returned sats with no USD rate, so the committed sats value is multiplied by the separately committed BTC spot price. The two observations have different timestamps.",
    );
  }
  if (Number.isFinite(energyMs)) {
    const ageHours = (preparedMs - energyMs) / 3_600_000;
    if (ageHours > 24 * 7) {
      alignmentNotes.push(
        `The ERCOT settlement interval is ${Math.round(ageHours / 24)} day(s) old; it is not a live power price.`,
      );
    }
  } else {
    alignmentNotes.push("The energy answer carried no usable settlement interval.");
  }

  const allThree = !!hash && !!btc && !!energy && derivedUsd !== null && lmp !== null;
  const some = !!hash || !!btc || !!energy;
  const blockRecent = Number.isFinite(blockMs) ? preparedMs - blockMs <= 72 * 3_600_000 : false;
  const energyRecent = Number.isFinite(energyMs) ? preparedMs - energyMs <= 24 * 7 * 3_600_000 : false;

  const gaps: BitcoinMiningGap[] = (caps?.dimensions ?? [])
    .filter((d) => d.status === "gap")
    .map((d) => ({
      dimension: d.id,
      label: d.label,
      reason: d.missingReason ?? "unsupported dimension",
      resolution: gapResolution(d),
    }));

  const caveats: string[] = [];
  if (gaps.length) caveats.push(`${gaps.length} dimensions remain unsupported and are not estimated.`);
  if (input.mode === "free") caveats.push("Free preflight: no paid answer was purchased, so there are no findings.");
  if (hash?.missingFields.length) {
    caveats.push(
      `The hashprice answer is missing ${hash.missingFields.join(", ")}; USD is ${usdBasis === "derived_from_btc" ? "derived from committed sats × committed BTC price" : "unavailable"}.`,
    );
  }

  return {
    slug: BITCOIN_MINING_SLUG,
    mode: input.mode,
    preparedAt: input.preparedAt,
    objective: objectiveFromInputs(input.inputs),
    findings: {
      blockHeight,
      blockTime: text(hash?.values.block_time),
      hashrateEhS,
      hashpriceSatsPerPhDay: hashpriceSats,
      hashpriceUsdPerPhDay: derivedUsd,
      hashpriceUsdBasis: usdBasis,
      btcPriceUsd,
      btcVerifiedAt: btc?.verifiedAt ?? null,
      lmpUsdPerMwh: lmp,
      energyZone: text(energy?.values.node_or_zone),
      energyIntervalStart: text(energy?.values.interval_start),
      energyMarket: text(energy?.values.market),
    },
    breakEven,
    alignment: {
      aligned: allThree && blockRecent && energyRecent,
      notes: alignmentNotes,
    },
    gaps,
    caveats,
    confidence: input.mode === "intel" ? (allThree ? "signal-verified" : some ? "partial" : "unverified") : "unverified",
    spendUsdCents: input.mode === "intel" ? input.spendUsdCents : 0,
  };
}
