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
    status: "available",
    statusNote:
      "Live. A paid run on 2026-11-24 settled and signal-verified hashprice/hashrate, BTC spot price and ERCOT LMP for $0.03. The report derives USD hashprice from committed sats × committed BTC price because the provider leaves USD unavailable. Pool concentration and fleet uptime remain explicit gaps.",
    nextStep:
      "Close the two gaps with a purpose-built pool-attribution / telemetry route; until then, keep the declared-vs-verified line visible and do not infer either.",
    boundaries: [
      "Pool concentration and fleet uptime are unsupported; every report names them and never infers them from network hashrate.",
      "A historical block can be investigated, but the report flags timestamp misalignment with current BTC and grid prices rather than presenting it as a current operating picture.",
    ],
    href: "/minds/bitcoin-mining",
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for port congestion, vessel telemetry, carrier identity, shipment rate, carrier scope, storm risk and route ETA (unpaid probes). The shared capability API can execute them, but terminal schedules are unsupported and no paid answer has been verified, so there is no product launch.",
    nextStep:
      "Run a paid pilot over the seven verified dimensions, then replace the generic route-ETA fallback with a maritime schedule source or record it as a permanent approximation.",
    boundaries: [
      "Terminal berth schedules and container-level status are unsupported.",
      "Verified routes are not live port or vessel measurements until a paid, verified answer exists.",
    ],
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for owner identity, filings, operator sanctions and adverse media (unpaid probes). The shared capability API can execute them, but production volumes and licences have no verified source and no paid answer has been verified, so there is no product launch.",
    nextStep:
      "Run a paid capability pilot over the four verified dimensions, then source production and licence data outside Telegraph or keep them as explicit gaps.",
    boundaries: [
      "Production volumes, guidance and licence tenure are unsupported.",
      "A registry identity is not the asset's ownership chain; the site-to-operator link must be supplied.",
    ],
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for transaction lookup, balances, transaction risk, account metrics, holder counts and wash-trading signals (unpaid probes). The shared capability API can execute them, but clustering, attribution and multi-hop tracing are unsupported and no paid answer has been verified, so there is no product launch.",
    nextStep:
      "Run a paid pilot over the six verified dimensions, then add a labelling/tracing source before claiming wallet attribution.",
    boundaries: [
      "Wallet clustering, attribution and cross-chain fund-flow tracing are unsupported.",
      "A risk score is a provider judgment, not an identity; nothing here attributes an address to a person.",
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for entity identity, firmographic enrichment, sanctions checks, filings and VAT identity (unpaid probes). The shared capability API can execute the single-entity dimensions, but beneficial ownership and group traversal — the core claim — are unsupported, so it is not operational.",
    nextStep:
      "Find a verifiable beneficial-ownership or shareholding source before building the graph; the verified single-entity dimensions are not a substitute.",
    boundaries: [
      "Beneficial ownership, parent/subsidiary links and shared-director analysis are unsupported.",
      "The Counterparty intelligence tool resolves one entity; it is not this graph.",
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for PO, invoice/ledger, commerce orders, counterparty identity, delivery windows and package status (unpaid probes). The shared capability API can execute them, but bills of lading and cargo-document extraction are unsupported and no paid answer has been verified, so there is no product launch.",
    nextStep:
      "Run a paid pilot over the six verified dimensions, then add cargo-document extraction before claiming document-to-document discrepancy review.",
    boundaries: [
      "Bill-of-lading, cargo-document and customs parsing are unsupported.",
      "Verified routes are not a validation of any real shipment until paid answers are reconciled.",
    ],
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for name screening, entity identity, enrichment and vessel-name screening (unpaid probes). The shared capability API can execute them, but IMO/MMSI vessel matching and related-party ownership are unsupported, so this is not yet a sanctions desk.",
    nextStep:
      "Add an IMO/MMSI-based vessel screen and an ownership link before claiming exposure analysis; a paid name-screen pilot alone is not enough.",
    boundaries: [
      "Vessel screening is name-based only; there is no IMO/MMSI match.",
      "Related-party ownership exposure is unsupported; a screen is not a legal determination.",
    ],
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for party identity, public filings, adverse coverage and claim checks (unpaid probes). The shared capability API can execute them, but court dockets, judgments and multi-jurisdiction coverage are unsupported, so litigation history cannot be claimed.",
    nextStep:
      "Find a verifiable court-record source before calling this a case ledger; press coverage and filings are not a docket.",
    boundaries: [
      "Court dockets, judgments, settlements and sealed matters are unsupported.",
      "Adverse coverage is not a court record; nothing here is legal advice.",
    ],
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
    status: "in_development",
    statusNote:
      "Schema and routing are verified for ERCOT grid price, operator identity, storm risk, current temperature and historical weather (unpaid probes). The shared capability API can execute them, but outages, production and facility telemetry are unsupported and no paid answer has been verified, so there is no product launch.",
    nextStep:
      "Run a paid pilot over the grid, weather and operator dimensions, then source outage/production data before claiming operational monitoring.",
    boundaries: [
      "Outage notices, production volumes and facility power/PUE are unsupported.",
      "ERCOT price coverage is not a global energy market view.",
    ],
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
