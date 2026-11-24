/**
 * The verified Telegraph capability matrix for every Mind.
 *
 * Discovery source: the live node catalogue (`/engine/v1/intents`,
 * `/api/miners` and `/engine/v1/intents/:id`) read on 2026-11-24: 136
 * intents and 2,192 miner listings. Every non-gap dimension below was then
 * probed UNPAID against `/engine/v1/ask/:miner` with the canonical
 * `{intent, params}` body. All 42 probes returned a valid 402 x402
 * challenge with the pinned provider — the node validated the request
 * schema, routing and live price. No paid ask was executed while building
 * this matrix, so provider OUTPUT QUALITY is deliberately not claimed for
 * those dimensions.
 *
 * `integration_verified` is used only where a real product path has already
 * produced verified answers on this deployment (the Index Desk and
 * Counterparty Intelligence). Everything else is `probe_verified`: the
 * route and contract are real, the answer is not yet exercised.
 *
 * Gaps are first-class. A dimension the network cannot answer is listed
 * with `status: "gap"` and a reason; it is never mapped onto a loosely
 * related intent to make a Mind look complete.
 *
 * This module holds data only. The executable adapter lives in
 * `capability-runner.ts` and reuses the existing probe/execute/verify
 * machinery rather than re-implementing payments.
 */

import type { MindStatus } from "./registry";

export const CAPABILITY_PROBED_AT = "2026-11-24T00:00:00Z";
export const CAPABILITY_CATALOGUE = {
  intents: 136,
  minerListings: 2192,
  source: "https://devnode.telegraphprotocol.com",
} as const;

/** $0.01 per ask was the live challenge for every probed dimension. */
export const DEFAULT_ASK_PRICE_USD_CENTS = 1;

export type CapabilityStatus = "verified" | "partial" | "gap";
export type CapabilityVerification = "probe_verified" | "integration_verified" | "unsupported";

export interface CapabilityParam {
  type: string;
  required: boolean;
  description: string;
  /** A safe probe value. Investigations supply real values at run time. */
  sample?: string | number;
}

export interface CapabilityDimension {
  id: string;
  label: string;
  /** The business question this dimension answers. */
  requirement: string;
  status: CapabilityStatus;
  /** Absent only for a gap. */
  intent?: string;
  /** Pinned provider slug; "router" means the node selects the provider. */
  provider?: string;
  params?: Record<string, CapabilityParam>;
  /** Fields the verified committed payload is expected to carry. */
  responseFields?: string[];
  priceUsdCents?: number;
  verification?: CapabilityVerification;
  /** What a verified answer is expected to say, in business terms. */
  output?: string;
  /** Why this route is trustworthy — and what remains unverified. */
  evidence?: string;
  /** Honest scope limit of the provider/schema. */
  limitation?: string;
  /** Required for a gap. */
  missingReason?: string;
}

export interface CapabilityDependency {
  dimension: string;
  /** Inputs or prior facts the dimension needs before it can be asked. */
  requires: string[];
}

export interface MindInvestigationPlan {
  /** Supported dimensions, in execution order. */
  order: string[];
  dependencies: CapabilityDependency[];
  evidenceRequirements: string[];
  /** Sum of the live probed ask prices, in cents. */
  budgetCeilingUsdCents: number;
  approvalGate: string;
  verification: string;
  reporting: string[];
  /** What the plan deliberately leaves out. */
  exclusions: string[];
}

export interface MindCapabilities {
  slug: string;
  readiness: "operational" | "partial_coverage" | "definition_only";
  dimensions: CapabilityDimension[];
  plan: MindInvestigationPlan;
}

const PROBE_EVIDENCE =
  "Canonical request schema, pinned provider and live x402 price accepted by the node during an unpaid probe; output quality is not claimed until a paid, verified answer exists.";

const INTEGRATION_EVIDENCE =
  "Already part of a live product path on this deployment; completed investigations have returned hash-committed, signal-verified answers.";

const registry = (company: string, jurisdiction: string): Record<string, CapabilityParam> => ({
  company: { type: "string", required: true, description: "Registered legal name", sample: company },
  jurisdiction: { type: "string", required: true, description: "ISO 3166 alpha-2 code (schema v3 requires it)", sample: jurisdiction },
});

const PLAN_BASE = {
  evidenceRequirements: [
    "A node signal hash for every dimension, with the hash-committed payload retained",
    "The x402 receipt (amount, asset, payer) for every paid ask",
    "A recorded probe result and live price before any approval",
  ],
  approvalGate:
    "An operator approves the exact dimension plan and each live offer before anything is signed; probes are free and never become purchases.",
  verification:
    "Each dimension is checked by re-deriving the node signal (keccak over the committed payload) and comparing the committed answer with the paid body; a mismatch or missing field is recorded as missing or disputed, never resolved by assumption.",
  reporting: [
    "Per-dimension finding with intent, provider, price, signal hash and receipt hash",
    "A missing/unsupported ledger that names every gap instead of inferring it",
    "A spend ledger reconciled against receipts, with no unverified purchase counted as evidence",
  ],
};

function plan(
  order: string[],
  dependencies: CapabilityDependency[],
  exclusions: string[],
): MindInvestigationPlan {
  const ceiling = order.length * DEFAULT_ASK_PRICE_USD_CENTS;
  return {
    ...PLAN_BASE,
    order,
    dependencies,
    budgetCeilingUsdCents: ceiling,
    exclusions,
  };
}

export const CAPABILITIES: Record<string, MindCapabilities> = {
  "bitcoin-mining-intelligence": {
    slug: "bitcoin-mining-intelligence",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "hashprice_network",
        label: "Hashprice and network hashrate",
        requirement: "What is bitcoin worth per unit of compute, and how much hashrate is securing the network at a given block?",
        status: "verified",
        intent: "MINING_HASHPRICE_VERIFY_GENERAL",
        provider: "zk-hashprice",
        params: { block_height: { type: "integer", required: true, description: "Bitcoin mainnet block height", sample: 870000 } },
        responseFields: ["hashprice_sats_per_ph_day", "hashprice_usd_per_ph_day", "hashrate_eh_s"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Hashprice in sats and USD per PH/s per day plus network hashrate at the requested block.",
        evidence: PROBE_EVIDENCE,
        limitation: "One block height per ask; producing a time series requires multiple approved asks.",
      },
      {
        id: "btc_price",
        label: "BTC spot price",
        requirement: "What is the current USD price of bitcoin for revenue and margin calculations?",
        status: "verified",
        intent: "CRYPTO_PRICE_USD",
        provider: "cp-coinbase",
        params: { symbol: { type: "string", required: true, description: "Asset ticker", sample: "BTC" } },
        responseFields: ["price_usd"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Current USD price for the requested asset.",
        evidence: PROBE_EVIDENCE,
        limitation: "A point-in-time price, not an execution quote.",
      },
      {
        id: "energy_price",
        label: "Grid power price",
        requirement: "What did power cost at the mining site's grid node for a settlement interval?",
        status: "verified",
        intent: "GRID_POWER_PRICE_GENERAL",
        provider: "pecos-ercot",
        params: {
          node_or_zone: { type: "string", required: true, description: "ERCOT hub or load zone", sample: "HB_WEST" },
          interval_start: { type: "datetime", required: true, description: "Settlement interval start (RFC 3339 with timezone)", sample: "2026-11-23T00:00:00-06:00" },
        },
        responseFields: ["lmp_usd_per_mwh", "node_or_zone", "market", "interval_start", "currency"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Locational marginal price in USD per MWh for the requested ERCOT node and interval.",
        evidence: PROBE_EVIDENCE,
        limitation: "ERCOT only; it is not a global tariff and does not include a site's retail contract.",
      },
      {
        id: "pool_concentration",
        label: "Pool concentration",
        requirement: "Which pools control the hashrate, and how concentrated is a fleet's dependency on them?",
        status: "gap",
        missingReason: "The catalogue has no pool-share or block-producer attribution intent. Hashing a guess from general mining intents would fabricate the answer.",
      },
      {
        id: "fleet_uptime",
        label: "Fleet uptime and efficiency",
        requirement: "How does reported fleet output compare with nameplate capacity and implied uptime?",
        status: "gap",
        missingReason: "No verified facility/fleet telemetry route was found for a specific operator. Data-centre telemetry intents exist, but none accepted a facility, operator or machine identifier with a purpose-built schema.",
      },
    ],
    plan: plan(
      ["hashprice_network", "btc_price", "energy_price"],
      [
        { dimension: "hashprice_network", requires: ["block height (from the investigation window)"] },
        { dimension: "btc_price", requires: ["asset symbol"] },
        { dimension: "energy_price", requires: ["declared ERCOT node or zone", "declared settlement interval"] },
      ],
      ["pool share / block-producer attribution", "operator fleet uptime and efficiency"],
    ),
  },

  "index-reconstitution-desk": {
    slug: "index-reconstitution-desk",
    readiness: "operational",
    dimensions: [
      {
        id: "registry",
        label: "Issuer registry record",
        requirement: "Is the issuer a real, active legal entity in the stated jurisdiction?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Tesla, Inc.", "US"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "integration_verified",
        output: "Registry facts for the issuer, with missing fields and conflicts preserved.",
        evidence: INTEGRATION_EVIDENCE,
      },
      {
        id: "price",
        label: "USD price",
        requirement: "What is the network-verified USD price of the asset?",
        status: "verified",
        intent: "CRYPTO_PRICE_USD",
        provider: "cp-coinbase",
        params: { symbol: { type: "string", required: true, description: "Asset ticker", sample: "BTC" } },
        responseFields: ["price_usd"],
        priceUsdCents: 1,
        verification: "integration_verified",
        output: "USD price used for market-cap weighting, never a declared substitute.",
        evidence: INTEGRATION_EVIDENCE,
      },
      {
        id: "supply",
        label: "Total supply",
        requirement: "What is the verified total token supply?",
        status: "verified",
        intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL",
        provider: "verifywire-token-total-supply",
        params: { token: { type: "string", required: true, description: "Symbol or contract address", sample: "BTC" } },
        responseFields: ["total_supply"],
        priceUsdCents: 1,
        verification: "integration_verified",
        output: "Total supply with the provider and signal recorded.",
        evidence: INTEGRATION_EVIDENCE,
        limitation: "Total supply is not circulating float, which has no network intent and remains a declared input.",
      },
      {
        id: "liquidity",
        label: "DEX pool liquidity",
        requirement: "How deep is the declared pool?",
        status: "verified",
        intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL",
        provider: "verifywire-liquidity-depth",
        params: {
          pool: { type: "string", required: true, description: "DEX pool address or name", sample: "USDC/ETH 0.05%" },
          chain: { type: "string", required: true, description: "Chain", sample: "ethereum" },
        },
        responseFields: ["liquidity_usd"],
        priceUsdCents: 1,
        verification: "integration_verified",
        output: "Pool depth, used for the concentration and liquidity checks.",
        evidence: INTEGRATION_EVIDENCE,
        limitation: "Only askable when the definition declares a pool.",
      },
      {
        id: "holders",
        label: "Holder count",
        requirement: "How many holders does the token have?",
        status: "verified",
        intent: "TOKEN_HOLDER_COUNT_GENERAL",
        provider: "router",
        params: {
          token: { type: "string", required: true, description: "Symbol or contract address", sample: "USDC" },
          chain: { type: "string", required: true, description: "Chain", sample: "ethereum" },
        },
        responseFields: ["holders_count", "token_symbol"],
        priceUsdCents: 1,
        verification: "integration_verified",
        output: "Holder count, routed by the node because the purpose-named miner cannot build the canonical input.",
        evidence: INTEGRATION_EVIDENCE,
      },
      {
        id: "filings",
        label: "Regulatory filings (12m)",
        requirement: "What has the issuer filed in the last twelve months?",
        status: "verified",
        intent: "REGULATORY_FILING_MONITOR_GENERAL",
        provider: "verireceipt",
        params: {
          entity: { type: "string", required: true, description: "Legal entity", sample: "Tesla, Inc." },
          period: { type: "string", required: true, description: "Period, e.g. last 12 months", sample: "last 12 months" },
        },
        responseFields: ["filing_count", "filings", "urls"],
        priceUsdCents: 1,
        verification: "integration_verified",
        output: "Filing count and source URLs.",
        evidence: INTEGRATION_EVIDENCE,
      },
    ],
    plan: plan(
      ["registry", "price", "supply", "liquidity", "holders", "filings"],
      [
        { dimension: "registry", requires: ["issuer legal name", "issuer jurisdiction"] },
        { dimension: "price", requires: ["asset symbol"] },
        { dimension: "supply", requires: ["asset symbol or contract"] },
        { dimension: "liquidity", requires: ["declared DEX pool", "chain"] },
        { dimension: "holders", requires: ["asset symbol or contract", "chain"] },
        { dimension: "filings", requires: ["issuer legal name"] },
      ],
      ["circulating float and trading volume (declared-only inputs)", "rebalance execution"],
    ),
  },

  "counterparty-intelligence": {
    slug: "counterparty-intelligence",
    readiness: "operational",
    dimensions: [
      {
        id: "registry",
        label: "Corporate registry record",
        requirement: "Who is this counterparty, and is it active?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Tesla, Inc.", "US"),
        responseFields: ["legal_name", "registration_id", "lei", "active", "jurisdiction", "registered_address", "incorporated", "legal_form"],
        priceUsdCents: 1,
        verification: "integration_verified",
        output: "Verified facts, missing fields and conflicts for one legal entity.",
        evidence: INTEGRATION_EVIDENCE,
      },
      {
        id: "group_structure",
        label: "Group structure",
        requirement: "What owns this entity, and what does it own?",
        status: "gap",
        missingReason: "No beneficial-ownership or group-traversal intent was verified. Single-entity resolution is what the live tool actually does.",
      },
    ],
    plan: plan(
      ["registry"],
      [{ dimension: "registry", requires: ["company legal name", "jurisdiction (optional but required by the registry schema for routing)"] }],
      ["group and beneficial-ownership traversal", "legal opinion"],
    ),
  },

  portsentinel: {
    slug: "portsentinel",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "port_congestion",
        label: "Port congestion",
        requirement: "How congested is the port, how many vessels are waiting, and for how long?",
        status: "verified",
        intent: "LIVE_PORT_CONGESTION_GENERAL",
        provider: "quay-ais",
        params: { port: { type: "string", required: true, description: "Port name or UN/LOCODE", sample: "Rotterdam" } },
        responseFields: ["port", "vessels_waiting", "wait_hours", "congestion_level", "as_of"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Waiting vessels, wait hours, congestion level and observation time.",
        evidence: PROBE_EVIDENCE,
        limitation: "A port-level snapshot, not a berth or terminal schedule.",
      },
      {
        id: "vessel_telemetry",
        label: "Vessel telemetry",
        requirement: "Where is the vessel, how fast is it moving and what course is it on?",
        status: "verified",
        intent: "VESSEL_TELEMETRY_VERIFY_GENERAL",
        provider: "vesselwire-vessel-telemetry-verify",
        params: { vessel: { type: "string", required: true, description: "Ship name, MMSI or IMO", sample: "MSC ISABELLA" } },
        responseFields: ["vessel", "speed_knots", "latitude", "longitude", "course_deg", "observed_at"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A position, speed, course and observation timestamp for the vessel.",
        evidence: PROBE_EVIDENCE,
        limitation: "AIS coverage gaps are provider coverage gaps; no position is invented.",
      },
      {
        id: "counterparty_registry",
        label: "Carrier / terminal operator identity",
        requirement: "Which legal entity operates the carrier or terminal, and is it active?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Maersk", "DK"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Registered identity and status of a carrier or terminal operator.",
        evidence: PROBE_EVIDENCE,
        limitation: "Resolves one entity; it does not prove which terminal or vessel it controls.",
      },
      {
        id: "ship_rate",
        label: "Shipment rate and transit",
        requirement: "What would it cost and how long would it take to move this consignment?",
        status: "verified",
        intent: "SHIP_RATE_ETA_GENERAL",
        provider: "zk-shipask",
        params: {
          origin: { type: "string", required: true, description: "Origin", sample: "Rotterdam" },
          destination: { type: "string", required: true, description: "Destination", sample: "Singapore" },
          weight_kg: { type: "number", required: true, description: "Consignment weight in kg", sample: 12000 },
        },
        responseFields: ["carrier", "rate", "currency", "transit_days", "eta"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A carrier quote, currency, transit days and ETA.",
        evidence: PROBE_EVIDENCE,
        limitation: "Quotes are estimates; no booking or capacity is reserved.",
      },
      {
        id: "carrier_scope",
        label: "Carrier serviceability",
        requirement: "Which services does the carrier actually offer into this area?",
        status: "partial",
        intent: "CARRIER_SERVICEABILITY_GENERAL",
        provider: "zk-carr-scope",
        params: {
          carrier: { type: "string", required: true, description: "Carrier name", sample: "Maersk" },
          area: { type: "string", required: true, description: "Service area", sample: "Rotterdam" },
        },
        responseFields: ["carrier", "area", "serviceable", "services"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A serviceability verdict and the services found for the area.",
        evidence: PROBE_EVIDENCE,
        limitation: "The verified schema is carrier/area serviceability; it may reflect postal or general coverage rather than a maritime schedule.",
      },
      {
        id: "storm_risk",
        label: "Storm disruption risk",
        requirement: "Is weather likely to disrupt the port or route in the next window?",
        status: "verified",
        intent: "STORM_ALERT_GENERAL",
        provider: "a1-preflight",
        params: {
          location: { type: "string", required: true, description: "Location", sample: "Rotterdam" },
          window_hours: { type: "integer", required: false, description: "Forecast window in hours", sample: 48 },
        },
        responseFields: ["location", "risk_score", "risk_level", "peak_gust_kmh", "precipitation_mm", "window"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A bounded weather risk score and the underlying gust/precipitation values.",
        evidence: PROBE_EVIDENCE,
        limitation: "Weather risk is not a port closure notice.",
      },
      {
        id: "route_eta",
        label: "Route ETA",
        requirement: "How long does the port-to-port leg take?",
        status: "partial",
        intent: "ROUTE_ETA_GENERAL",
        provider: "a1-preflight",
        params: {
          origin: { type: "string", required: true, description: "Origin", sample: "Rotterdam" },
          destination: { type: "string", required: true, description: "Destination", sample: "Singapore" },
        },
        responseFields: ["duration"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A routing duration for the requested endpoints.",
        evidence: PROBE_EVIDENCE,
        limitation: "The verified route intent is a generic routing engine; its default mode may be road, so modal assumptions must be checked before it is presented as a maritime ETA.",
      },
      {
        id: "terminal_schedule",
        label: "Terminal and berth schedules",
        requirement: "When is the berth available, and which terminal call is at risk?",
        status: "gap",
        missingReason: "No terminal-berth or port-call schedule intent was found; congestion and vessel position are not substitutes.",
      },
    ],
    plan: plan(
      ["port_congestion", "vessel_telemetry", "counterparty_registry", "ship_rate", "carrier_scope", "storm_risk", "route_eta"],
      [
        { dimension: "port_congestion", requires: ["port name or UN/LOCODE"] },
        { dimension: "vessel_telemetry", requires: ["vessel name / MMSI / IMO"] },
        { dimension: "counterparty_registry", requires: ["carrier / terminal operator legal name", "jurisdiction"] },
        { dimension: "ship_rate", requires: ["origin", "destination", "weight_kg"] },
        { dimension: "carrier_scope", requires: ["carrier", "area"] },
        { dimension: "storm_risk", requires: ["location"] },
        { dimension: "route_eta", requires: ["origin", "destination"] },
      ],
      ["terminal berth schedules", "container-level status", "customs clearance"],
    ),
  },

  minewatch: {
    slug: "minewatch",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "owner_registry",
        label: "Owner registry record",
        requirement: "Which legal entity owns the asset, and is it active?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("BHP Group", "AU"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "The registered identity of the operating company.",
        evidence: PROBE_EVIDENCE,
        limitation: "Registry identity is not the asset's ownership chain; the site-to-entity link must be supplied.",
      },
      {
        id: "regulatory_filings",
        label: "Regulatory filings",
        requirement: "What has the operator disclosed in the period?",
        status: "verified",
        intent: "REGULATORY_FILING_MONITOR_GENERAL",
        provider: "verireceipt",
        params: {
          entity: { type: "string", required: true, description: "Company or concern", sample: "BHP Group" },
          period: { type: "string", required: true, description: "Period", sample: "last 12 months" },
        },
        responseFields: ["filing_count", "filings", "urls"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Filing count and links for the period.",
        evidence: PROBE_EVIDENCE,
        limitation: "Filings are not a cadastre or licence register.",
      },
      {
        id: "operator_sanctions",
        label: "Operator sanctions check",
        requirement: "Is the operator or a named controller on a sanctions list?",
        status: "verified",
        intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
        provider: "zk-sanctions",
        params: { name: { type: "string", required: true, description: "Person or entity name", sample: "BHP Group" } },
        responseFields: ["name", "matched", "matches", "lists", "match_score"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Match verdict, entries, lists and score for the operator or controller.",
        evidence: PROBE_EVIDENCE,
        limitation: "Name matching is probabilistic and does not establish beneficial ownership.",
      },
      {
        id: "adverse_media",
        label: "Adverse media and incidents",
        requirement: "What incidents, disputes or adverse coverage surround the operator?",
        status: "partial",
        intent: "NEWS_SEARCH_GENERAL",
        provider: "tacitum-adverse-media",
        params: { query: { type: "string", required: true, description: "Adverse-media search", sample: "BHP Group environmental incident" } },
        responseFields: ["answer", "result_count", "sources", "brief"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Search results and sources for the query.",
        evidence: PROBE_EVIDENCE,
        limitation: "General news search through an adverse-media provider; it is not a sanctions list or a court record.",
      },
      {
        id: "production",
        label: "Production volumes",
        requirement: "What did the asset actually produce, and how did it compare with guidance?",
        status: "gap",
        missingReason: "No mining production, guidance or reserve intent was found in the catalogue.",
      },
      {
        id: "licences",
        label: "Licences and tenure",
        requirement: "Is the mining licence valid, and when does it expire?",
        status: "gap",
        missingReason: "No cadastre or mining-licence intent was verified; a general registry lookup does not answer tenure.",
      },
    ],
    plan: plan(
      ["owner_registry", "regulatory_filings", "operator_sanctions", "adverse_media"],
      [
        { dimension: "owner_registry", requires: ["site-to-operator mapping", "jurisdiction"] },
        { dimension: "regulatory_filings", requires: ["operator legal name", "period"] },
        { dimension: "operator_sanctions", requires: ["operator / controller name"] },
        { dimension: "adverse_media", requires: ["operator name", "focus terms"] },
      ],
      ["production volumes and guidance", "licence status and expiry"],
    ),
  },

  chainforensics: {
    slug: "chainforensics",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "tx_lookup",
        label: "Transaction lookup",
        requirement: "What did this transaction do, and did it succeed?",
        status: "verified",
        intent: "ONCHAIN_TX_LOOKUP_GENERAL",
        provider: "zk-txread",
        params: {
          tx_hash: { type: "string", required: true, description: "0x-prefixed transaction hash", sample: "0x45bc185bc34ed246f341a09812bb3c95b2a4d0e78699b585820fca9c323d9aed" },
          chain: { type: "string", required: true, description: "Chain", sample: "base" },
        },
        responseFields: ["tx_hash", "status", "from", "to", "block_number", "value_eth"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Status, parties, block and value for the transaction.",
        evidence: PROBE_EVIDENCE,
      },
      {
        id: "wallet_balance",
        label: "Wallet balance",
        requirement: "What does this address hold on the stated chain?",
        status: "verified",
        intent: "WALLET_BALANCE_CHECK_GENERAL",
        provider: "a1-preflight",
        params: {
          address: { type: "string", required: true, description: "Address", sample: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001" },
          chain: { type: "string", required: true, description: "Chain", sample: "base" },
        },
        responseFields: ["address", "chain", "balance", "token_symbol", "as_of"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Native balance and asset symbol at an observation time.",
        evidence: PROBE_EVIDENCE,
        limitation: "A token balance needs the optional token parameter; this probe verified the native path.",
      },
      {
        id: "tx_risk",
        label: "Transaction risk",
        requirement: "Does this transaction carry fraud or sanctions-linked risk signals?",
        status: "verified",
        intent: "TRANSACTION_RISK_GENERAL",
        provider: "a1-preflight",
        params: { transaction: { type: "string", required: true, description: "Transaction hash", sample: "0x45bc185bc34ed246f341a09812bb3c95b2a4d0e78699b585820fca9c323d9aed" } },
        responseFields: ["risk_level", "risk_score", "signals", "summary"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A risk level, score, signals and summary.",
        evidence: PROBE_EVIDENCE,
        limitation: "A risk score is a provider judgment, not an attribution of identity.",
      },
      {
        id: "onchain_metric",
        label: "On-chain account metric",
        requirement: "What does the account's on-chain record say at a specific block?",
        status: "verified",
        intent: "ONCHAIN_METRIC_VERIFY_GENERAL",
        provider: "onchain-metric-publicnode",
        params: {
          address: { type: "string", required: true, description: "Address", sample: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001" },
          block: { type: "integer", required: true, description: "Block number", sample: 23000000 },
          chain: { type: "string", required: false, description: "Chain", sample: "ethereum" },
        },
        responseFields: ["balance_gwei", "address", "block", "chain", "tx_count"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Balance and transaction count at the pinned block.",
        evidence: PROBE_EVIDENCE,
      },
      {
        id: "holder_concentration",
        label: "Holder concentration",
        requirement: "How concentrated is token ownership?",
        status: "partial",
        intent: "TOKEN_HOLDER_COUNT_GENERAL",
        provider: "txlens",
        params: {
          token: { type: "string", required: true, description: "Symbol or contract", sample: "USDC" },
          chain: { type: "string", required: true, description: "Chain", sample: "ethereum" },
        },
        responseFields: ["holders_count", "token_symbol", "chain"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Holder count; concentration ratios require holder distribution, which the verified schema does not promise.",
        evidence: PROBE_EVIDENCE,
        limitation: "The canonical answer is a holder count, not a top-holder distribution; the purpose-named miner was not used.",
      },
      {
        id: "wash_trading",
        label: "Wash trading",
        requirement: "Does this market show wash-trading patterns?",
        status: "verified",
        intent: "WASH_TRADING_DETECTION_GENERAL",
        provider: "chainsight-oracle",
        params: { subject: { type: "string", required: true, description: "Market or subject", sample: "Uniswap USDC/ETH" } },
        responseFields: ["subject", "verdict", "wash_volume_pct", "signals", "summary"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A verdict, estimated wash volume percentage, signals and summary.",
        evidence: PROBE_EVIDENCE,
        limitation: "A heuristic provider verdict; not proof of intent.",
      },
      {
        id: "fund_flow_tracing",
        label: "Fund-flow tracing",
        requirement: "Where did the funds go across hops, bridges and exchanges?",
        status: "gap",
        missingReason: "No verified multi-hop tracing intent was found. A single transaction lookup is not a fund-flow trace, so the path is not assembled from guesses.",
      },
      {
        id: "clustering_labels",
        label: "Wallet clustering and attribution",
        requirement: "Which addresses are controlled by one party, and who is that party?",
        status: "gap",
        missingReason: "No verified clustering or address-labelling intent was found. A transaction or balance answer cannot substitute for attribution.",
      },
    ],
    plan: plan(
      ["tx_lookup", "wallet_balance", "tx_risk", "onchain_metric", "holder_concentration", "wash_trading"],
      [
        { dimension: "tx_lookup", requires: ["transaction hash", "chain"] },
        { dimension: "wallet_balance", requires: ["address", "chain"] },
        { dimension: "tx_risk", requires: ["transaction hash"] },
        { dimension: "onchain_metric", requires: ["address", "block"] },
        { dimension: "holder_concentration", requires: ["token", "chain"] },
        { dimension: "wash_trading", requires: ["market or subject"] },
      ],
      ["multi-hop fund-flow tracing", "wallet clustering", "address attribution / identity", "cross-chain bridge tracing"],
    ),
  },

  ownershipgraph: {
    slug: "ownershipgraph",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "entity_registry",
        label: "Entity registry record",
        requirement: "What is the legal identity and status of this entity?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Tesla, Inc.", "US"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Registry identity, status and address for one entity.",
        evidence: PROBE_EVIDENCE,
        limitation: "One entity per ask; it does not return parent or subsidiaries.",
      },
      {
        id: "b2b_enrichment",
        label: "Firmographic enrichment",
        requirement: "What domain, industry, headcount and headquarters describe the company?",
        status: "partial",
        intent: "B2B_IDENTITY_ENRICHMENT_GENERAL",
        provider: "txlens",
        params: { company: { type: "string", required: true, description: "Company name", sample: "Tesla, Inc." } },
        responseFields: ["company", "domain", "employee_count", "industry", "headquarters"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Firmographic fields for the company.",
        evidence: PROBE_EVIDENCE,
        limitation: "The pinned provider is a multi-intent aggregator; firmographic accuracy and coverage are not verified until a paid answer is reconciled.",
      },
      {
        id: "sanctions_check",
        label: "Related-party sanctions check",
        requirement: "Is a named controller or related party on a sanctions list?",
        status: "verified",
        intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
        provider: "zk-sanctions",
        params: { name: { type: "string", required: true, description: "Person or entity name", sample: "Viktor Vekselberg" } },
        responseFields: ["name", "matched", "matches", "lists", "match_score"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Match verdict, matched entries, list names and score.",
        evidence: PROBE_EVIDENCE,
        limitation: "A name screen is probabilistic; it does not establish control or ownership.",
      },
      {
        id: "filings",
        label: "Group filings",
        requirement: "What has the group disclosed in the period?",
        status: "verified",
        intent: "REGULATORY_FILING_MONITOR_GENERAL",
        provider: "verireceipt",
        params: {
          entity: { type: "string", required: true, description: "Entity", sample: "Tesla, Inc." },
          period: { type: "string", required: true, description: "Period", sample: "last 12 months" },
        },
        responseFields: ["filing_count", "filings", "urls"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Filing count and links.",
        evidence: PROBE_EVIDENCE,
      },
      {
        id: "vendor_identity",
        label: "VAT / vendor identity",
        requirement: "Does the vendor's VAT identity match the registered entity?",
        status: "verified",
        intent: "VENDOR_VERIFY_GENERAL",
        provider: "a1-preflight",
        params: {
          vendor: { type: "string", required: true, description: "Vendor name", sample: "Siemens AG" },
          vat_number: { type: "string", required: true, description: "VAT number", sample: "DE129273398" },
        },
        responseFields: ["vendor", "vat_number", "valid", "registered_name", "registered_address"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "VAT validity and the registered name/address.",
        evidence: PROBE_EVIDENCE,
        limitation: "A VAT check verifies a tax identity, not beneficial ownership.",
      },
      {
        id: "beneficial_ownership",
        label: "Beneficial ownership and group graph",
        requirement: "Who ultimately owns and controls this entity, and what else do they control?",
        status: "gap",
        missingReason: "No beneficial-ownership, director, or shareholding intent was verified. This is the Mind's core claim, so it cannot be marked operational.",
      },
    ],
    plan: plan(
      ["entity_registry", "b2b_enrichment", "sanctions_check", "filings", "vendor_identity"],
      [
        { dimension: "entity_registry", requires: ["legal name", "jurisdiction"] },
        { dimension: "b2b_enrichment", requires: ["company name"] },
        { dimension: "sanctions_check", requires: ["controller / related-party name"] },
        { dimension: "filings", requires: ["entity name", "period"] },
        { dimension: "vendor_identity", requires: ["vendor name", "VAT number"] },
      ],
      ["beneficial-ownership traversal", "parent/subsidiary graph", "shared-director analysis"],
    ),
  },

  tradeverify: {
    slug: "tradeverify",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "po_verify",
        label: "Purchase order",
        requirement: "Is the purchase order real, and does it match the vendor and amount?",
        status: "verified",
        intent: "PURCHASE_ORDER_VERIFY_GENERAL",
        provider: "a1-preflight",
        params: {
          po_number: { type: "string", required: true, description: "PO number", sample: "PO-2026-1042" },
          vendor: { type: "string", required: true, description: "Vendor", sample: "Siemens AG" },
        },
        responseFields: ["po_number", "verified", "status", "amount", "vendor"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Verification verdict, status, amount and vendor.",
        evidence: PROBE_EVIDENCE,
        limitation: "A source-system record is required for a meaningful answer; the routing is verified, not the data coverage.",
      },
      {
        id: "invoice_reconcile",
        label: "Invoice vs ledger",
        requirement: "Does the invoice reconcile with the ledger, and where is the discrepancy?",
        status: "verified",
        intent: "INVOICE_LEDGER_RECONCILE_GENERAL",
        provider: "tradewire-invoice-ledger-reconcile",
        params: {
          invoice: { type: "string", required: true, description: "Invoice reference or document", sample: "INV-2026-1042" },
          ledger: { type: "string", required: true, description: "Ledger record", sample: "INV-2026-1042 12000 USD" },
        },
        responseFields: ["reconciled", "discrepancy", "explanation"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Reconciliation verdict, discrepancy and explanation.",
        evidence: PROBE_EVIDENCE,
      },
      {
        id: "commerce_verify",
        label: "Commerce order",
        requirement: "Is the merchant order real, and what is its status and amount?",
        status: "verified",
        intent: "COMMERCE_PURCHASE_VERIFY_GENERAL",
        provider: "zk-fultonpay",
        params: {
          order_id: { type: "string", required: true, description: "Order ID", sample: "ORD-2026-1042" },
          merchant: { type: "string", required: true, description: "Merchant", sample: "Shopify" },
        },
        responseFields: ["order_id", "verified", "status", "amount", "currency"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Order verification, status, amount and currency.",
        evidence: PROBE_EVIDENCE,
        limitation: "Merchant coverage varies; the verified schema is specific to supported merchants.",
      },
      {
        id: "counterparty_registry",
        label: "Trade counterparty identity",
        requirement: "Which legal entity is the buyer, seller or carrier?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Siemens AG", "DE"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Registered identity and status of a trade counterparty.",
        evidence: PROBE_EVIDENCE,
        limitation: "Resolves one entity; it does not confirm that the entity is the party on a specific document.",
      },
      {
        id: "delivery_window",
        label: "Delivery window",
        requirement: "What transit window should be expected for this carrier and route?",
        status: "verified",
        intent: "DELIVERY_WINDOW_VERIFY_GENERAL",
        provider: "a1-preflight",
        params: {
          carrier: { type: "string", required: true, description: "Carrier", sample: "UPS" },
          route: { type: "string", required: true, description: "Route", sample: "Rotterdam-Singapore" },
        },
        responseFields: ["carrier", "transit_days_max", "transit_days_min", "route", "is_estimate"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Minimum/maximum transit days and whether the answer is an estimate.",
        evidence: PROBE_EVIDENCE,
        limitation: "A planning estimate, not a guaranteed delivery commitment.",
      },
      {
        id: "package_status",
        label: "Package status",
        requirement: "Where is the consignment now, and has it been delivered?",
        status: "partial",
        intent: "PACKAGE_STATUS_GENERAL",
        provider: "txlens",
        params: {
          tracking_number: { type: "string", required: true, description: "Tracking number", sample: "1Z999AA10123456784" },
          carrier: { type: "string", required: true, description: "Carrier", sample: "UPS" },
        },
        responseFields: ["tracking_number", "carrier", "status", "delivered", "last_location", "last_update"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Status, delivery flag, last location and update time.",
        evidence: PROBE_EVIDENCE,
        limitation: "The pinned provider is an aggregator; carrier-specific tracking coverage is not verified until a paid answer is reconciled.",
      },
      {
        id: "documents",
        label: "Bills of lading and cargo documents",
        requirement: "Do the invoice, bill of lading and certificate fields agree?",
        status: "gap",
        missingReason: "No bill-of-lading or trade-document parsing intent was verified. Document authenticity exists for CaseLedger, but it does not extract cargo fields.",
      },
    ],
    plan: plan(
      ["po_verify", "invoice_reconcile", "commerce_verify", "counterparty_registry", "delivery_window", "package_status"],
      [
        { dimension: "po_verify", requires: ["PO number", "vendor"] },
        { dimension: "invoice_reconcile", requires: ["invoice reference/document", "ledger record"] },
        { dimension: "commerce_verify", requires: ["order ID", "merchant"] },
        { dimension: "counterparty_registry", requires: ["buyer/seller/carrier legal name", "jurisdiction"] },
        { dimension: "delivery_window", requires: ["carrier", "route"] },
        { dimension: "package_status", requires: ["tracking number", "carrier"] },
      ],
      ["bill-of-lading / cargo-document extraction", "customs declarations", "document-to-document discrepancy rules"],
    ),
  },

  sanctionsdesk: {
    slug: "sanctionsdesk",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "name_screening",
        label: "Name screening",
        requirement: "Is this person or entity on a sanctions list?",
        status: "verified",
        intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
        provider: "zk-sanctions",
        params: { name: { type: "string", required: true, description: "Person or entity name", sample: "Viktor Vekselberg" } },
        responseFields: ["name", "matched", "matches", "lists", "match_score"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Match verdict, matched entries, list names and score.",
        evidence: PROBE_EVIDENCE,
        limitation: "Name matching is probabilistic; aliases and transliterations affect recall.",
      },
      {
        id: "entity_registry",
        label: "Entity identity",
        requirement: "Is the screened entity real, active and in the stated jurisdiction?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Tesla, Inc.", "US"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Registered identity and status, used to disambiguate a hit.",
        evidence: PROBE_EVIDENCE,
      },
      {
        id: "b2b_enrichment",
        label: "Entity enrichment",
        requirement: "What firmographic context distinguishes this entity from a same-name party?",
        status: "partial",
        intent: "B2B_IDENTITY_ENRICHMENT_GENERAL",
        provider: "txlens",
        params: { company: { type: "string", required: true, description: "Company name", sample: "Tesla, Inc." } },
        responseFields: ["company", "domain", "employee_count", "industry", "headquarters"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Domain, industry, headcount and headquarters.",
        evidence: PROBE_EVIDENCE,
        limitation: "Aggregator provider; disambiguation quality is not verified until a paid answer is reconciled.",
      },
      {
        id: "vessel_screening",
        label: "Vessel name screening",
        requirement: "Is this vessel or its operator linked to a listed party?",
        status: "partial",
        intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
        provider: "zk-sanctions",
        params: { name: { type: "string", required: true, description: "Vessel name (name screen only)", sample: "MSC ISABELLA" } },
        responseFields: ["name", "matched", "matches", "lists", "match_score"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A name match for the vessel string.",
        evidence: PROBE_EVIDENCE,
        limitation: "Name-based only. No IMO/MMSI identifier match or ownership link is verified, so this is not a vessel sanctions screen.",
      },
      {
        id: "related_parties",
        label: "Related-party and ownership exposure",
        requirement: "Which parents, subsidiaries or controllers connect the subject to a listed party?",
        status: "gap",
        missingReason: "No ownership-graph intent is verified. SanctionsDesk cannot claim network exposure analysis without it.",
      },
    ],
    plan: plan(
      ["name_screening", "entity_registry", "b2b_enrichment", "vessel_screening"],
      [
        { dimension: "name_screening", requires: ["person/entity name"] },
        { dimension: "entity_registry", requires: ["legal name", "jurisdiction"] },
        { dimension: "b2b_enrichment", requires: ["company name"] },
        { dimension: "vessel_screening", requires: ["vessel name or IMO"] },
      ],
      ["IMO/MMSI-based vessel screening", "beneficial-ownership exposure", "list entry retrieval as a primary source"],
    ),
  },

  caseledger: {
    slug: "caseledger",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "party_registry",
        label: "Party identity",
        requirement: "Which legal entity is the named party, and is it active?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Tesla, Inc.", "US"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Registered identity and status for a party to the matter.",
        evidence: PROBE_EVIDENCE,
        limitation: "Resolves one legal entity; it does not search court records or name variations across registries.",
      },
      {
        id: "regulatory_filings",
        label: "Regulatory and public filings",
        requirement: "What has the party disclosed in the period?",
        status: "verified",
        intent: "REGULATORY_FILING_MONITOR_GENERAL",
        provider: "verireceipt",
        params: {
          entity: { type: "string", required: true, description: "Entity", sample: "Tesla, Inc." },
          period: { type: "string", required: true, description: "Period", sample: "last 12 months" },
        },
        responseFields: ["filing_count", "filings", "urls"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Filing count and source URLs.",
        evidence: PROBE_EVIDENCE,
        limitation: "Regulatory filings are not court dockets or judgments.",
      },
      {
        id: "adverse_media",
        label: "Dispute coverage",
        requirement: "What disputes or adverse coverage surround the party?",
        status: "partial",
        intent: "NEWS_SEARCH_GENERAL",
        provider: "tacitum-adverse-media",
        params: { query: { type: "string", required: true, description: "Adverse-media search", sample: "Tesla lawsuit settlement" } },
        responseFields: ["answer", "result_count", "sources", "brief"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "News results and sources, not a litigation docket.",
        evidence: PROBE_EVIDENCE,
        limitation: "Press coverage is not a court record and cannot establish the status of a matter.",
      },
      {
        id: "fact_check",
        label: "Claim verification",
        requirement: "Is a specific factual claim by a party supported?",
        status: "partial",
        intent: "FACT_CHECK_GENERAL",
        provider: "telegraph-intent-miner",
        params: { claim: { type: "string", required: true, description: "Claim to check", sample: "The court approved the settlement in November 2026." } },
        responseFields: ["claim", "verdict", "reasoning", "sources"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "A verdict with reasoning and sources.",
        evidence: PROBE_EVIDENCE,
        limitation: "Checks public support for a claim; it does not retrieve the court's own record.",
      },
      {
        id: "docket_retrieval",
        label: "Court dockets and judgments",
        requirement: "What is the procedural record, and what was the judgment or settlement?",
        status: "gap",
        missingReason: "No court-docket, judgment or settlement intent was verified. The Mind's own evidence chain is real (task history and signal hashes), but court records are not.",
      },
      {
        id: "jurisdiction_coverage",
        label: "Multi-jurisdiction case search",
        requirement: "Which courts and registries were actually searched?",
        status: "gap",
        missingReason: "There is no verified court-index intent, so jurisdiction coverage cannot be asserted. A gap in coverage must remain visible, not be described as 'no cases found'.",
      },
    ],
    plan: plan(
      ["party_registry", "regulatory_filings", "adverse_media", "fact_check"],
      [
        { dimension: "party_registry", requires: ["party legal name", "jurisdiction"] },
        { dimension: "regulatory_filings", requires: ["entity", "period"] },
        { dimension: "adverse_media", requires: ["party name", "dispute focus"] },
        { dimension: "fact_check", requires: ["one checkable claim"] },
      ],
      ["court dockets", "judgments and settlements", "sealed matters", "legal conclusions"],
    ),
  },

  energywatch: {
    slug: "energywatch",
    readiness: "partial_coverage",
    dimensions: [
      {
        id: "grid_price",
        label: "Grid power price",
        requirement: "What did power cost at this grid node for the interval?",
        status: "verified",
        intent: "GRID_POWER_PRICE_GENERAL",
        provider: "pecos-ercot",
        params: {
          node_or_zone: { type: "string", required: true, description: "ERCOT hub or zone", sample: "HB_WEST" },
          interval_start: { type: "datetime", required: true, description: "Settlement interval start", sample: "2026-11-23T00:00:00-06:00" },
        },
        responseFields: ["lmp_usd_per_mwh", "node_or_zone", "market", "interval_start", "currency"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Locational marginal price for the node and interval.",
        evidence: PROBE_EVIDENCE,
        limitation: "ERCOT only; no global coverage.",
      },
      {
        id: "storm_risk",
        label: "Storm risk",
        requirement: "Is a storm likely to disrupt operations in the next window?",
        status: "verified",
        intent: "STORM_ALERT_GENERAL",
        provider: "a1-preflight",
        params: {
          location: { type: "string", required: true, description: "Location", sample: "Houston, TX" },
          window_hours: { type: "integer", required: false, description: "Window", sample: 48 },
        },
        responseFields: ["location", "risk_score", "risk_level", "peak_gust_kmh", "precipitation_mm", "window"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Risk score and level with the underlying weather values.",
        evidence: PROBE_EVIDENCE,
      },
      {
        id: "current_temperature",
        label: "Current temperature",
        requirement: "What is the current temperature at the site?",
        status: "verified",
        intent: "WEATHER_CHECK_TEMPERATURE",
        provider: "isobar-weather",
        params: { location: { type: "string", required: true, description: "Location", sample: "Houston, TX" } },
        responseFields: ["temperature_c"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Current temperature in Celsius.",
        evidence: PROBE_EVIDENCE,
        limitation: "Ambient temperature is not facility cooling load.",
      },
      {
        id: "weather_history",
        label: "Weather verification",
        requirement: "What was the actual weather on a past date?",
        status: "verified",
        intent: "WEATHER_FORECAST_VERIFY_GENERAL",
        provider: "a1-preflight",
        params: {
          location: { type: "string", required: true, description: "Location", sample: "Houston, TX" },
          date: { type: "date", required: true, description: "Past date", sample: "2026-11-20" },
        },
        responseFields: ["location", "date", "temp_max_c", "temp_min_c", "precipitation_mm", "condition"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Observed high/low temperature, precipitation and condition for the date.",
        evidence: PROBE_EVIDENCE,
        limitation: "The intent is named forecast-verify but the verified route is a historical weather read; it does not forecast.",
      },
      {
        id: "operator_registry",
        label: "Operator identity",
        requirement: "Which legal entity operates the asset, and is it active?",
        status: "verified",
        intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
        provider: "zk-corp-atlas",
        params: registry("Duke Energy", "US"),
        responseFields: ["legal_name", "registration_id", "active", "jurisdiction", "registered_address", "incorporated"],
        priceUsdCents: 1,
        verification: "probe_verified",
        output: "Registered identity and status of the operator or offtaker.",
        evidence: PROBE_EVIDENCE,
        limitation: "Resolves one entity; it does not prove which subsidiary operates a specific asset.",
      },
      {
        id: "outages",
        label: "Outages and maintenance",
        requirement: "Is there an active outage, constraint or maintenance window?",
        status: "gap",
        missingReason: "No grid-outage, maintenance or force-majeure intent was verified. Storm risk is not an outage notice.",
      },
      {
        id: "production",
        label: "Production and capacity",
        requirement: "What is the asset's output against its stated capacity?",
        status: "gap",
        missingReason: "No energy production or capacity intent was verified in the catalogue.",
      },
      {
        id: "facility_telemetry",
        label: "Facility power and PUE",
        requirement: "What power draw, temperature and PUE is the facility actually reporting?",
        status: "gap",
        missingReason: "DATACENTER_TELEMETRY exposes a facility schema, but no provider was verified to accept a real facility identifier; probing it would only verify a generic route, not the telemetry.",
      },
    ],
    plan: plan(
      ["grid_price", "operator_registry", "storm_risk", "current_temperature", "weather_history"],
      [
        { dimension: "grid_price", requires: ["ERCOT node/zone", "settlement interval"] },
        { dimension: "operator_registry", requires: ["operator legal name", "jurisdiction"] },
        { dimension: "storm_risk", requires: ["location", "window_hours"] },
        { dimension: "current_temperature", requires: ["location"] },
        { dimension: "weather_history", requires: ["location", "past date"] },
      ],
      ["outage and maintenance notices", "production and capacity", "facility power, temperature and PUE"],
    ),
  },
};

/* ------------------------------------------------------------------ */
/* Derived views                                                       */
/* ------------------------------------------------------------------ */

export function capabilitiesFor(slug: string): MindCapabilities | undefined {
  return CAPABILITIES[slug];
}

export function verifiedDimensions(slug: string): CapabilityDimension[] {
  return (CAPABILITIES[slug]?.dimensions ?? []).filter((d) => d.status === "verified");
}

export function partialDimensions(slug: string): CapabilityDimension[] {
  return (CAPABILITIES[slug]?.dimensions ?? []).filter((d) => d.status === "partial");
}

export function gapDimensions(slug: string): CapabilityDimension[] {
  return (CAPABILITIES[slug]?.dimensions ?? []).filter((d) => d.status === "gap");
}

/**
 * Readiness is derived from the registry status, not from the matrix alone:
 * verified routes are not an executor. A Mind is operational only when the
 * registry says it has a live investigation path.
 */
export function readinessFor(slug: string, status: MindStatus): MindCapabilities["readiness"] {
  if (status === "available") return "operational";
  const dims = CAPABILITIES[slug]?.dimensions ?? [];
  if (dims.some((d) => d.status === "verified" || d.status === "partial")) return "partial_coverage";
  return "definition_only";
}

export const READINESS_LABEL: Record<MindCapabilities["readiness"], string> = {
  operational: "Operational",
  partial_coverage: "Partial coverage · no launch path",
  definition_only: "Definition only",
};

/** Dimensions that reuse the same Telegraph intent across Minds. */
export function sharedCapabilities(): Array<{ intent: string; minds: string[] }> {
  const byIntent = new Map<string, Set<string>>();
  for (const [slug, profile] of Object.entries(CAPABILITIES)) {
    for (const dim of profile.dimensions) {
      if (!dim.intent) continue;
      const set = byIntent.get(dim.intent) ?? new Set<string>();
      set.add(slug);
      byIntent.set(dim.intent, set);
    }
  }
  return [...byIntent.entries()]
    .filter(([, minds]) => minds.size > 1)
    .map(([intent, minds]) => ({ intent, minds: [...minds] }))
    .sort((a, b) => b.minds.length - a.minds.length);
}

/** Every distinct live-verified ask in the matrix. */
export function verifiedAskCount(): number {
  return Object.values(CAPABILITIES).reduce(
    (n, profile) =>
      n + profile.dimensions.filter((d) => d.verification === "probe_verified" || d.verification === "integration_verified").length,
    0,
  );
}
