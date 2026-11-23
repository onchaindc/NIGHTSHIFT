/**
 * Index Reconstitution Desk — deterministic methodology.
 *
 * Every number in the proposal comes from the rules below, applied in a
 * fixed order to recorded evidence. Nothing here calls the network, estimates,
 * or invents: a weighting input the investigation did not establish is either
 * user-DECLARED (provenance-labelled) or MISSING, and the asset is handled by
 * the stated exclusion rules instead of being filled in.
 *
 * Rules (stated verbatim in every proposal, tested one by one):
 *  1. Universe: exactly the declared assets. The desk never adds or drops
 *     assets except through these rules.
 *  2. Issuer rule: an issuer the registry verifiably reports as inactive is
 *     EXCLUDED. An issuer the desk could not verify leaves the asset
 *     PROVISIONAL — kept and flagged, never silently trusted.
 *  3. Weighting by scheme:
 *       equal      — w_i = 1/N over the assets kept by rules 1–2.
 *       market_cap — cap_i = supply_i × price_i, each input taken
 *                    telegraph-verified when present, else user-declared
 *                    (labelled); an asset missing either input is EXCLUDED.
 *       custom     — the user's declared percent weights, normalized to sum
 *                    to 100; an asset with no declared weight is EXCLUDED.
 *  4. Concentration: HHI = Σ w_i² (fractional weights), effectiveN = 1/HHI,
 *     top-1 and top-3 shares, over the FINAL weights.
 *  5. Data quality per asset: canonical registry fields known (verified
 *     evidence), disagreements found between network copies of the same
 *     fact, and how many of the six dimensions ended verified / declared /
 *     missing / unavailable.
 */

import {
  COUNTERPARTY_FIELDS,
  INDEX_DIMENSIONS,
  INDEX_DIMENSION_LABELS,
  type IndexAssetDefinition,
  type IndexDefinition,
  type IndexDimension,
} from "./intel";

/* ------------------------------------------------------------------ */
/* What one asset's investigation collected                            */
/* ------------------------------------------------------------------ */

export type DimensionStatus = "verified" | "recorded" | "missing" | "not_probed" | "declared_only";

export interface CollectedDimension {
  dimension: IndexDimension;
  status: DimensionStatus;
  /** Numeric dimensions: the committed (verified) value. */
  value?: number;
  /** Registry dimension: the canonical classification. */
  registryFacts?: Array<{ field: string; value: unknown }>;
  registryMissing?: string[];
  registryActive?: boolean | null;
  signalHash?: string;
  receiptHash?: string;
  costUsdCents?: number;
  /** Conflicts between the committed payload and the router summary. */
  disagreements?: number;
  /** Honest one-line detail (why a value is missing, what was recorded). */
  detail: string;
}

export interface CollectedAsset {
  definition: IndexAssetDefinition;
  dimensions: CollectedDimension[];
}

/* ------------------------------------------------------------------ */
/* The proposal                                                        */
/* ------------------------------------------------------------------ */

export type InputProvenance = "telegraph-verified" | "declared" | "missing" | "unavailable";

export interface ProvenanceInput {
  value: number;
  provenance: InputProvenance;
}

export interface AssetInputs {
  supply?: ProvenanceInput;
  price?: ProvenanceInput;
  marketCap?: ProvenanceInput;
  liquidityUsd?: ProvenanceInput;
  holders?: ProvenanceInput;
  filings?: ProvenanceInput;
  volume30dUsd?: ProvenanceInput;
}

export interface WeightedAsset {
  symbol: string;
  issuer: string;
  issuerJurisdiction: string;
  /** included | excluded | provisional (kept, flagged). */
  status: "included" | "excluded" | "provisional";
  weightPct?: number;
  marketCapUsd?: number;
  exclusionReason?: string;
  provisionalReason?: string;
  inputs: AssetInputs;
  dataQuality: {
    /** Verified canonical registry fields / 9. */
    registryFieldsKnown: number;
    registryFieldsTotal: number;
    /** Dimensions that ended telegraph-verified. */
    dimensionsVerified: number;
    dimensionsTotal: number;
    /** Conflicts between network copies of the same fact. */
    disagreements: number;
    /** 0–100: verified registry fields and verified dimensions, minus conflicts. */
    score: number;
  };
}

export interface IndexProposal {
  scheme: IndexDefinition["methodology"]["scheme"];
  /** Final weights over INCLUDED assets only, percent, rounded to 4 dp. */
  weights: Array<{ symbol: string; weightPct: number }>;
  /** Exact sum of the unrounded weights (may differ from 100 by float epsilon). */
  weightSumPct: number;
  /** Declared weights were not 100 and were normalized (custom scheme). */
  normalizedFrom?: number;
  concentration: {
    hhi: number;
    effectiveN: number;
    top1Pct: number;
    top3Pct: number;
  };
}

export interface MissingDimensionEntry {
  scope: "portfolio" | "asset";
  symbol?: string;
  dimension: string;
  reason: string;
}

export interface IndexMethodologyOutcome {
  weightedAssets: WeightedAsset[];
  proposal: IndexProposal | null;
  /** Null when fewer than two assets survived (no meaningful index). */
  proposalBlocker?: string;
  methodologyRules: string[];
  missingDimensions: MissingDimensionEntry[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function dimensionOf(asset: CollectedAsset, dimension: IndexDimension): CollectedDimension | undefined {
  return asset.dimensions.find((d) => d.dimension === dimension);
}

/** A dimension counts as evidence only when it verified against the registry. */
function isVerified(d: CollectedDimension | undefined): d is CollectedDimension & { status: "verified" } {
  return !!d && d.status === "verified";
}

function provenanceOf(d: CollectedDimension | undefined, declaredValue: number | undefined): ProvenanceInput | undefined {
  if (isVerified(d) && d.value !== undefined) return { value: d.value, provenance: "telegraph-verified" };
  if (declaredValue !== undefined) return { value: declaredValue, provenance: "declared" };
  if (d && d.status === "missing") return undefined; // the ask ran; the network had no usable answer
  if (d && d.status === "not_probed") return undefined;
  return undefined;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/* ------------------------------------------------------------------ */
/* The deterministic pass                                              */
/* ------------------------------------------------------------------ */

export function buildIndexProposal(
  definition: IndexDefinition,
  collected: CollectedAsset[],
): IndexMethodologyOutcome {
  const scheme = definition.methodology.scheme;
  const rules: string[] = [
    "Universe: exactly the declared assets; the desk adds and drops nothing except through the rules below.",
    "Issuer rule: an issuer the registry verifiably reports as inactive is excluded; an issuer the desk could not verify leaves the asset provisional — kept and flagged, never silently trusted.",
    scheme === "equal"
      ? "Weighting (equal): every kept asset gets 1/N of the portfolio, N = number of kept assets."
      : scheme === "market_cap"
        ? "Weighting (market_cap): cap = supply × price per asset, each input telegraph-verified when present, otherwise user-declared and labelled; an asset missing either input is excluded."
        : "Weighting (custom): the declared percent weights are normalized to sum to 100; an asset without a declared weight is excluded.",
    "Concentration: HHI = Σ w² over fractional weights, effectiveN = 1/HHI, plus top-1 and top-3 shares.",
    "Data quality: canonical registry fields known from verified evidence, network-internal disagreements counted, and every dimension labelled verified / declared / missing / unavailable.",
  ];

  const weighted: WeightedAsset[] = [];
  const missing: MissingDimensionEntry[] = [];

  // Portfolio-level missing dimensions: what the network simply does not sell.
  missing.push({
    scope: "portfolio",
    dimension: "Circulating float",
    reason: "the network exposes TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL (total supply) but no circulating-float or locked-supply intent; float-style figures exist only as user-declared inputs",
  });
  missing.push({
    scope: "portfolio",
    dimension: "Trading volumes / trading quality",
    reason: "no network intent returns traded volumes or execution-quality metrics; the liquidity dimension covers DEX pool depth only, and volume-style figures exist only as user-declared inputs",
  });

  // Per-asset pass: build inputs, issuer verdict, exclusions.
  interface Kept {
    symbol: string;
    asset: CollectedAsset;
    cap?: number;
    customPct?: number;
  }
  const kept: Kept[] = [];

  for (const asset of collected) {
    const def = asset.definition;
    const reg = dimensionOf(asset, "registry");
    const regVerified = isVerified(reg);
    const regActive = reg?.registryActive ?? null;
    const registryFacts = reg?.registryFacts ?? [];
    const registryMissing = reg?.registryMissing ?? [...COUNTERPARTY_FIELDS];

    const supply = provenanceOf(dimensionOf(asset, "supply"), def.declared?.circulatingSupply);
    const price = provenanceOf(dimensionOf(asset, "price"), def.declared?.priceUsd);
    const liquidity = provenanceOf(dimensionOf(asset, "liquidity"), undefined);
    const holders = provenanceOf(dimensionOf(asset, "holders"), undefined);
    const filings = provenanceOf(dimensionOf(asset, "filings"), undefined);
    const volume = def.declared?.volume30dUsd !== undefined ? { value: def.declared.volume30dUsd, provenance: "declared" as const } : undefined;
    // A cap computed from mixed provenance (e.g. verified supply × declared
    // price) is labelled declared: only BOTH-verified inputs earn the
    // telegraph-verified label. The per-input provenance stays visible.
    const capProvenance: InputProvenance = supply && price && supply.provenance === "telegraph-verified" && price.provenance === "telegraph-verified" ? "telegraph-verified" : "declared";
    const marketCap = supply && price ? { value: supply.value * price.value, provenance: capProvenance } : undefined;

    // Provenance-honest portfolio note: supply from the network is TOTAL supply;
    // a declared circulating figure is the only float-style input.
    if (supply && supply.provenance === "telegraph-verified") {
      missing.push({ scope: "asset", symbol: def.symbol, dimension: "Circulating float", reason: "the verified figure is TOTAL supply (TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL); the market-cap input substitutes it and is labelled accordingly" });
    }

    // Disagreement count across the asset's dimensions (explicit data from
    // the executors, never parsed out of prose).
    const disagreements = asset.dimensions.reduce((n, d) => n + (d.disagreements ?? 0), 0);

    const dimensionsVerified = asset.dimensions.filter((d) => d.status === "verified").length;
    const score = Math.max(
      0,
      Math.min(100, Math.round(((registryFacts.length / COUNTERPARTY_FIELDS.length) * 0.5 + (dimensionsVerified / INDEX_DIMENSIONS.length) * 0.5) * 100 - disagreements * 5)),
    );

    const inputs: AssetInputs = {
      ...(supply ? { supply } : {}),
      ...(price ? { price } : {}),
      ...(marketCap ? { marketCap } : {}),
      ...(liquidity ? { liquidityUsd: liquidity } : {}),
      ...(holders ? { holders } : {}),
      ...(filings ? { filings } : {}),
      ...(volume ? { volume30dUsd: volume } : {}),
    };

    const base: WeightedAsset = {
      symbol: def.symbol,
      issuer: def.issuer.company,
      issuerJurisdiction: def.issuer.jurisdiction,
      status: "included",
      inputs,
      dataQuality: {
        registryFieldsKnown: registryFacts.length,
        registryFieldsTotal: COUNTERPARTY_FIELDS.length,
        dimensionsVerified,
        dimensionsTotal: INDEX_DIMENSIONS.length,
        disagreements,
        score,
      },
    };

    // Rule 2: verifiably inactive issuers are excluded outright.
    if (regVerified && regActive === false) {
      weighted.push({
        ...base,
        status: "excluded",
        exclusionReason: "the registry verifiably reports the issuer as not active — excluded by the issuer rule",
      });
      continue;
    }
    // Rule 3: scheme-input exclusions apply to every asset, provisional or not.
    if (scheme === "market_cap" && (!supply || !price)) {
      const lacking = [!supply ? "supply" : null, !price ? "price" : null].filter(Boolean).join(" and ");
      weighted.push({
        ...base,
        status: "excluded",
        exclusionReason: `scheme market_cap requires ${lacking} and neither was verified or declared for ${def.symbol}`,
      });
      continue;
    }
    if (scheme === "custom") {
      const pct = definition.methodology.customWeights?.[def.symbol];
      if (pct === undefined) {
        weighted.push({ ...base, status: "excluded", exclusionReason: "no declared weight for this asset under the custom scheme" });
        continue;
      }
      if (pct <= 0) {
        weighted.push({ ...base, status: "excluded", exclusionReason: "declared methodology weight is 0" });
        continue;
      }
    }
    // Status: a verified issuer means included; an unverified one stays
    // provisional — kept in the weighting, flagged in the proposal.
    if (!regVerified) {
      const reason = reg
        ? `issuer record not verified (${reg.detail}) — asset kept as provisional`
        : "issuer record not probed (free mode) — asset kept as provisional";
      weighted.push({ ...base, status: "provisional", provisionalReason: reason });
    } else {
      weighted.push(base);
    }
    kept.push({ symbol: def.symbol, asset, ...(marketCap ? { cap: marketCap.value } : {}), customPct: definition.methodology.customWeights?.[def.symbol] });
  }

  // Per-asset dimension ledger for anything not verified and not declared.
  for (const asset of collected) {
    for (const dimension of INDEX_DIMENSIONS) {
      const d = dimensionOf(asset, dimension);
      const def = asset.definition;
      if (d === undefined) {
        missing.push({ scope: "asset", symbol: def.symbol, dimension: INDEX_DIMENSION_LABELS[dimension], reason: dimension === "liquidity" ? "no DEX pool was declared for this asset, so the liquidity ask cannot be assembled" : "dimension not probed" });
        continue;
      }
      if (d.status === "missing") {
        missing.push({ scope: "asset", symbol: def.symbol, dimension: INDEX_DIMENSION_LABELS[dimension], reason: d.detail });
      }
    }
  }

  // Weighting.
  let proposal: IndexProposal | null = null;
  let proposalBlocker: string | undefined;
  if (kept.length < 2) {
    proposalBlocker = `fewer than two assets survived the methodology rules (${kept.length} kept), so no index weighting is proposed — the per-asset evidence and exclusions above are the deliverable`;
  } else {
    const raw: Array<{ symbol: string; w: number }> = [];
    let normalizedFrom: number | undefined;
    if (scheme === "equal") {
      for (const k of kept) raw.push({ symbol: k.symbol, w: 1 / kept.length });
    } else if (scheme === "market_cap") {
      for (const k of kept) raw.push({ symbol: k.symbol, w: k.cap ?? 0 });
      const capSum = raw.reduce((a, b) => a + b.w, 0);
      if (capSum <= 0) {
        for (const k of kept) raw.length = 0;
        proposalBlocker = "every kept asset has a zero or unknown market cap (no verified or declared supply × price), so no weighting is proposed";
      } else {
        for (const r of raw) r.w = r.w / capSum;
      }
    } else {
      const declaredSum = kept.reduce((a, k) => a + (k.customPct ?? 0), 0);
      normalizedFrom = round4(declaredSum);
      for (const k of kept) raw.push({ symbol: k.symbol, w: (k.customPct ?? 0) / declaredSum });
    }
    if (!proposalBlocker) {
      const weights = raw
        .map((r) => ({ symbol: r.symbol, weightPct: round4(r.w * 100) }))
        .sort((a, b) => b.weightPct - a.weightPct);
      const frac = Object.fromEntries(weights.map((w) => [w.symbol, w.weightPct / 100]));
      const hhi = Object.values(frac).reduce((a, w) => a + w * w, 0);
      const top3 = weights.slice(0, 3).reduce((a, w) => a + w.weightPct, 0);
      proposal = {
        scheme,
        weights,
        weightSumPct: round4(weights.reduce((a, w) => a + w.weightPct, 0)),
        ...(normalizedFrom !== undefined ? { normalizedFrom } : {}),
        concentration: {
          hhi: round4(hhi),
          effectiveN: round4(1 / hhi),
          top1Pct: weights[0]?.weightPct ?? 0,
          top3Pct: round4(top3),
        },
      };
    }
  }

  return { weightedAssets: weighted, proposal, ...(proposalBlocker ? { proposalBlocker } : {}), methodologyRules: rules, missingDimensions: missing };
}
