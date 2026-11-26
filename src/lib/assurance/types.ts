/**
 * Institutional Transaction Intelligence & Settlement Assurance — shared types.
 *
 * Transport-free so the API routes, the workspace and future institutional
 * channels (a Telegraph tool call, a Minds delivery) use one record model.
 *
 * Provenance invariant: every evidence record declares whether it is
 *   source_verified  — an actual read of Solana state performed by this app,
 *   node_verified    — a paid Telegraph answer whose committed payload the
 *                      engine re-derived against the node's signal record,
 *   probe_verified   — schema, provider and live price accepted by an UNPAID
 *                      probe only (never an answer, never a finding),
 *   demonstration    — clearly labelled fixture data, never a live check.
 *
 * A Mind conclusion is deliberately NOT an evidence class: no connected Mind
 * produces evidence in this deployment, so a reasoning claim is never rendered
 * beside a verified fact as if it were one.
 */

export type DataMode = "live" | "demonstration";

export type EvidenceClass = "source_verified" | "node_verified" | "probe_verified" | "demonstration";

export interface AssuranceEvidence {
  id: string;
  class: EvidenceClass;
  /** Capability or read that produced this record. */
  capability: string;
  title: string;
  detail: string;
  /** Short, attributable scalars only; long text stays in `detail`. */
  facts: Record<string, string | number | boolean | null>;
  source: {
    kind: "solana_rpc" | "telegraph" | "demo";
    /** RPC URL, signal hash or fixture id. */
    ref: string;
    label: string;
    observedAt: string;
  };
  taskId?: string;
  signalHash?: string;
  receiptHash?: string;
  minerId?: string;
  costUsdCents?: number;
}

export type FindingSeverity = "critical" | "material" | "minor" | "info";

export interface Finding {
  id: string;
  code: string;
  severity: FindingSeverity;
  title: string;
  /** What the recorded evidence shows. */
  explanation: string;
  /** Why it matters for moving this amount, in this transaction. */
  significance: string;
  evidenceIds: string[];
  requiresHuman: boolean;
}

export type DecisionOutcome = "CLEARED" | "HOLD" | "ESCALATE";

export interface Decision {
  outcome: DecisionOutcome;
  rationale: string;
  decidedAt: string;
  criteria: Array<{ id: string; label: string; status: "pass" | "fail" | "missing"; detail: string }>;
  openIssues: number;
  /** TRUE only for a live, cleared file. Never for demo or missing evidence. */
  settlementAuthorized: boolean;
}

/** The verified dimensions the assurance workspace can ask. */
export type AssuranceCapabilityId =
  | "counterparty_registry"
  | "firmographic_enrichment"
  | "sanctions_screening"
  | "regulatory_filings"
  | "document_authenticity"
  | "contract_obligations";

export interface IntelligenceRun {
  taskId: string;
  mode: "free" | "intel";
  createdAt: string;
  taskState: string;
  ceilingUsdCents: number;
  absorbed: boolean;
}

export interface SettlementInstruction {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
  description: string;
}

export interface SettlementRecord {
  id: string;
  preparedAt: string;
  status: "prepared" | "pending_confirmation" | "confirmed_on_chain" | "failed";
  recentBlockhash: string;
  lastValidBlockHeight: number | null;
  sourceTokenAccount: string | null;
  destinationTokenAccount: string | null;
  mint: string;
  amountBaseUnits: string;
  instructions: SettlementInstruction[];
  /** Structural guarantees recorded with the bundle, not claims about it. */
  signedByNightshift: false;
  broadcastByNightshift: false;
  signature: string | null;
  verification: {
    checkedAt: string;
    status: string;
    slot: number | null;
    confirmationStatus: string | null;
    err: string | null;
    rpcUrl: string;
  } | null;
}

export interface InvestigationTransaction {
  payerWallet: string;
  recipientWallet: string;
  amountUsdc: number;
  tokenMint: string;
  jurisdiction: string;
  approvedBeneficiary: string;
  contractRef: string;
  memo: string;
  documents: Array<{ name: string; sha256?: string; note?: string; content?: string }>;
  /** Contract text supplied for an obligation audit; never inferred. */
  contractText?: string;
  /** Beneficial ownership is material to this transfer (default true). */
  ownershipRequired: boolean;
}

export interface Counterparty {
  legalName: string;
  registrationNumber?: string;
  walletLabel?: string;
  contact?: string;
}

export type InvestigationStatus =
  | "draft"
  | "collecting"
  | "assessed"
  | "settlement_prepared"
  | "settled";

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  detail: string;
}

export interface Investigation {
  id: string;
  reference: string;
  createdAt: string;
  updatedAt: string;
  status: InvestigationStatus;
  dataMode: DataMode;
  transaction: InvestigationTransaction;
  counterparty: Counterparty;
  evidence: AssuranceEvidence[];
  findings: Finding[];
  decision: Decision | null;
  intelligenceRuns: IntelligenceRun[];
  settlement: SettlementRecord | null;
  spendLimitUsdCents: number;
  operator: { createdBy: string; tenant: string };
  audit: AuditEntry[];
  limitations: string[];
}

export interface InvestigationSummary {
  id: string;
  reference: string;
  createdAt: string;
  dataMode: DataMode;
  counterparty: string;
  amountUsdc: number;
  status: InvestigationStatus;
  decision: DecisionOutcome | null;
  evidenceCount: number;
  findingCount: number;
}

export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  material: 1,
  minor: 2,
  info: 3,
};
