/**
 * The four Agent Commerce capabilities inside the Buyer Desk — Marketplace,
 * Capacity, Workflows and Reseller — plus the internal purchase rail that
 * carries their introductory offerings.
 *
 * These records live in the same swappable named-document store as ACP jobs
 * and desk files. Two hard boundaries, by design:
 *
 *  1. They never touch the published ACP listings (src/lib/acp/offerings.ts,
 *     registered with the external Virtuals marketplace) — commerce offerings
 *     are a separate catalog consumed only by the internal rail.
 *  2. A commerce purchase settles on the internal credit rail: no wallet
 *     signature, no escrow, no mainnet movement is requested. The list price
 *     is recorded honestly, and the settlement note says exactly what happened.
 */

import type { AcpServiceInput } from "@/lib/acp/types";
import type { DeskInvestigationType } from "@/lib/desk/types";

/** The four Agent Commerce capabilities, in storefront order. */
export const COMMERCE_SECTIONS = ["marketplace", "capacity", "workflows", "reseller"] as const;
export type CommerceSection = (typeof COMMERCE_SECTIONS)[number];

export const COMMERCE_SECTION_LABEL: Record<CommerceSection, string> = {
  marketplace: "Marketplace",
  capacity: "Capacity",
  workflows: "Workflows",
  reseller: "Reseller",
};

/** Standard result shape for every commerce action — routes stay thin. */
export type CommerceResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

/** One of the four introductory offerings. Deliberately NOT an ACP listing. */
export interface CommerceOffering {
  id: string;
  section: CommerceSection;
  name: string;
  description: string;
  /** Introductory list price, USD cents. */
  priceUsdCents: number;
  inputs: AcpServiceInput[];
  /** What the buyer receives, in honest language. */
  deliverable: string;
  /** Worked example the sample-fill wand one-taps into the purchase form. */
  samples?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Marketplace — published buyer requirements                          */
/* ------------------------------------------------------------------ */

export const MARKETPLACE_CATEGORIES = [
  "counterparty",
  "asset",
  "trade_supplier",
  "listing",
  "other",
] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export type RequirementStatus = "open" | "matched" | "in_progress" | "delivered" | "closed";

export interface RequirementOffer {
  id: string;
  /** A capacity service listing, or a published ACP offering id. */
  serviceId: string | null;
  offeringRef: string | null;
  providerWallet: string;
  message: string;
  priceUsdCents: number;
  status: "pending" | "accepted" | "declined";
  createdAt: string;
}

export interface MarketplaceDelivery {
  providerWallet: string;
  note: string;
  artifactUrl: string | null;
  status: "submitted" | "accepted" | "rejected";
  submittedAt: string;
  reviewedAt: string | null;
  reviewerNote: string | null;
}

export interface MarketplaceRequirement {
  id: string;
  reference: string;
  title: string;
  category: MarketplaceCategory;
  detail: string;
  budgetUsdCents: number | null;
  deadline: string | null;
  ownerWallet: string;
  status: RequirementStatus;
  /** Auto-matched provider services (see fulfill.matchRequirement). */
  matchedServiceIds: string[];
  /** Auto-matched published ACP offering ids (read-only references). */
  matchedOfferingIds: string[];
  offers: RequirementOffer[];
  /** Set when an offer is accepted: the coordination workflow opened for it. */
  workflowId: string | null;
  /** Accepted offer and provider-submitted delivery; optional for legacy records. */
  acceptedOfferId?: string | null;
  delivery?: MarketplaceDelivery | null;
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Capacity — provider service listings                                */
/* ------------------------------------------------------------------ */

export type ServiceAvailability = "available" | "busy" | "paused";

export interface CapacityService {
  id: string;
  reference: string;
  providerWallet: string;
  name: string;
  category: MarketplaceCategory;
  summary: string;
  priceUsdCents: number;
  availability: ServiceAvailability;
  slaHours: number | null;
  /** What a buyer receives; free text, provider-declared. */
  delivery: string;
  /** Capability keys (`mind:dimension`) declared against the verified matrix. */
  capabilities: string[];
  /** True only when every declared capability key resolved against the matrix. */
  verified: boolean;
  status: "listed" | "retired";
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Workflows — multiple agents coordinated on one commercial job       */
/* ------------------------------------------------------------------ */

export type WorkflowStatus = "draft" | "running" | "completed" | "cancelled";

export interface WorkflowStep {
  id: string;
  label: string;
  /** desk_investigation steps ride the existing Deal Desk engine; coordination steps are recorded assignments. */
  kind: "desk_investigation" | "coordination";
  deskType: DeskInvestigationType | null;
  /** The subject for a desk step, exactly as a desk form submission. */
  subject: Record<string, string> | null;
  /** A capacity service (or catalog offering id) assigned to a coordination step. */
  serviceId: string | null;
  offeringRef: string | null;
  /** Marketplace requirement this coordination step is fulfilling, when applicable. */
  requirementId?: string | null;
  investigationId: string | null;
  taskId: string | null;
  status: "pending" | "in_progress" | "awaiting_approval" | "done" | "failed";
  result: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CommerceWorkflow {
  id: string;
  reference: string;
  ownerWallet: string;
  title: string;
  goal: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export const WORKFLOW_TEMPLATE_IDS = ["supplier_onboarding", "asset_listing_review", "custom"] as const;
export type WorkflowTemplateId = (typeof WORKFLOW_TEMPLATE_IDS)[number];

/* ------------------------------------------------------------------ */
/* Reseller — packaged services offered at a higher value              */
/* ------------------------------------------------------------------ */

export interface PackageComponent {
  label: string;
  /** Where the component comes from: a catalog offering, a capacity service, or a past purchase. */
  source: "catalog" | "capacity" | "purchase";
  ref: string | null;
  /** What the component costs when bought separately (USD cents). */
  unitPriceUsdCents: number;
}

export interface ResellerPackage {
  id: string;
  reference: string;
  ownerWallet: string;
  name: string;
  summary: string;
  components: PackageComponent[];
  packagePriceUsdCents: number;
  /** packagePrice − Σ component prices. Reseller packages must be higher-value: this is > 0. */
  marginUsdCents: number;
  status: "draft" | "listed" | "retired";
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* The internal purchase rail                                          */
/* ------------------------------------------------------------------ */

export type CommerceRail = "internal_credit";

export interface CommerceDeliverable {
  title: string;
  detail: string;
  /** Where the artifact lives (e.g. "/buyer?section=workflows" or a record id). */
  artifactId: string | null;
  artifactReference: string | null;
}

/** One introductory purchase, settled on the internal credit rail. */
export interface CommerceJob {
  id: string;
  offeringId: string;
  section: CommerceSection;
  buyerWallet: string;
  /** The list price actually recorded — the intro price, in USD cents. */
  priceUsdCents: number;
  rail: CommerceRail;
  /** Always true on this rail: the intro purchase is settled internally, never on-chain. */
  settled: boolean;
  settlementNote: string;
  /** The validated purchase input, verbatim. */
  input: Record<string, string>;
  deliverable: CommerceDeliverable | null;
  status: "fulfilled" | "failed";
  createdAt: string;
  updatedAt: string;
}
