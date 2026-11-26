/**
 * The three specialised Deal Desk workflows.
 *
 * Every capability below references an EXISTING dimension in the verified
 * Mind capability matrix (`src/lib/minds/capabilities.ts`) by mind slug and
 * dimension id — nothing here invents an intent, a provider or a price. The
 * resolver in this module throws at read time if a reference stops matching
 * the matrix, and the test suite pins every reference against the matrix.
 *
 * Unsupported requirements are first-class: each workflow declares the
 * matrix gaps that matter to it, with the matrix's own reason and
 * resolution, so a report can name what the network cannot answer instead
 * of approximating it with a loosely related intent.
 */

import { CAPABILITIES, type CapabilityDimension } from "@/lib/minds/capabilities";
import type { DeskInvestigationType } from "./types";

/** Reference to one verified matrix dimension. */
export interface DeskCapabilityRef {
  mind: string;
  dimension: string;
  /** Params built from the guided-form subject; returns null when the
   * required inputs were not supplied and the dimension cannot be asked. */
  params: (subject: Record<string, string>) => Record<string, unknown> | null;
  /** Optional extra gate beyond param completeness (e.g. asset class). */
  when?: (subject: Record<string, string>) => boolean;
}

export interface DeskField {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  /** Shown under the field. */
  help?: string;
  /** The human question this field answers. */
  question?: string;
  /** Capabilities that become askable when this field is filled. */
  unlocks?: string[];
}

export interface DeskWorkflowSection {
  id: string;
  title: string;
  description: string;
  /** Capability keys ("mind:dimension") grouped into this section. */
  capabilities: string[];
}

export interface DeskWorkflowDef {
  type: DeskInvestigationType;
  name: string;
  kicker: string;
  summary: string;
  /** What the workflow investigates, in one sentence. */
  scope: string;
  /** The human name of the subject of one file. */
  subjectNoun: string;
  fields: DeskField[];
  capabilities: DeskCapabilityRef[];
  /** Matrix gaps that matter to this workflow, by reference. */
  gapRefs: Array<{ mind: string; dimension: string }>;
  sections: DeskWorkflowSection[];
  /** Shown on the guided form before anything is planned. */
  honestyNotes: string[];
  /** One realistic worked example, field name → answer. Powers the guided
   * form's "Fill sample values" button so a reviewer can test the whole flow
   * without inventing data. Samples are examples, not verified facts — the
   * file records them as declared inputs exactly like any typed answer. */
  samples: Record<string, string>;
}

const PERIOD = "last 12 months";

function req(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : null;
}

/* ------------------------------------------------------------------ */
/* Counterparty Due Diligence — the reference implementation           */
/* ------------------------------------------------------------------ */

const COUNTERPARTY_WORKFLOW: DeskWorkflowDef = {
  type: "counterparty_due_diligence",
  name: "Counterparty Due Diligence",
  kicker: "Deal Desk · Counterparty",
  summary:
    "Who is this company in the official records — registry identity, commercial footprint, sanctions exposure, disclosed filings and adverse coverage — with every fact carrying its provenance.",
  scope: "One legal entity, resolved against registry, sanctions, filings and news sources.",
  subjectNoun: "counterparty",
  fields: [
    {
      name: "legalName",
      label: "Registered legal name",
      kind: "text",
      required: true,
      question: "Which company are you investigating?",
      placeholder: "e.g. Maersk A/S",
      help: "Use the name as it appears on the contract or invoice. The registry ask carries this name and the jurisdiction.",
    },
    {
      name: "jurisdiction",
      label: "Jurisdiction (ISO 3166 alpha-2)",
      kind: "text",
      required: true,
      question: "Where is it registered?",
      placeholder: "e.g. US, DE, SG",
      help: "The registry schema requires the jurisdiction for routing.",
    },
    {
      name: "registrationId",
      label: "Registration number or LEI (optional)",
      kind: "text",
      required: false,
      placeholder: "If you have one",
      help: "Recorded with the file as a declared identifier. The pinned registry route resolves the entity you name.",
    },
    {
      name: "vatNumber",
      label: "VAT number (optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. DE129273398",
      unlocks: ["VAT / vendor identity"],
      help: "Unlocks the VAT identity check: does the tax registration name and validate the entity you are investigating?",
    },
    {
      name: "controllerName",
      label: "Director, owner or controller to screen (optional)",
      kind: "text",
      required: false,
      placeholder: "One person or entity you know to own, direct or control the company",
      unlocks: ["Related-party sanctions check"],
      help: "The network screens the name you supply against sanctions lists. It cannot verify that the control relationship exists — that stays your declared input.",
    },
    {
      name: "role",
      label: "Your relationship (optional)",
      kind: "select",
      required: false,
      options: [
        { value: "customer", label: "Customer" },
        { value: "supplier", label: "Supplier" },
        { value: "investor", label: "Investor" },
        { value: "partner", label: "Partner" },
      ],
      help: "Framing only — it does not change what is verified.",
    },
    {
      name: "website",
      label: "Website or domain (optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. maersk.com",
      unlocks: ["Firmographic enrichment"],
      help: "The enrichment ask accepts a company name or a web domain; a domain disambiguates common names.",
    },
    {
      name: "claim",
      label: "Claim to verify (optional)",
      kind: "textarea",
      required: false,
      placeholder: "e.g. The company completed its 2025 audit without qualifications.",
      unlocks: ["Claim verification"],
      help: "One specific factual claim. The claim-check route reports public support for it, not a legal determination.",
    },
    {
      name: "spendLimitUsdCents",
      label: "Spend ceiling (USD cents)",
      kind: "number",
      required: false,
      placeholder: "10",
      help: "Maximum the paid run may draw from the payer wallet, in cents. Default 10 ($0.10).",
    },
  ],
  capabilities: [
    {
      mind: "counterparty-intelligence",
      dimension: "registry",
      params: (s) => {
        const company = req(s.legalName);
        const jurisdiction = req(s.jurisdiction);
        return company && jurisdiction ? { company, jurisdiction } : null;
      },
    },
    {
      mind: "ownershipgraph",
      dimension: "b2b_enrichment",
      params: (s) => {
        const company = req(s.website) ?? req(s.legalName);
        return company ? { company } : null;
      },
    },
    {
      mind: "ownershipgraph",
      dimension: "vendor_identity",
      params: (s) => {
        const vendor = req(s.legalName);
        const vat = req(s.vatNumber);
        return vendor && vat ? { vendor, vat_number: vat } : null;
      },
    },
    {
      // A named controller can be screened against sanctions lists. The
      // control relationship itself is declared, never verified — the matrix
      // has no ownership-graph intent (beneficial_ownership is a gap).
      mind: "ownershipgraph",
      dimension: "sanctions_check",
      params: (s) => {
        const name = req(s.controllerName);
        return name ? { name } : null;
      },
    },
    {
      mind: "sanctionsdesk",
      dimension: "name_screening",
      params: (s) => {
        const name = req(s.legalName);
        return name ? { name } : null;
      },
    },
    {
      mind: "ownershipgraph",
      dimension: "filings",
      params: (s) => {
        const entity = req(s.legalName);
        return entity ? { entity, period: PERIOD } : null;
      },
    },
    {
      mind: "caseledger",
      dimension: "adverse_media",
      params: (s) => {
        const name = req(s.legalName);
        return name ? { query: `${name} lawsuit OR dispute OR sanctions OR investigation` } : null;
      },
    },
    {
      mind: "caseledger",
      dimension: "fact_check",
      params: (s) => {
        const claim = req(s.claim);
        return claim ? { claim } : null;
      },
    },
  ],
  gapRefs: [
    { mind: "counterparty-intelligence", dimension: "group_structure" },
    { mind: "ownershipgraph", dimension: "beneficial_ownership" },
    { mind: "sanctionsdesk", dimension: "related_parties" },
    { mind: "caseledger", dimension: "docket_retrieval" },
    { mind: "caseledger", dimension: "jurisdiction_coverage" },
  ],
  sections: [
    {
      id: "registered_identity",
      title: "Registered identity",
      description: "The registry record: legal name, registration id, LEI, status, address and incorporation.",
      capabilities: ["counterparty-intelligence:registry"],
    },
    {
      id: "commercial_identity",
      title: "Commercial identity",
      description: "Firmographic fields — domain, industry, headcount, headquarters — from the enrichment provider.",
      capabilities: ["ownershipgraph:b2b_enrichment"],
    },
    {
      id: "related_party_tax_identity",
      title: "Related parties and tax identity",
      description:
        "The ownership-adjacent checks the network supports: sanctions screening of a named controller and VAT identity validation. Control and ownership graphs stay named gaps.",
      capabilities: ["ownershipgraph:sanctions_check", "ownershipgraph:vendor_identity"],
    },
    {
      id: "sanctions",
      title: "Sanctions screening",
      description: "Name screening against sanctions lists, with the match basis and score.",
      capabilities: ["sanctionsdesk:name_screening"],
    },
    {
      id: "filings",
      title: "Regulatory filings",
      description: "What the entity disclosed in the period, with source links.",
      capabilities: ["ownershipgraph:filings"],
    },
    {
      id: "adverse_coverage",
      title: "Adverse coverage",
      description: "Disputes, investigations and adverse press. Coverage is not a court record.",
      capabilities: ["caseledger:adverse_media"],
    },
    {
      id: "declared_claim",
      title: "Declared claim",
      description: "Public support for the specific claim you supplied, with sources.",
      capabilities: ["caseledger:fact_check"],
    },
  ],
  honestyNotes: [
    "Beneficial ownership, directors and group structure have no verified route on the network and are never inferred; a controller you name can be screened, but the control relationship itself stays a declared input.",
    "Court dockets and judgments are unsupported; adverse coverage is news search, not a case ledger.",
    "The name screen is probabilistic and is not a legal determination. A VAT check validates a tax identity, not beneficial ownership.",
  ],
  samples: {
    legalName: "Maersk A/S",
    jurisdiction: "DK",
    role: "supplier",
    website: "maersk.com",
    claim: "The company completed its 2025 audit without qualifications.",
    spendLimitUsdCents: "10",
  },
};

/* ------------------------------------------------------------------ */
/* Asset Intelligence                                                  */
/* ------------------------------------------------------------------ */

const ASSET_WORKFLOW: DeskWorkflowDef = {
  type: "asset_intelligence",
  name: "Asset Intelligence",
  kicker: "Deal Desk · Asset",
  summary:
    "What the network's own records say about an asset — on-chain transactions and balances, the issuer and token record, market context, the operating company behind a mine or grid node, and the environment around it.",
  scope: "Digital-asset addresses and tokens, mining operations, or energy sites.",
  subjectNoun: "asset",
  fields: [
    {
      name: "assetClass",
      label: "Asset class",
      kind: "select",
      required: true,
      options: [
        { value: "digital_asset", label: "Digital asset (address / token / transaction)" },
        { value: "mining", label: "Mining operation" },
        { value: "energy", label: "Energy site" },
      ],
      question: "What kind of asset?",
      help: "Selecting the class decides which verified routes the plan contains. Nothing outside the class is asked.",
    },
    {
      name: "assetName",
      label: "Asset label",
      kind: "text",
      required: true,
      question: "How do you refer to this asset?",
      placeholder: "e.g. Treasury wallet 0xabc…, Permian site 4",
      help: "Your label for the file; recorded verbatim as a declared input.",
    },
    {
      name: "chain",
      label: "Chain (digital asset, optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. base, ethereum",
      help: "Default base for transaction and balance reads.",
    },
    {
      name: "walletAddress",
      label: "Wallet or contract address (optional)",
      kind: "text",
      required: false,
      unlocks: ["Wallet balance", "On-chain account metric"],
      help: "Unlocks balance and account-metric reads on the stated chain.",
    },
    {
      name: "txHash",
      label: "Transaction hash (optional)",
      kind: "text",
      required: false,
      unlocks: ["Transaction lookup", "Transaction risk"],
      help: "Unlocks the transaction's record and its risk signals.",
    },
    {
      name: "blockNumber",
      label: "Block number (optional)",
      kind: "number",
      required: false,
      unlocks: ["On-chain account metric", "Hashprice and network hashrate"],
      help: "Pins account metrics and mining economics to a block.",
    },
    {
      name: "tokenSymbol",
      label: "Token symbol (optional)",
      kind: "text",
      required: false,
      unlocks: ["Holder concentration", "USD price", "Total supply", "Holder count"],
      help: "Unlocks holder concentration, the network-verified USD price, total supply and holder count for the token on the stated chain.",
    },
    {
      name: "issuerEntity",
      label: "Issuer legal name (token, optional)",
      kind: "text",
      required: false,
      unlocks: ["Issuer registry record", "Issuer regulatory filings"],
      help: "The legal entity that issued or promotes the token. Unlocks the issuer's registry record and filings.",
    },
    {
      name: "issuerJurisdiction",
      label: "Issuer jurisdiction (token, optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. US, SG",
      help: "ISO 3166 alpha-2; the issuer registry schema requires it.",
    },
    {
      name: "issuerWebsite",
      label: "Issuer website or domain (optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. issuer.example",
      unlocks: ["Issuer firmographic enrichment"],
      help: "Disambiguates the issuer and unlocks company enrichment.",
    },
    {
      name: "controllerName",
      label: "Named director or controller (optional)",
      kind: "text",
      required: false,
      placeholder: "A person or entity you want screened",
      unlocks: ["Controller sanctions screening"],
      help: "Screens the name you supply. It does not establish that the person controls the issuer.",
    },
    {
      name: "declaredSupply",
      label: "Stated total supply (optional)",
      kind: "text",
      required: false,
      placeholder: "As the issuer's materials state it, e.g. 1000000000",
      help: "What the issuer's own materials claim, recorded as a declared input and cross-checked against the network-verified total supply when that is askable.",
    },
    {
      name: "marketSubject",
      label: "Market or pool (optional)",
      kind: "text",
      required: false,
      unlocks: ["Wash trading"],
      help: "e.g. Uniswap USDC/ETH — the wash-trading route answers for a named market.",
    },
    {
      name: "operatorEntity",
      label: "Operating company (mining, optional)",
      kind: "text",
      required: false,
      unlocks: ["Owner registry record", "Regulatory filings", "Operator sanctions check", "Adverse media and incidents"],
      help: "The legal entity operating the asset; registry, filings and sanctions asks resolve it.",
    },
    {
      name: "jurisdiction",
      label: "Operator jurisdiction (mining, optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. AU, US",
      help: "ISO 3166 alpha-2; the registry schema requires it.",
    },
    {
      name: "gridNode",
      label: "Grid node or zone (mining / energy, optional)",
      kind: "text",
      required: false,
      unlocks: ["Grid power price"],
      help: "e.g. HB_WEST — ERCOT hubs and zones only.",
    },
    {
      name: "intervalStart",
      label: "Settlement interval start (mining / energy, optional)",
      kind: "text",
      required: false,
      placeholder: "2026-11-23T00:00:00-06:00",
      help: "RFC 3339 with timezone; paired with the grid node.",
    },
    {
      name: "siteLocation",
      label: "Site location (energy, optional)",
      kind: "text",
      required: false,
      unlocks: ["Current temperature", "Weather verification", "Storm risk"],
      help: "Unlocks weather reads and storm risk for the site.",
    },
    {
      name: "pastDate",
      label: "Past date for weather verification (optional)",
      kind: "text",
      required: false,
      placeholder: "2026-11-20",
      help: "Pairs with the site location.",
    },
    {
      name: "spendLimitUsdCents",
      label: "Spend ceiling (USD cents)",
      kind: "number",
      required: false,
      placeholder: "10",
      help: "Maximum the paid run may draw, in cents. Default 10 ($0.10).",
    },
  ],
  capabilities: [
    // Digital asset
    {
      mind: "chainforensics",
      dimension: "wallet_balance",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const address = req(s.walletAddress);
        return address ? { address, chain: req(s.chain) ?? "base" } : null;
      },
    },
    {
      mind: "chainforensics",
      dimension: "onchain_metric",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const address = req(s.walletAddress);
        const block = req(s.blockNumber);
        return address && block && Number.isFinite(Number(block)) ? { address, block: Number(block), chain: req(s.chain) ?? "ethereum" } : null;
      },
    },
    {
      mind: "chainforensics",
      dimension: "tx_lookup",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const tx = req(s.txHash);
        return tx ? { tx_hash: tx, chain: req(s.chain) ?? "base" } : null;
      },
    },
    {
      mind: "chainforensics",
      dimension: "tx_risk",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const tx = req(s.txHash);
        return tx ? { transaction: tx } : null;
      },
    },
    {
      mind: "chainforensics",
      dimension: "holder_concentration",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const token = req(s.tokenSymbol);
        return token ? { token, chain: req(s.chain) ?? "ethereum" } : null;
      },
    },
    {
      mind: "chainforensics",
      dimension: "wash_trading",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const subject = req(s.marketSubject);
        return subject ? { subject } : null;
      },
    },
    // Issuer and token record: the verified index-desk dimensions, planned
    // only when the class is digital and the token inputs were supplied.
    {
      mind: "index-reconstitution-desk",
      dimension: "registry",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const issuer = req(s.issuerEntity);
        const jurisdiction = req(s.issuerJurisdiction);
        return issuer && jurisdiction ? { company: issuer, jurisdiction } : null;
      },
    },
    {
      mind: "index-reconstitution-desk",
      dimension: "price",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const symbol = req(s.tokenSymbol);
        return symbol ? { symbol } : null;
      },
    },
    {
      mind: "index-reconstitution-desk",
      dimension: "supply",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const token = req(s.tokenSymbol);
        return token ? { token } : null;
      },
    },
    {
      mind: "index-reconstitution-desk",
      dimension: "holders",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const token = req(s.tokenSymbol);
        return token ? { token, chain: req(s.chain) ?? "ethereum" } : null;
      },
    },
    {
      mind: "index-reconstitution-desk",
      dimension: "liquidity",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const pool = req(s.marketSubject);
        return pool ? { pool, chain: req(s.chain) ?? "ethereum" } : null;
      },
    },
    {
      mind: "index-reconstitution-desk",
      dimension: "filings",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const issuer = req(s.issuerEntity);
        return issuer ? { entity: issuer, period: PERIOD } : null;
      },
    },
    // Existing issuer specialists extend IRD's token record. These routes
    // are probe-verified, so paid answers remain explicitly unproven until
    // their committed payloads are tested in a real investigation.
    {
      mind: "ownershipgraph",
      dimension: "b2b_enrichment",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const company = req(s.issuerEntity) ?? req(s.issuerWebsite);
        return company ? { company } : null;
      },
    },
    {
      mind: "sanctionsdesk",
      dimension: "name_screening",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const name = req(s.issuerEntity);
        return name ? { name } : null;
      },
    },
    {
      mind: "ownershipgraph",
      dimension: "sanctions_check",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const name = req(s.controllerName);
        return name ? { name } : null;
      },
    },
    {
      mind: "caseledger",
      dimension: "adverse_media",
      when: (s) => s.assetClass === "digital_asset",
      params: (s) => {
        const issuer = req(s.issuerEntity);
        return issuer ? { query: `${issuer} lawsuit OR enforcement OR insolvency OR investigation` } : null;
      },
    },
    // Mining
    {
      mind: "bitcoin-mining-intelligence",
      dimension: "hashprice_network",
      when: (s) => s.assetClass === "mining",
      params: (s) => {
        const block = req(s.blockNumber);
        return block && Number.isFinite(Number(block)) ? { block_height: Number(block) } : null;
      },
    },
    {
      mind: "bitcoin-mining-intelligence",
      dimension: "btc_price",
      when: (s) => s.assetClass === "mining",
      params: () => ({ symbol: "BTC" }),
    },
    {
      mind: "bitcoin-mining-intelligence",
      dimension: "energy_price",
      when: (s) => s.assetClass === "mining",
      params: (s) => {
        const node = req(s.gridNode);
        const interval = req(s.intervalStart);
        return node && interval ? { node_or_zone: node, interval_start: interval } : null;
      },
    },
    {
      mind: "minewatch",
      dimension: "owner_registry",
      when: (s) => s.assetClass === "mining",
      params: (s) => {
        const company = req(s.operatorEntity);
        const jurisdiction = req(s.jurisdiction);
        return company && jurisdiction ? { company, jurisdiction } : null;
      },
    },
    {
      mind: "minewatch",
      dimension: "regulatory_filings",
      when: (s) => s.assetClass === "mining",
      params: (s) => {
        const entity = req(s.operatorEntity);
        return entity ? { entity, period: PERIOD } : null;
      },
    },
    {
      mind: "minewatch",
      dimension: "operator_sanctions",
      when: (s) => s.assetClass === "mining",
      params: (s) => {
        const name = req(s.operatorEntity);
        return name ? { name } : null;
      },
    },
    {
      mind: "minewatch",
      dimension: "adverse_media",
      when: (s) => s.assetClass === "mining",
      params: (s) => {
        const name = req(s.operatorEntity);
        return name ? { query: `${name} incident OR dispute OR environmental OR sanctions` } : null;
      },
    },
    // Energy
    {
      mind: "energywatch",
      dimension: "grid_price",
      when: (s) => s.assetClass === "energy" || s.assetClass === "mining",
      params: (s) => {
        const node = req(s.gridNode);
        const interval = req(s.intervalStart);
        return node && interval ? { node_or_zone: node, interval_start: interval } : null;
      },
    },
    {
      mind: "energywatch",
      dimension: "current_temperature",
      when: (s) => s.assetClass === "energy",
      params: (s) => {
        const location = req(s.siteLocation);
        return location ? { location } : null;
      },
    },
    {
      mind: "energywatch",
      dimension: "weather_history",
      when: (s) => s.assetClass === "energy",
      params: (s) => {
        const location = req(s.siteLocation);
        const date = req(s.pastDate);
        return location && date ? { location, date } : null;
      },
    },
    {
      mind: "energywatch",
      dimension: "storm_risk",
      when: (s) => s.assetClass === "energy",
      params: (s) => {
        const location = req(s.siteLocation);
        return location ? { location, window_hours: 48 } : null;
      },
    },
  ],
  gapRefs: [
    { mind: "chainforensics", dimension: "clustering_labels" },
    { mind: "chainforensics", dimension: "fund_flow_tracing" },
    { mind: "ownershipgraph", dimension: "beneficial_ownership" },
    { mind: "sanctionsdesk", dimension: "related_parties" },
    { mind: "caseledger", dimension: "docket_retrieval" },
    { mind: "minewatch", dimension: "production" },
    { mind: "minewatch", dimension: "licences" },
    { mind: "bitcoin-mining-intelligence", dimension: "pool_concentration" },
    { mind: "bitcoin-mining-intelligence", dimension: "fleet_uptime" },
    { mind: "energywatch", dimension: "outages" },
    { mind: "energywatch", dimension: "facility_telemetry" },
  ],
  sections: [
    {
      id: "onchain_record",
      title: "On-chain record",
      description: "Balances, account metrics, transaction record and risk signals, each tied to its chain and block.",
      capabilities: [
        "chainforensics:wallet_balance",
        "chainforensics:onchain_metric",
        "chainforensics:tx_lookup",
        "chainforensics:tx_risk",
      ],
    },
    {
      id: "issuer_and_token",
      title: "Issuer and token record",
      description:
        "The issuer's registry record and filings, the verified total supply, USD price, holder count and pool depth — the evidence the network holds about the token and who stands behind it.",
      capabilities: [
        "index-reconstitution-desk:registry",
        "index-reconstitution-desk:filings",
        "index-reconstitution-desk:supply",
        "index-reconstitution-desk:price",
        "index-reconstitution-desk:holders",
        "index-reconstitution-desk:liquidity",
      ],
    },
    {
      id: "issuer_integrity",
      title: "Issuer integrity",
      description: "Firmographic context, issuer sanctions screening, optional named-controller screening and adverse coverage. These specialist routes are probe-verified until paid answers are independently validated.",
      capabilities: [
        "ownershipgraph:b2b_enrichment",
        "sanctionsdesk:name_screening",
        "ownershipgraph:sanctions_check",
        "caseledger:adverse_media",
      ],
    },
    {
      id: "market_context",
      title: "Market and network context",
      description: "Holder concentration, wash-trading signals, mining economics and asset price.",
      capabilities: [
        "chainforensics:holder_concentration",
        "chainforensics:wash_trading",
        "bitcoin-mining-intelligence:hashprice_network",
        "bitcoin-mining-intelligence:btc_price",
      ],
    },
    {
      id: "operating_company",
      title: "Operating company",
      description: "Registry identity, filings, sanctions and adverse coverage for the named operator.",
      capabilities: [
        "minewatch:owner_registry",
        "minewatch:regulatory_filings",
        "minewatch:operator_sanctions",
        "minewatch:adverse_media",
      ],
    },
    {
      id: "energy_environment",
      title: "Energy and environment",
      description: "Grid price at the node, site weather and storm risk for the window.",
      capabilities: [
        "bitcoin-mining-intelligence:energy_price",
        "energywatch:grid_price",
        "energywatch:current_temperature",
        "energywatch:weather_history",
        "energywatch:storm_risk",
      ],
    },
  ],
  honestyNotes: [
    "Wallet clustering, attribution and multi-hop fund-flow tracing are unsupported; a risk score is a provider judgment, not an identity.",
    "Beneficial ownership, group traversal and court dockets are unsupported. Screening a named issuer or controller does not establish ownership or control.",
    "Issuer enrichment, sanctions screening and adverse-media routes are probe-verified; paid answer quality and match accuracy have not yet been established in this workflow.",
    "Production volumes, licence tenure, outages and facility telemetry have no verified route and stay named gaps.",
    "Pool concentration and fleet uptime are not inferred from network hashrate.",
    "Circulating float, redemption terms and token sale documents are not askable on the network; circulating float stays a declared input, and issuer disclosures are covered only by the registry record and filings of the legal entity you name.",
  ],
  samples: {
    assetClass: "digital_asset",
    assetName: "Treasury wallet A",
    chain: "base",
    walletAddress: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001",
    txHash: "0x45bc185bc34ed246f341a09812bb3c95b2a4d0e78699b585820fca9c323d9aed",
    blockNumber: "23000000",
    tokenSymbol: "USDC",
    issuerEntity: "Circle Internet Group, Inc.",
    issuerJurisdiction: "US",
    issuerWebsite: "circle.com",
    marketSubject: "Uniswap USDC/ETH",
    spendLimitUsdCents: "10",
  },
};

/* ------------------------------------------------------------------ */
/* Trade & Supplier Intelligence                                       */
/* ------------------------------------------------------------------ */

const TRADE_WORKFLOW: DeskWorkflowDef = {
  type: "trade_supplier_intelligence",
  name: "Trade & Supplier Intelligence",
  kicker: "Deal Desk · Trade & Supplier",
  summary:
    "Whether a trade stands up — supplier identity and screening, purchase-order and invoice records, delivery and shipment status, and the route's congestion, weather and economics.",
  scope: "One supplier relationship and its shipments, from documents to ports.",
  subjectNoun: "supplier",
  fields: [
    {
      name: "supplierName",
      label: "Supplier legal name",
      kind: "text",
      required: true,
      question: "Which supplier are you investigating?",
      placeholder: "e.g. Siemens AG",
    },
    {
      name: "jurisdiction",
      label: "Jurisdiction (ISO 3166 alpha-2)",
      kind: "text",
      required: true,
      placeholder: "e.g. DE",
      help: "The registry schema requires the jurisdiction for routing.",
    },
    {
      name: "website",
      label: "Website or domain (optional)",
      kind: "text",
      required: false,
      unlocks: ["Firmographic enrichment"],
    },
    {
      name: "vatNumber",
      label: "Supplier VAT number (optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. DE129273398",
      unlocks: ["VAT / vendor identity"],
      help: "Unlocks the VAT identity check before payment release: does the tax registration validate and name this supplier?",
    },
    {
      name: "poNumber",
      label: "Purchase order number (optional)",
      kind: "text",
      required: false,
      unlocks: ["Purchase order"],
      help: "Asked with the vendor name.",
    },
    {
      name: "invoiceRef",
      label: "Invoice reference (optional)",
      kind: "text",
      required: false,
      unlocks: ["Invoice vs ledger"],
    },
    {
      name: "ledgerRef",
      label: "Ledger record (optional)",
      kind: "text",
      required: false,
      help: "The ledger line the invoice should reconcile against, e.g. 'INV-2026-1042 12000 USD'.",
    },
    {
      name: "orderId",
      label: "Commerce order ID (optional)",
      kind: "text",
      required: false,
      unlocks: ["Commerce order"],
    },
    {
      name: "merchant",
      label: "Merchant / platform (optional)",
      kind: "text",
      required: false,
      help: "Paired with the order ID.",
    },
    {
      name: "carrier",
      label: "Carrier (optional)",
      kind: "text",
      required: false,
      unlocks: ["Delivery window", "Carrier serviceability", "Package status"],
    },
    {
      name: "route",
      label: "Route (optional)",
      kind: "text",
      required: false,
      placeholder: "e.g. Rotterdam-Singapore",
      help: "Used by the delivery-window and route-ETA asks.",
    },
    {
      name: "originPort",
      label: "Origin port (optional)",
      kind: "text",
      required: false,
      unlocks: ["Port congestion", "Shipment rate and transit", "Route ETA", "Storm disruption risk"],
    },
    {
      name: "destinationPort",
      label: "Destination port (optional)",
      kind: "text",
      required: false,
    },
    {
      name: "weightKg",
      label: "Consignment weight in kg (optional)",
      kind: "number",
      required: false,
      help: "Required by the rate ask when a route is given.",
    },
    {
      name: "vesselName",
      label: "Vessel name (optional)",
      kind: "text",
      required: false,
      unlocks: ["Vessel telemetry", "Vessel name screening"],
    },
    {
      name: "trackingNumber",
      label: "Tracking number (optional)",
      kind: "text",
      required: false,
      unlocks: ["Package status"],
    },
    {
      name: "spendLimitUsdCents",
      label: "Spend ceiling (USD cents)",
      kind: "number",
      required: false,
      placeholder: "10",
      help: "Maximum the paid run may draw, in cents. Default 10 ($0.10).",
    },
  ],
  capabilities: [
    {
      mind: "tradeverify",
      dimension: "counterparty_registry",
      params: (s) => {
        const company = req(s.supplierName);
        const jurisdiction = req(s.jurisdiction);
        return company && jurisdiction ? { company, jurisdiction } : null;
      },
    },
    {
      mind: "sanctionsdesk",
      dimension: "name_screening",
      params: (s) => {
        const name = req(s.supplierName);
        return name ? { name } : null;
      },
    },
    {
      mind: "sanctionsdesk",
      dimension: "b2b_enrichment",
      params: (s) => {
        const company = req(s.website) ?? req(s.supplierName);
        return company ? { company } : null;
      },
    },
    {
      mind: "ownershipgraph",
      dimension: "vendor_identity",
      params: (s) => {
        const vendor = req(s.supplierName);
        const vat = req(s.vatNumber);
        return vendor && vat ? { vendor, vat_number: vat } : null;
      },
    },
    {
      mind: "tradeverify",
      dimension: "po_verify",
      params: (s) => {
        const po = req(s.poNumber);
        const vendor = req(s.supplierName);
        return po && vendor ? { po_number: po, vendor } : null;
      },
    },
    {
      mind: "tradeverify",
      dimension: "invoice_reconcile",
      params: (s) => {
        const invoice = req(s.invoiceRef);
        const ledger = req(s.ledgerRef);
        return invoice && ledger ? { invoice, ledger } : null;
      },
    },
    {
      mind: "tradeverify",
      dimension: "commerce_verify",
      params: (s) => {
        const orderId = req(s.orderId);
        const merchant = req(s.merchant);
        return orderId && merchant ? { order_id: orderId, merchant } : null;
      },
    },
    {
      mind: "tradeverify",
      dimension: "delivery_window",
      params: (s) => {
        const carrier = req(s.carrier);
        const route = req(s.route);
        return carrier && route ? { carrier, route } : null;
      },
    },
    {
      mind: "tradeverify",
      dimension: "package_status",
      params: (s) => {
        const tracking = req(s.trackingNumber);
        const carrier = req(s.carrier);
        return tracking && carrier ? { tracking_number: tracking, carrier } : null;
      },
    },
    {
      mind: "portsentinel",
      dimension: "port_congestion",
      params: (s) => {
        const port = req(s.originPort) ?? req(s.destinationPort);
        return port ? { port } : null;
      },
    },
    {
      mind: "portsentinel",
      dimension: "vessel_telemetry",
      params: (s) => {
        const vessel = req(s.vesselName);
        return vessel ? { vessel } : null;
      },
    },
    {
      mind: "portsentinel",
      dimension: "ship_rate",
      params: (s) => {
        const origin = req(s.originPort);
        const destination = req(s.destinationPort);
        const weight = req(s.weightKg);
        return origin && destination && weight && Number.isFinite(Number(weight))
          ? { origin, destination, weight_kg: Number(weight) }
          : null;
      },
    },
    {
      mind: "portsentinel",
      dimension: "carrier_scope",
      params: (s) => {
        const carrier = req(s.carrier);
        const area = req(s.destinationPort) ?? req(s.originPort);
        return carrier && area ? { carrier, area } : null;
      },
    },
    {
      mind: "portsentinel",
      dimension: "storm_risk",
      params: (s) => {
        const location = req(s.originPort) ?? req(s.destinationPort);
        return location ? { location, window_hours: 48 } : null;
      },
    },
    {
      mind: "portsentinel",
      dimension: "route_eta",
      params: (s) => {
        const origin = req(s.originPort);
        const destination = req(s.destinationPort);
        return origin && destination ? { origin, destination } : null;
      },
    },
    {
      mind: "sanctionsdesk",
      dimension: "vessel_screening",
      params: (s) => {
        const name = req(s.vesselName);
        return name ? { name } : null;
      },
    },
  ],
  gapRefs: [
    { mind: "tradeverify", dimension: "documents" },
    { mind: "portsentinel", dimension: "terminal_schedule" },
    { mind: "sanctionsdesk", dimension: "related_parties" },
  ],
  sections: [
    {
      id: "supplier_identity",
      title: "Supplier identity",
      description: "Registry record, sanctions screening, firmographics and VAT identity for the supplier.",
      capabilities: [
        "tradeverify:counterparty_registry",
        "sanctionsdesk:name_screening",
        "sanctionsdesk:b2b_enrichment",
        "ownershipgraph:vendor_identity",
      ],
    },
    {
      id: "trade_documents",
      title: "Trade documents and orders",
      description: "Purchase-order, invoice-ledger and commerce-order records as the sources report them.",
      capabilities: ["tradeverify:po_verify", "tradeverify:invoice_reconcile", "tradeverify:commerce_verify"],
    },
    {
      id: "logistics",
      title: "Logistics and shipment",
      description: "Delivery windows, package status, vessel position and port congestion on the actual route.",
      capabilities: [
        "tradeverify:delivery_window",
        "tradeverify:package_status",
        "portsentinel:vessel_telemetry",
        "portsentinel:port_congestion",
        "sanctionsdesk:vessel_screening",
      ],
    },
    {
      id: "route_economics",
      title: "Route economics and risk",
      description: "Rate and transit, carrier serviceability, route ETA, port storm risk.",
      capabilities: [
        "portsentinel:ship_rate",
        "portsentinel:carrier_scope",
        "portsentinel:route_eta",
        "portsentinel:storm_risk",
      ],
    },
  ],
  honestyNotes: [
    "Bill-of-lading, cargo-document and customs parsing are unsupported; document-to-document discrepancy review needs that source.",
    "Terminal berth schedules are unsupported; port congestion is a port-level snapshot.",
    "Vessel screening is name-based only — no IMO/MMSI match or ownership link.",
    "A VAT check validates a tax identity, not beneficial ownership; related-party ownership exposure has no verified route and stays a named gap.",
  ],
  samples: {
    supplierName: "Siemens AG",
    jurisdiction: "DE",
    website: "siemens.com",
    vatNumber: "DE129273398",
    poNumber: "PO-2026-0042",
    invoiceRef: "INV-2026-1042",
    ledgerRef: "INV-2026-1042 12000 USD",
    orderId: "ORD-88416",
    carrier: "Maersk Line",
    route: "Rotterdam-Singapore",
    originPort: "Rotterdam",
    destinationPort: "Singapore",
    weightKg: "18400",
    vesselName: "Emma Maersk",
    spendLimitUsdCents: "10",
  },
};

/* ------------------------------------------------------------------ */
/* Listing Underwriter — token admission assessment                    */
/* ------------------------------------------------------------------ */

/**
 * A listing-specific product workflow over the existing asset capability
 * set. It deliberately reuses the same matrix references and payment /
 * verification engine; no new Mind or intent is introduced.
 */
const LISTING_UNDERWRITER_WORKFLOW: DeskWorkflowDef = {
  ...ASSET_WORKFLOW,
  type: "listing_underwriter",
  name: "Listing Underwriter",
  kicker: "Deal Desk · Listing",
  summary:
    "Assess whether a token has enough verified issuer, supply, holder, liquidity and market-integrity evidence to enter a listing review.",
  scope: "One token and its named issuer, using existing verified and probe-verified Telegraph routes.",
  subjectNoun: "token",
  fields: ASSET_WORKFLOW.fields.filter((field) =>
    ["assetClass", "assetName", "chain", "tokenSymbol", "issuerEntity", "issuerJurisdiction", "issuerWebsite", "controllerName", "declaredSupply", "marketSubject", "spendLimitUsdCents"].includes(field.name),
  ),
  capabilities: ASSET_WORKFLOW.capabilities.filter((ref) =>
    [
      "index-reconstitution-desk:registry",
      "index-reconstitution-desk:price",
      "index-reconstitution-desk:supply",
      "index-reconstitution-desk:holders",
      "index-reconstitution-desk:liquidity",
      "index-reconstitution-desk:filings",
      "chainforensics:holder_concentration",
      "chainforensics:wash_trading",
      "ownershipgraph:b2b_enrichment",
      "sanctionsdesk:name_screening",
      "ownershipgraph:sanctions_check",
      "caseledger:adverse_media",
    ].includes(capabilityKey(ref)),
  ),
  gapRefs: ASSET_WORKFLOW.gapRefs.filter((ref) =>
    [
      "chainforensics:clustering_labels",
      "chainforensics:fund_flow_tracing",
      "ownershipgraph:beneficial_ownership",
      "sanctionsdesk:related_parties",
      "caseledger:docket_retrieval",
    ].includes(capabilityKey(ref)),
  ),
  sections: [
    {
      id: "issuer_identity",
      title: "Issuer identity and disclosures",
      description: "Registry identity, regulatory filings and firmographic context for the named issuer.",
      capabilities: ["index-reconstitution-desk:registry", "index-reconstitution-desk:filings", "ownershipgraph:b2b_enrichment"],
    },
    {
      id: "token_integrity",
      title: "Token integrity",
      description: "Network-verified total supply and holder count, alongside the provider-reported holder concentration signal.",
      capabilities: ["index-reconstitution-desk:supply", "index-reconstitution-desk:holders", "chainforensics:holder_concentration"],
    },
    {
      id: "market_quality",
      title: "Market quality",
      description: "Point-in-time USD price and pool depth, alongside probe-verified wash-trading signals for the named market.",
      capabilities: ["index-reconstitution-desk:price", "index-reconstitution-desk:liquidity", "chainforensics:wash_trading"],
    },
    {
      id: "issuer_exposure",
      title: "Issuer and control exposure",
      description: "Issuer and named-controller screening plus adverse-media coverage. Screening does not prove ownership or control.",
      capabilities: ["sanctionsdesk:name_screening", "ownershipgraph:sanctions_check", "caseledger:adverse_media"],
    },
  ],
  honestyNotes: [
    "Holder concentration and wash-trading routes are probe-verified; paid answer quality must be judged from the actual signal-verified result, not the route status.",
    "Beneficial ownership, group structure and related-party exposure are unsupported. A named-controller sanctions screen does not establish control.",
    "Adverse media is news search, not court-docket retrieval or a legal finding.",
    "Total supply is not circulating float. Redemption rights, token-sale terms, lockups and legal enforceability require primary documents not supplied by these routes.",
    "A listing assessment is evidence for a human review, not an exchange admission decision or investment recommendation.",
  ],
  samples: {
    assetClass: "digital_asset",
    assetName: "Circle / USDC listing review",
    chain: "ethereum",
    tokenSymbol: "USDC",
    issuerEntity: "Circle Internet Group, Inc.",
    issuerJurisdiction: "US",
    issuerWebsite: "circle.com",
    declaredSupply: "Issuer-stated total supply to be supplied from current disclosure",
    marketSubject: "Uniswap USDC/ETH",
    spendLimitUsdCents: "12",
  },
};

export const DESK_WORKFLOWS: Record<DeskInvestigationType, DeskWorkflowDef> = {
  counterparty_due_diligence: COUNTERPARTY_WORKFLOW,
  asset_intelligence: ASSET_WORKFLOW,
  trade_supplier_intelligence: TRADE_WORKFLOW,
  listing_underwriter: LISTING_UNDERWRITER_WORKFLOW,
};

export const DESK_TYPE_ORDER: DeskInvestigationType[] = [
  "counterparty_due_diligence",
  "asset_intelligence",
  "trade_supplier_intelligence",
  "listing_underwriter",
];

export function deskWorkflow(type: string): DeskWorkflowDef | undefined {
  return (DESK_WORKFLOWS as Record<string, DeskWorkflowDef | undefined>)[type];
}

/** Capability key of a reference, e.g. "counterparty-intelligence:registry". */
export function capabilityKey(ref: { mind: string; dimension: string }): string {
  return `${ref.mind}:${ref.dimension}`;
}

/**
 * Resolve a capability reference against the verified matrix. Throws when
 * the matrix no longer contains the referenced dimension — a broken
 * reference must never silently become a fabricated capability.
 */
export function resolveDeskCapability(ref: { mind: string; dimension: string }): CapabilityDimension {
  const profile = CAPABILITIES[ref.mind];
  if (!profile) throw new Error(`workflow capability references unknown Mind: ${ref.mind}`);
  const dim = profile.dimensions.find((d) => d.id === ref.dimension);
  if (!dim) throw new Error(`workflow capability references unknown dimension: ${capabilityKey(ref)}`);
  return dim;
}

/** Resolve a gap reference; gaps are first-class matrix entries. */
export function resolveDeskGap(ref: { mind: string; dimension: string }): CapabilityDimension {
  const dim = resolveDeskCapability(ref);
  if (dim.status !== "gap") {
    throw new Error(`workflow declares ${capabilityKey(ref)} as unsupported but the matrix serves it (status ${dim.status})`);
  }
  return dim;
}

/* ------------------------------------------------------------------ */
/* Serializable workflow summaries (server pages → client components)  */
/* ------------------------------------------------------------------ */

export interface DeskWorkflowSummary {
  type: DeskInvestigationType;
  name: string;
  kicker: string;
  summary: string;
  scope: string;
  subjectNoun: string;
  capabilityCount: number;
  gapCount: number;
  fields: DeskField[];
  unsupported: Array<{ label: string; requirement: string; reason: string; resolution: string }>;
  sections: Array<{ id: string; title: string; description: string }>;
  honestyNotes: string[];
  samples: Record<string, string>;
}

/**
 * The client-safe projection of a workflow definition: no param builders, no
 * capability references — just what the guided form and the entry card show.
 */
export function describeDeskWorkflow(type: DeskInvestigationType): DeskWorkflowSummary {
  const w = DESK_WORKFLOWS[type];
  return {
    type: w.type,
    name: w.name,
    kicker: w.kicker,
    summary: w.summary,
    scope: w.scope,
    subjectNoun: w.subjectNoun,
    capabilityCount: w.capabilities.length,
    gapCount: w.gapRefs.length,
    fields: w.fields,
    unsupported: w.gapRefs.map((ref) => {
      const gap = resolveDeskGap(ref);
      return {
        label: gap.label,
        requirement: gap.requirement,
        reason: gap.missingReason ?? "unsupported on the network",
        resolution: gap.resolution ?? "keep it named as a gap — when a verifiable source exists outside Telegraph, attach it as operator evidence instead of inferring the fact.",
      };
    }),
    sections: w.sections.map((s) => ({ id: s.id, title: s.title, description: s.description })),
    honestyNotes: w.honestyNotes,
    samples: w.samples,
  };
}
