/**
 * The NIGHTSHIFT Minds catalogue.
 *
 * A Mind is a specialist intelligence capability with a named domain, a
 * defined investigation scope, and an honest development status. Only a Mind
 * with a working investigation path is "available"; a definition without a
 * pinned provider is "in development" or "planned" and never pretends
 * otherwise.
 *
 * This registry is the single source of truth for the hub, each profile page,
 * the API descriptor and the sitemap.
 */

export type MindStatus = "available" | "in_development" | "planned";

export interface MindCoverage {
  /** What the dimension is called in business terms. */
  dimension: string;
  /** The Telegraph intent that answers it. */
  intent: string;
  /** The pinned miner (or "router" when no pin is used). */
  miner: string;
}

export interface MindDefinition {
  /** URL identifier for the profile page. */
  slug: string;
  name: string;
  /** Short domain label shown as the kicker, e.g. "Markets · Index construction". */
  domain: string;
  /** One-sentence catalogue description. */
  summary: string;
  /** The business problem the Mind investigates. */
  problem: string;
  /** What the Mind is responsible for investigating. */
  responsibilities: string[];
  /** Business uses the investigation supports. */
  capabilities: string[];
  status: MindStatus;
  /** What exists today, stated plainly. */
  statusNote: string;
  /** The next concrete step before this Mind can run. */
  nextStep: string;
  /** What the Mind does not claim or cover. */
  boundaries: string[];
  /** Verified network coverage; only present for available Minds. */
  coverage?: MindCoverage[];
  /** Where the investigation actually runs. Only for available Minds. */
  href?: string;
}

export const MINDS: MindDefinition[] = [
  {
    slug: "bitcoin-mining-intelligence",
    name: "Bitcoin Mining Intelligence",
    domain: "Digital assets · Mining economics",
    summary:
      "Mining economics, hashrate, pool concentration, energy cost and operating performance in one evidence trail.",
    problem:
      "Mining exposure is usually assessed from market commentary rather than the network's own record. Hashrate, difficulty, pool share and energy cost drift daily, and the assumptions behind an operating report are rarely attached to it.",
    responsibilities: [
      "Network economics: hashrate, difficulty, hashprice and revenue per unit of compute over a stated window.",
      "Pool and operator concentration: share by pool, single-operator exposure and changes in distribution.",
      "Energy sensitivity: cost per kWh assumptions, breakeven hashprice and the effect of utilisation.",
      "Operating performance: uptime, fleet efficiency and the gap between reported and implied output.",
    ],
    capabilities: ["Site and fleet diligence", "Treasury and hedging context", "Concentration risk"],
    status: "in_development",
    statusNote:
      "Investigation design is defined. No mining provider has been verified and pinned, so this Mind cannot be run yet.",
    nextStep:
      "Verify Telegraph intents for hashrate, pool share and energy data, pin their miners, then wire the plan → approval → report pipeline on the shared engine.",
    boundaries: [
      "No hashrate, pool or energy feed is connected to this deployment.",
      "Nothing on this page is a live mining measurement.",
    ],
  },
  {
    slug: "index-reconstitution-desk",
    name: "Index Reconstitution Desk",
    domain: "Markets · Index construction",
    summary:
      "Turns a declared universe and weighting rule into a deterministic, evidence-backed constituent proposal.",
    problem:
      "Index changes are usually argued from spreadsheets with no shared provenance. Eligibility, float, liquidity and concentration each come from a different source, and the audit trail rarely survives the meeting.",
    responsibilities: [
      "Asset eligibility: issuer registry status, jurisdiction and legal identity.",
      "Market inputs: network-verified price and total supply where available; declared float and volume where not.",
      "Liquidity and concentration: pool depth, HHI, effective N and top-1/top-3 weights.",
      "Composition: apply the declared weighting rule verbatim and record every exclusion with its reason.",
    ],
    capabilities: ["Rebalance review", "Methodology diligence", "Constituent evidence packs"],
    status: "available",
    statusNote:
      "Live. Free desks probe every dimension without spending; paid asks run only after an operator approves the exact plan.",
    nextStep:
      "Add per-Mind monitoring so a live index can be re-checked on a schedule and compared with its last approved composition.",
    boundaries: [
      "Circulating float and trading volumes have no network intent; they remain declared inputs and are labelled as such.",
      "A proposal is not investment advice and does not execute a rebalance.",
    ],
    coverage: [
      { dimension: "Issuer registry record", intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL", miner: "zk-corp-atlas" },
      { dimension: "USD price", intent: "CRYPTO_PRICE_USD", miner: "cp-coinbase" },
      { dimension: "Total supply", intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", miner: "verifywire-token-total-supply" },
      { dimension: "DEX pool liquidity", intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL", miner: "verifywire-liquidity-depth" },
      { dimension: "Holder count", intent: "TOKEN_HOLDER_COUNT_GENERAL", miner: "router (no pin)" },
      { dimension: "Regulatory filings (12m)", intent: "REGULATORY_FILING_MONITOR_GENERAL", miner: "verireceipt" },
    ],
    href: "/minds/index-desk",
  },
  {
    slug: "counterparty-intelligence",
    name: "Counterparty Intelligence",
    domain: "Corporate · Counterparty diligence",
    summary: "Corporate-registry facts for a named company, split into verified facts, gaps and conflicts.",
    problem:
      "Counterparty files are assembled from registry extracts that rarely say what is missing. A legal name, registration number or active status can be confidently wrong in a deck and impossible to trace afterwards.",
    responsibilities: [
      "Legal identity: registered name, registration ID, LEI and jurisdiction.",
      "Status and address: active/inactive verdict, registered address and incorporation date.",
      "Gaps and conflicts: fields the registry did not return, and disagreements between the answer and the request.",
      "Verification: the hash-committed payload and signal receipt behind every fact.",
    ],
    capabilities: ["KYC refresh", "Supplier onboarding", "Registry evidence"],
    status: "available",
    statusNote:
      "Live. The price check is free; the exact offer is shown and approved before a single ask is signed.",
    nextStep: "Add group-structure traversal and scheduled re-checks; single-entity resolution is what runs today.",
    boundaries: [
      "One legal entity per investigation; group structures are OwnershipGraph's domain.",
      "A registry answer is not a legal opinion.",
    ],
    coverage: [
      { dimension: "Corporate registry record", intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL", miner: "zk-corp-atlas" },
    ],
    href: "/minds/counterparty",
  },
  {
    slug: "portsentinel",
    name: "PortSentinel",
    domain: "Trade · Maritime",
    summary: "Port congestion, vessel movements, terminal disruption and the shipping dependencies behind a supply chain.",
    problem:
      "A delayed port call becomes a missed production window, yet congestion is read from scattered notices and tracking screens with no source attached to the claim.",
    responsibilities: [
      "Port and terminal status: congestion, closures, berth and draft constraints.",
      "Vessel movements: arrivals, diversions, operators and the dependencies they carry.",
      "Disruption impact: which inbound or outbound flows a terminal interruption affects.",
      "Counterparty exposure: carriers, terminal operators and port authorities involved.",
    ],
    capabilities: ["Supplier continuity", "Logistics diligence", "Disruption monitoring"],
    status: "planned",
    statusNote: "Product definition only. No port, vessel or terminal provider has been selected.",
    nextStep:
      "Verify and pin port-call, vessel and terminal-status intents, then define the dependency-map input each investigation needs.",
    boundaries: ["No AIS, port or terminal feed is connected.", "No live vessel or congestion data is shown."],
  },
  {
    slug: "minewatch",
    name: "MineWatch",
    domain: "Resources · Mining",
    summary: "Mineral production, mining companies, ownership, licences and the operational risks around an asset.",
    problem:
      "A mining asset's real risk sits in its licence status, ownership chain and production record, not in a summary slide. Those facts rarely arrive together.",
    responsibilities: [
      "Production: reported output, guidance changes and the period each figure covers.",
      "Ownership and control: parent companies, subsidiaries and related parties.",
      "Licences and tenure: permit status, jurisdiction and expiry.",
      "Operational risk: suspensions, incidents and regulatory or community disputes.",
    ],
    capabilities: ["Asset diligence", "Counterparty screening", "Supply-chain provenance"],
    status: "planned",
    statusNote: "Product definition only. No production or licence source has been pinned.",
    nextStep:
      "Pin production, licence and corporate-registry intents, and agree how a site identifier maps to its legal owner.",
    boundaries: ["No production, licence or cadastre feed is connected.", "No mining asset is assessed on this page."],
  },
  {
    slug: "chainforensics",
    name: "ChainForensics",
    domain: "Digital assets · On-chain",
    summary: "Wallet relationships, suspicious transaction flows and the fund path behind an address.",
    problem:
      "A wallet address alone says little. Exposure depends on who controls it, how funds arrived, and which counterparties they passed through.",
    responsibilities: [
      "Wallet clustering: addresses that behave as one controller, with the evidence for the link.",
      "Flow tracing: inbound and outbound paths across hops, bridges and exchanges.",
      "Counterparty risk: sanctioned, flagged or high-risk addresses in the path.",
      "Evidence: every hop tied to a transaction hash and the source that labelled it.",
    ],
    capabilities: ["Incident response", "Counterparty due diligence", "Treasury tracing"],
    status: "planned",
    statusNote: "Product definition only. No chain-analytics or labelling provider is connected.",
    nextStep:
      "Verify chain-analytics intents and a labelling source, then fix the tracing depth and evidentiary standard before any paid ask.",
    boundaries: [
      "No chain-analytics or labelling provider is connected.",
      "Attribution is never inferred from this page; an address alone is not an identity.",
    ],
  },
  {
    slug: "ownershipgraph",
    name: "OwnershipGraph",
    domain: "Corporate · Ownership",
    summary: "Corporate structures, beneficial ownership, subsidiaries and related-party exposure.",
    problem:
      "Group structures are assembled from filings in different jurisdictions, and the ultimate owner is often the one fact a counterparty file omits.",
    responsibilities: [
      "Structure: parents, subsidiaries, branches and the jurisdiction of each entity.",
      "Beneficial ownership: declared controllers and the filings that support them.",
      "Related-party exposure: shared directors, addresses and intercompany links.",
      "Gaps: entities the available registers cannot resolve.",
    ],
    capabilities: ["KYC escalation", "Group exposure", "M&A diligence"],
    status: "planned",
    statusNote:
      "Product definition only. The live Counterparty Mind resolves single entities; group-structure traversal is not built.",
    nextStep:
      "Pin corporate-registry and beneficial-ownership intents across priority jurisdictions, and define how unresolved entities are reported.",
    boundaries: [
      "No beneficial-ownership register is connected.",
      "The Counterparty intelligence tool is not a group-structure graph.",
    ],
  },
  {
    slug: "tradeverify",
    name: "TradeVerify",
    domain: "Trade · Documentation",
    summary: "Trade counterparties, cargo documentation, shipment records and the discrepancies between them.",
    problem:
      "Documents, shipment records and counterparty claims are checked by hand, and small mismatches in dates, quantities or parties are where the exposure hides.",
    responsibilities: [
      "Counterparty identity: buyer, seller, agent, carrier and their registry status.",
      "Cargo documents: invoice, bill of lading and certificate fields.",
      "Shipment records: route, dates and quantities as recorded.",
      "Discrepancies: conflicting values, missing documents and the evidence for each.",
    ],
    capabilities: ["Pre-shipment checks", "Document diligence", "Discrepancy review"],
    status: "planned",
    statusNote: "Product definition only. No document-parsing or shipment source is connected.",
    nextStep:
      "Pin corporate-registry and shipment intents, then define the document schema and the rules that count as a discrepancy.",
    boundaries: ["No document-parsing or shipment feed is connected.", "Nothing here validates a real shipment."],
  },
  {
    slug: "sanctionsdesk",
    name: "SanctionsDesk",
    domain: "Compliance · Sanctions",
    summary: "Sanctions exposure across companies, vessels, individuals and the entities connected to them.",
    problem:
      "Screening a single name misses the vessel it operates, the parent that owns it and the director who links it to a listed party.",
    responsibilities: [
      "Direct exposure: names, identifiers and aliases against sanctions lists.",
      "Vessel and asset exposure: IMO numbers, registrations and ownership.",
      "Related entities: parents, subsidiaries and shared controllers.",
      "Evidence: the list, entry and match basis for every hit.",
    ],
    capabilities: ["Onboarding screening", "Transaction review", "Periodic re-screening"],
    status: "planned",
    statusNote: "Product definition only. No sanctions list is bundled or queried by this deployment.",
    nextStep:
      "Pin sanctions, corporate-registry and vessel intents, then define match thresholds and how near matches are reported.",
    boundaries: ["No sanctions list is queried by this deployment.", "A screen is not a legal determination."],
  },
  {
    slug: "caseledger",
    name: "CaseLedger",
    domain: "Legal · Litigation",
    summary: "Litigation histories, disputes, court records and the legal exposure around a counterparty.",
    problem:
      "Court records are fragmented by jurisdiction and party name, so a counterparty's dispute history is rebuilt from memory and press coverage.",
    responsibilities: [
      "Case history: matters, courts, jurisdictions and current status.",
      "Parties: claimants, defendants and the entities behind them.",
      "Outcomes and exposure: judgments, settlements and open disputes.",
      "Gaps: jurisdictions and registries that cannot be searched.",
    ],
    capabilities: ["Counterparty diligence", "Dispute monitoring", "Portfolio risk review"],
    status: "planned",
    statusNote: "Product definition only. No court-record provider is selected.",
    nextStep:
      "Identify court-record intents and priority jurisdictions, then define entity matching and how sealed or unavailable matters are reported.",
    boundaries: ["No court-record provider is connected.", "Nothing here is legal advice."],
  },
  {
    slug: "energywatch",
    name: "EnergyWatch",
    domain: "Energy · Infrastructure",
    summary: "Energy assets, production, infrastructure dependencies and the disruptions that affect them.",
    problem:
      "Energy exposure is a chain: an asset, the grid or pipeline it depends on, and the counterparties that operate it. Disruption anywhere in that chain changes the risk.",
    responsibilities: [
      "Assets and production: capacity, output and the reporting period.",
      "Infrastructure dependencies: grid connections, pipelines, terminals and transport.",
      "Disruptions: outages, constraints, maintenance and force majeure notices.",
      "Counterparties: operators, offtakers and the entities exposed.",
    ],
    capabilities: ["Operational diligence", "Continuity planning", "Exposure monitoring"],
    status: "planned",
    statusNote: "Product definition only. No grid, outage or production source is connected.",
    nextStep:
      "Pin outage, production and infrastructure intents, then define the dependency model linking an asset to its grid and operators.",
    boundaries: ["No grid, outage or production feed is connected.", "No live energy asset is monitored on this page."],
  },
];

export function mindBySlug(slug: string): MindDefinition | undefined {
  return MINDS.find((m) => m.slug === slug);
}

export function mindsByStatus(status: MindStatus): MindDefinition[] {
  return MINDS.filter((m) => m.status === status);
}

export const MIND_STATUS_LABEL: Record<MindStatus, string> = {
  available: "Available",
  in_development: "In development",
  planned: "Planned",
};

/** Stable catalogue index (01–10) for editorial numbering. */
export function mindIndex(slug: string): string {
  const i = MINDS.findIndex((m) => m.slug === slug);
  return String(i + 1).padStart(2, "0");
}
