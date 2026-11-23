/**
 * Index Reconstitution Desk — the second specialist Mind, and the first over
 * the network's market-data intents.
 *
 * The desk investigates a USER-DEFINED index universe and produces an
 * evidence-backed constituent and weighting proposal. Every external fact it
 * uses is pinned to a REAL Telegraph intent whose schema and routing were
 * verified live (unpaid probes, 2026-11-23, archived under
 * telegraph_audit_data/index_desk_probes/); nothing here invents a miner, an
 * intent, a price or a fact:
 *
 *   registry   CORPORATE_REGISTRY_LOOKUP_GENERAL  @ zk-corp-atlas
 *              { company, jurisdiction } → the canonical registry fields.
 *              jurisdiction is REQUIRED by the node's input schema v3
 *              (live probe: HTTP 400 "jurisdiction is required" without it).
 *   price      CRYPTO_PRICE_USD                  @ cp-coinbase
 *              { symbol } → { price_usd }
 *   supply     TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL @ verifywire-token-total-supply
 *              { token } → { total_supply }
 *   liquidity  LIQUIDITY_DEPTH_VERIFY_GENERAL    @ verifywire-liquidity-depth
 *              { pool, chain } → { liquidity_usd } — only askable when the
 *              definition declares a DEX pool for the asset.
 *   holders    TOKEN_HOLDER_COUNT_GENERAL        @ router (no pin)
 *              { token, chain } → { holders_count, token_symbol, chain }
 *              (the purpose-named pinned miner refused the canonical input
 *              with HTTP 503 no_compatible_miner; the router builds it.)
 *   filings    REGULATORY_FILING_MONITOR_GENERAL @ verireceipt
 *              { entity, period } → { filing_count, filings, urls }
 *
 * What the network CANNOT answer is stated as missing, never fabricated:
 * there is no intent for circulating float or trading volumes, so those
 * dimensions exist only as user-DECLARED inputs (provenance-labelled) or as
 * entries in the proposal's missing-dimension ledger.
 *
 * Payment, approval and verification are inherited, not re-built: probes go
 * through probeAsk (unpaid, nothing signed), paid asks through executeAsk
 * (one attempt per ask, live-offer drift check, budget guard) and analysis
 * through verifySignal (keccak re-derivation over the recorded payload) +
 * the hash-committed payload — never the router's summary fields alone.
 */

import {
  probeAsk,
  verifySignal,
  type ApprovedOffer,
  type AskRequestSpec,
  type ProbeOutcome,
  type VerifyOutcome,
} from "@/lib/terminal/ask";
import {
  COUNTERPARTY_FIELDS,
  classifyCounterpartyEvidence,
  normalizeJurisdiction,
  type CounterpartyClassification,
} from "@/lib/counterparty/intel";

/* ------------------------------------------------------------------ */
/* Verified network coverage (see module docblock)                     */
/* ------------------------------------------------------------------ */

export const INDEX_REGISTRY_INTENT = "CORPORATE_REGISTRY_LOOKUP_GENERAL";
export const INDEX_REGISTRY_MINER = "zk-corp-atlas";
export const INDEX_PRICE_INTENT = "CRYPTO_PRICE_USD";
export const INDEX_PRICE_MINER = "cp-coinbase";
export const INDEX_SUPPLY_INTENT = "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL";
export const INDEX_SUPPLY_MINER = "verifywire-token-total-supply";
export const INDEX_LIQUIDITY_INTENT = "LIQUIDITY_DEPTH_VERIFY_GENERAL";
export const INDEX_LIQUIDITY_MINER = "verifywire-liquidity-depth";
export const INDEX_HOLDERS_INTENT = "TOKEN_HOLDER_COUNT_GENERAL";
/** The holders intent is routed by the node: the purpose-named pinned miner
 *  cannot build the canonical input (live probe: 503 no_compatible_miner). */
export const INDEX_HOLDERS_MINER: string | undefined = undefined;
export const INDEX_FILINGS_INTENT = "REGULATORY_FILING_MONITOR_GENERAL";
export const INDEX_FILINGS_MINER = "verireceipt";

export const INDEX_FILINGS_PERIOD = "last 12 months";
export const INDEX_DEFAULT_CHAIN = "ethereum";

export type IndexDimension = "registry" | "price" | "supply" | "liquidity" | "holders" | "filings";

export const INDEX_DIMENSIONS: IndexDimension[] = [
  "registry",
  "price",
  "supply",
  "liquidity",
  "holders",
  "filings",
];

export const INDEX_DIMENSION_LABELS: Record<IndexDimension, string> = {
  registry: "Issuer registry record",
  price: "USD price",
  supply: "Total supply",
  liquidity: "DEX pool liquidity",
  holders: "Holder count",
  filings: "Regulatory filings (12m)",
};

/** The committed payload field each dimension reads. */
export const INDEX_DIMENSION_FIELD: Record<IndexDimension, string> = {
  registry: "(registry record)",
  price: "price_usd",
  supply: "total_supply",
  liquidity: "liquidity_usd",
  holders: "holders_count",
  filings: "filing_count",
};

/** sanity bounds; outside them a committed number is MISSING, never clamped. */
const DIMENSION_BOUNDS: Record<Exclude<IndexDimension, "registry">, { min: number; max: number }> = {
  price: { min: 0, max: 1e9 },
  supply: { min: 0, max: 1e15 },
  liquidity: { min: 0, max: 1e12 },
  holders: { min: 0, max: 1e10 },
  filings: { min: 0, max: 1e6 },
};

/* ------------------------------------------------------------------ */
/* The index definition (what the user declares)                       */
/* ------------------------------------------------------------------ */

export interface IndexAssetDefinition {
  /** Ticker, 1–15 chars; normalized to upper-case. */
  symbol: string;
  /** The issuing legal entity. jurisdiction is required (registry schema v3). */
  issuer: { company: string; jurisdiction: string };
  /** Chain the token/pool live on (default "ethereum"). */
  chain?: string;
  /** DEX pool address or name; the liquidity dimension is only askable with it. */
  pool?: string;
  /**
   * User-declared inputs. These are the ONLY source for float/volume-style
   * facts (the network has no intent for them) and are always labelled
   * "declared" in the proposal — never presented as verified.
   */
  declared?: {
    circulatingSupply?: number;
    priceUsd?: number;
    volume30dUsd?: number;
  };
}

export interface IndexMethodology {
  /** equal | market_cap | custom — the deterministic weighting rule. */
  scheme: "equal" | "market_cap" | "custom";
  /** Required for scheme "custom": per-symbol weights (percent), normalized later. */
  customWeights?: Record<string, number>;
  /** Free-text methodology notes, recorded verbatim in the proposal. */
  notes?: string;
}

export interface IndexDefinition {
  name: string;
  methodology: IndexMethodology;
  assets: IndexAssetDefinition[];
}

export function validateIndexDefinition(def: unknown): { ok: true; definition: IndexDefinition } | { ok: false; error: string } {
  if (typeof def !== "object" || def === null || Array.isArray(def)) {
    return { ok: false, error: "The index definition must be a JSON object." };
  }
  const d = def as Record<string, unknown>;
  const name = typeof d.name === "string" ? d.name.trim() : "";
  if (name.length < 2 || name.length > 120) {
    return { ok: false, error: "Give the index a name of 2–120 characters." };
  }
  const m = d.methodology;
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    return { ok: false, error: "The methodology must be an object with a scheme." };
  }
  const scheme = (m as Record<string, unknown>).scheme;
  if (scheme !== "equal" && scheme !== "market_cap" && scheme !== "custom") {
    return { ok: false, error: 'methodology.scheme must be "equal", "market_cap" or "custom".' };
  }
  let customWeights: Record<string, number> | undefined;
  if (scheme === "custom") {
    const raw = (m as Record<string, unknown>).customWeights;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: 'Scheme "custom" requires methodology.customWeights: { symbol: percent }.' };
    }
    customWeights = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { ok: false, error: `Custom weight for "${k}" must be a number between 0 and 100 (percent).` };
      }
      customWeights[k.trim().toUpperCase()] = n;
    }
    if (Object.values(customWeights).reduce((a, b) => a + b, 0) <= 0) {
      return { ok: false, error: "Custom weights must sum to a positive number." };
    }
  }
  const notes = typeof (m as Record<string, unknown>).notes === "string" ? (m as Record<string, unknown>).notes as string : undefined;

  const rawAssets = d.assets;
  if (!Array.isArray(rawAssets) || rawAssets.length < 2 || rawAssets.length > 25) {
    return { ok: false, error: "Define between 2 and 25 assets in the universe." };
  }
  const assets: IndexAssetDefinition[] = [];
  const seen = new Set<string>();
  for (const a of rawAssets) {
    if (typeof a !== "object" || a === null) return { ok: false, error: "Every asset must be an object." };
    const rec = a as Record<string, unknown>;
    const symbol = typeof rec.symbol === "string" ? rec.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{1,15}$/.test(symbol)) {
      return { ok: false, error: `Asset symbol "${String(rec.symbol).slice(0, 20)}" must be 1–15 letters/digits.` };
    }
    if (seen.has(symbol)) return { ok: false, error: `Duplicate asset symbol "${symbol}".` };
    seen.add(symbol);
    const issuer = rec.issuer;
    if (typeof issuer !== "object" || issuer === null) {
      return { ok: false, error: `Asset ${symbol}: an issuer { company, jurisdiction } is required (the registry intent requires both).` };
    }
    const company = typeof (issuer as Record<string, unknown>).company === "string" ? ((issuer as Record<string, unknown>).company as string).trim() : "";
    const jurisdiction = typeof (issuer as Record<string, unknown>).jurisdiction === "string" ? ((issuer as Record<string, unknown>).jurisdiction as string).trim() : "";
    if (company.length < 2 || company.length > 120) {
      return { ok: false, error: `Asset ${symbol}: issuer company must be 2–120 characters (the registered legal name).` };
    }
    if (!jurisdiction) {
      return { ok: false, error: `Asset ${symbol}: issuer jurisdiction is required — the registry intent rejects lookups without it.` };
    }
    const chain = typeof rec.chain === "string" && rec.chain.trim() ? rec.chain.trim().toLowerCase() : INDEX_DEFAULT_CHAIN;
    const pool = typeof rec.pool === "string" && rec.pool.trim() ? rec.pool.trim() : undefined;
    let declared: IndexAssetDefinition["declared"];
    const rawDeclared = rec.declared;
    if (typeof rawDeclared === "object" && rawDeclared !== null && !Array.isArray(rawDeclared)) {
      const rd = rawDeclared as Record<string, unknown>;
      const num = (v: unknown): number | undefined => {
        if (v === undefined || v === null || v === "") return undefined;
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) && n >= 0 ? n : NaN;
      };
      const supply = num(rd.circulatingSupply);
      const price = num(rd.priceUsd);
      const volume = num(rd.volume30dUsd);
      if (Number.isNaN(supply) || Number.isNaN(price) || Number.isNaN(volume)) {
        return { ok: false, error: `Asset ${symbol}: declared inputs must be non-negative numbers.` };
      }
      declared = {
        ...(supply !== undefined ? { circulatingSupply: supply } : {}),
        ...(price !== undefined ? { priceUsd: price } : {}),
        ...(volume !== undefined ? { volume30dUsd: volume } : {}),
      };
    }
    assets.push({ symbol, issuer: { company, jurisdiction }, chain, ...(pool ? { pool } : {}), ...(declared ? { declared } : {}) });
  }
  if (scheme === "custom" && customWeights) {
    const missing = assets.filter((a) => !(a.symbol in customWeights)).map((a) => a.symbol);
    if (missing.length > 0) {
      return { ok: false, error: `Scheme "custom" needs a weight for every asset; missing: ${missing.join(", ")}.` };
    }
  }
  return { ok: true, definition: { name, methodology: { scheme, ...(customWeights ? { customWeights } : {}), ...(notes !== undefined ? { notes } : {}) }, assets } };
}

/* ------------------------------------------------------------------ */
/* Per-dimension specs and probes                                      */
/* ------------------------------------------------------------------ */

/** The issuer entity exactly as the registry intent needs it (ISO jurisdiction). */
function registryParams(asset: IndexAssetDefinition): Record<string, unknown> {
  return { company: asset.issuer.company, jurisdiction: normalizeJurisdiction(asset.issuer.jurisdiction) };
}

export function indexAssetTokenParam(asset: IndexAssetDefinition): string {
  return asset.symbol;
}

/**
 * The exact ask one dimension makes for one asset, or null when the dimension
 * is not askable for this asset (liquidity without a declared pool).
 */
export function buildDimensionSpec(asset: IndexAssetDefinition, dimension: IndexDimension): AskRequestSpec | null {
  switch (dimension) {
    case "registry":
      return { intent: INDEX_REGISTRY_INTENT, params: registryParams(asset), minerId: INDEX_REGISTRY_MINER };
    case "price":
      return { intent: INDEX_PRICE_INTENT, params: { symbol: asset.symbol }, minerId: INDEX_PRICE_MINER };
    case "supply":
      return { intent: INDEX_SUPPLY_INTENT, params: { token: indexAssetTokenParam(asset) }, minerId: INDEX_SUPPLY_MINER };
    case "liquidity":
      if (!asset.pool) return null;
      return {
        intent: INDEX_LIQUIDITY_INTENT,
        params: { pool: asset.pool, chain: asset.chain ?? INDEX_DEFAULT_CHAIN },
        minerId: INDEX_LIQUIDITY_MINER,
      };
    case "holders":
      return {
        intent: INDEX_HOLDERS_INTENT,
        params: { token: indexAssetTokenParam(asset), chain: asset.chain ?? INDEX_DEFAULT_CHAIN },
        ...(INDEX_HOLDERS_MINER ? { minerId: INDEX_HOLDERS_MINER } : {}),
      };
    case "filings":
      return {
        intent: INDEX_FILINGS_INTENT,
        params: { entity: asset.issuer.company, period: INDEX_FILINGS_PERIOD },
        minerId: INDEX_FILINGS_MINER,
      };
  }
}

/** The dimensions this asset CAN have asked about (liquidity needs a pool). */
export function askableDimensions(asset: IndexAssetDefinition): IndexDimension[] {
  return INDEX_DIMENSIONS.filter((d) => buildDimensionSpec(asset, d) !== null);
}

/** The UNPAID pre-flight for one dimension: validation + live pricing, nothing signed. */
export async function probeIndexDimension(asset: IndexAssetDefinition, dimension: IndexDimension): Promise<ProbeOutcome> {
  const spec = buildDimensionSpec(asset, dimension);
  if (!spec) return { kind: "rejected", status: 0, body: { error: "dimension not askable" }, text: "dimension not askable" };
  // Autonomous flow: the deployment payer settles the exact rail, so the
  // exact-scheme offer is what gets approved and drift-checked (same as the
  // Mind investigation runner, which passes preferEscrow:false).
  return probeAsk(spec, { preferEscrow: false });
}

/* ------------------------------------------------------------------ */
/* Reading the committed payload                                       */
/* ------------------------------------------------------------------ */

function committedResponseOf(record: unknown): Record<string, unknown> | null {
  if (typeof record !== "object" || record === null) return null;
  const payload = (record as Record<string, unknown>).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const response = (payload as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) return null;
  return response as Record<string, unknown>;
}

export type DimensionValue =
  | { present: true; value: number; detail?: string }
  | { present: false; reason: string };

/**
 * Read one dimension's number out of the committed payload. Only finite
 * in-bounds numbers count; anything else (absent, wrong type, out of bounds)
 * is MISSING with the honest reason — never coerced, never clamped.
 */
export function extractDimensionValue(dimension: Exclude<IndexDimension, "registry">, payload: Record<string, unknown>): DimensionValue {
  const field = INDEX_DIMENSION_FIELD[dimension];
  const v = payload[field];
  if (v === undefined || v === null || v === "") return { present: false, reason: `the committed answer carries no ${field}` };
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return { present: false, reason: `${field} is not a number in the committed answer (${JSON.stringify(v).slice(0, 40)})` };
  const b = DIMENSION_BOUNDS[dimension];
  if (n < b.min || n > b.max) return { present: false, reason: `${field}=${n} is outside the plausible range (${b.min}–${b.max})` };
  return { present: true, value: n };
}

/** Same for the router's summary `result` (used only to detect disagreements). */
function summaryValue(dimension: Exclude<IndexDimension, "registry">, result: Record<string, unknown> | null): number | null {
  if (!result) return null;
  const field = INDEX_DIMENSION_FIELD[dimension];
  const v = result[field];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface IndexDimensionAnalysis {
  dimension: IndexDimension;
  verification: VerifyOutcome;
  /** The hash-committed answer, or null when the record carries none. */
  committed: Record<string, unknown> | null;
  /** Registry dimensions: the full canonical classification. */
  registry: CounterpartyClassification | null;
  /** Numeric dimensions: the extracted value with its provenance. */
  value: { present: true; value: number; detail?: string } | { present: false; reason: string };
  /** Committed payload vs router summary disagreements, reported as conflicts. */
  disagreements: Array<{ field: string; left: string; right: string; note?: string }>;
}

/**
 * Post-purchase analysis for one paid ask: keccak verification decides
 * whether the purchase counts, and the hash-committed payload — never the
 * router summary alone — is what gets read. Numeric disagreements between
 * the two are reported as conflicts, never silently resolved.
 */
export async function analyzeIndexDimension(args: {
  dimension: IndexDimension;
  signalHash: string;
  bodyResult?: unknown;
  asset: IndexAssetDefinition;
}): Promise<IndexDimensionAnalysis> {
  const { dimension, signalHash, asset } = args;
  const verification = await verifySignal(signalHash);
  const disagreements: IndexDimensionAnalysis["disagreements"] = [];
  if (verification.kind === "unverified") {
    return { dimension, verification, committed: null, registry: null, value: { present: false, reason: "the purchase could not be verified against the signal registry" }, disagreements };
  }
  const committed = committedResponseOf(verification.record);
  if (!committed) {
    return { dimension, verification, committed: null, registry: null, value: { present: false, reason: "the signal registry carries no committed answer payload for this hash" }, disagreements };
  }
  const bodyResult =
    args.bodyResult && typeof args.bodyResult === "object" && !Array.isArray(args.bodyResult)
      ? (args.bodyResult as Record<string, unknown>)
      : null;

  if (dimension === "registry") {
    const classification = classifyCounterpartyEvidence({
      payloadResponse: committed,
      bodyResult,
      request: { company: asset.issuer.company, jurisdiction: normalizeJurisdiction(asset.issuer.jurisdiction) },
    });
    return { dimension, verification, committed, registry: classification, value: { present: false, reason: "registry findings are structural, not a single number" }, disagreements };
  }

  const value = extractDimensionValue(dimension, committed);
  const summary = summaryValue(dimension, bodyResult);
  if (value.present && summary !== null && summary !== value.value) {
    disagreements.push({
      field: INDEX_DIMENSION_FIELD[dimension],
      left: `committed payload: ${value.value}`,
      right: `router summary: ${summary}`,
      note: "the two network-provided copies of the same fact disagree; the committed payload is authoritative, the conflict is reported",
    });
  }
  return { dimension, verification, committed, registry: null, value, disagreements };
}

/** The canonical registry fields, re-exported for the proposal's data-quality math. */
export { COUNTERPARTY_FIELDS };
