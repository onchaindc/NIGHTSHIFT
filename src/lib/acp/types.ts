/**
 * ACP provider model — NIGHTSHIFT as an intelligence service provider on the
 * Virtuals Agent Commerce Protocol (ERC-8183 jobs on Base).
 *
 * The integration is a thin commercial wrapper around the EXISTING Deal Desk
 * engine: an ACP job is validated against a published offering, mapped to one
 * specialised investigation, executed by the engine's own approval-gated
 * pipeline, and delivered back as a structured, evidence-backed report. This
 * module never re-implements investigation logic.
 *
 * Protocol grounding (the real SDK, not an invented one):
 *   - SDK: `@virtuals-protocol/acp-node-v2` — event-driven (`AcpAgent.on("entry")`),
 *     sessions expose `setBudget` (the provider's acceptance/price act),
 *     `submit(deliverable)` (result delivery) and `sendMessage`; session
 *     statuses are `open → budget_set → funded → submitted → completed |
 *     rejected | expired`; system events are `job.created | budget.set |
 *     job.funded | job.submitted | job.completed | job.rejected | job.expired`;
 *     prices are `AssetToken.usdc(amount, base.id)`. There are no v1-style
 *     phases and NO provider `reject` in v2 — a bad requirement is answered
 *     with a message and never priced, so the buyer can fund nothing.
 *   - Payment: the ACP escrow (the buyer's USDC for the JOB) is a different
 *     rail from Telegraph x402 (the per-answer payment). They are never
 *     conflated: `priceUsdCents` on a job is what the buyer pays for the
 *     investigation; `executionCostUsdCents` is what Telegraph charged us.
 *
 * Financial safety is structural, not aspirational: nothing in this module
 * can approve a paid run. The paid run is CREATED and parked at the existing
 * human approval gate (`requiresApproval`), and only the operator/owner path
 * — the engine's approveTask — can release it.
 */

/** The lifecycle of an ACP job through NIGHTSHIFT. */
export type AcpJobStatus =
  | "received" /** job.created observed; requirement not yet in */
  | "validated" /** requirement parsed against the offering schema */
  | "rejected_intake" /** invalid requirement — never priced, message sent, buyer can fund nothing */
  | "accepted" /** provider priced the job via setBudget — the v2 acceptance act */
  | "funded" /** buyer funded the ACP escrow */
  | "pre_flight" /** free pre-flight running/executed on a real investigation */
  | "awaiting_approval" /** paid run created and PARKED at the human approval gate */
  | "executing" /** approved by a human through the existing gate; engine running */
  | "delivered" /** structured result submitted via the transport; awaiting the evaluator */
  | "completed" /** evaluator approved — the on-chain job settled */
  | "rejected" /** evaluator rejected the deliverable */
  | "expired" /** the buyer never funded, or the job expired */
  | "failed"; /** unrecoverable execution error — buyer messaged, never silently dropped */

/** A session reference — the stable identity of an ACP job on a chain. */
export interface AcpSessionRef {
  chainId: number;
  /** The on-chain job id, as a string (big numbers arrive as strings in JSON). */
  jobId: string;
}

export type AcpSystemEventType =
  | "job.created"
  | "budget.set"
  | "job.funded"
  | "job.submitted"
  | "job.completed"
  | "job.rejected"
  | "job.expired";

/** An entry from the ACP agent, shaped like the v2 SDK's `entry` argument. */
export interface AcpEntry {
  kind: "system" | "message";
  /** Present when kind === "system". */
  event?: { type: AcpSystemEventType };
  /** Present when kind === "message" — e.g. "requirement", "text". */
  contentType?: string;
  content?: string;
  /** Buyer address, when the transport exposes it. */
  clientAddress?: string;
}

export interface AcpTransport {
  mode: "mock" | "real";
  start(handlers: { onEntry: (ref: AcpSessionRef, entry: AcpEntry) => Promise<void> }): Promise<void>;
  stop(): Promise<void>;
  /** The provider's price/acceptance act (v2 `session.setBudget`). */
  setBudget(ref: AcpSessionRef, amountUsdCents: number): Promise<void>;
  /** Deliver the result (v2 `session.submit`). */
  submit(ref: AcpSessionRef, deliverable: string): Promise<void>;
  /** A plain message to the buyer (v2 `session.sendMessage`). */
  sendMessage(ref: AcpSessionRef, content: string): Promise<void>;
}

export interface AcpServiceInput {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

export interface AcpServiceOffering {
  /** The offering name a buyer addresses (also `session.job.description`). */
  id: string;
  /** The NIGHTSHIFT Deal Desk investigation type this offering runs. */
  investigationType: string;
  name: string;
  description: string;
  /** List price for the whole investigation, in USD cents. */
  priceUsdCents: number;
  /** The input schema, derived from the workflow's own form fields. */
  inputs: AcpServiceInput[];
  /** What the buyer receives back. */
  outputs: string;
  /** The execution policy, verbatim — what runs free, what needs whose approval. */
  executionPolicy: string;
}

/** One ACP job, with its NIGHTSHIFT investigation and its money. */
export interface AcpJobRecord {
  /** `${chainId}:${jobId}` — the idempotency key. */
  key: string;
  chainId: number;
  jobId: string;
  offering: string;
  clientAddress: string | null;
  /** The validated requirement payload (the desk subject fields). */
  requirement: Record<string, string> | null;
  /** Raw requirement content, retained verbatim for dispute resolution. */
  rawRequirement: string | null;
  status: AcpJobStatus;
  statusDetail: string;
  priceUsdCents: number | null;
  /** What Telegraph actually charged for the underlying investigation. */
  executionCostUsdCents: number;
  /** The ACP escrow: set true only when the evaluator completes the job. */
  settlementUsdCents: number | null;
  settlementSettled: boolean;
  investigationId: string | null;
  /** The investigation's runs (free pre-flight and the approval-gated paid run). */
  taskIds: string[];
  deliverable: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  fundedAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
}

/** Everything the status endpoint and UI need about the provider connection. */
export interface AcpProviderStatus {
  /** "real" = live transport configured and started; "mock" = in-process
   *  transport for the vertical slice; "disabled" = provider off. */
  mode: "real" | "mock" | "disabled";
  /** True only when ACP_ENABLED is set — the operator's explicit switch. */
  enabled: boolean;
  /** Whether the v2 SDK is installed in this deployment (checked without importing). */
  sdkInstalled: boolean;
  credentials: {
    walletAddress: boolean;
    walletId: boolean;
    signerKey: boolean;
  };
  agentWalletAddress: string | null;
  chainId: number;
  note: string;
}
