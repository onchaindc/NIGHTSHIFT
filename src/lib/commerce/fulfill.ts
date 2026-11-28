/**
 * The Agent Commerce engine — what actually happens when a buyer purchases one
 * of the four introductory offerings, and what the Marketplace / Capacity /
 * Workflows / Reseller sections do.
 *
 * Everything here rides infrastructure that already exists and is free:
 *  - records persist through the shared named-document store;
 *  - requirement matching runs against registered capacity services and the
 *    published ACP offerings (READ-ONLY references — the listings are never
 *    altered by matching);
 *  - workflow desk steps open REAL Deal Desk files and run their FREE
 *    pre-flight — probes only, nothing signed, nothing spent. A paid
 *    intelligence run stays where the desk put it: behind the human approval
 *    gate, never triggered automatically from commerce.
 */

import { randomUUID } from "node:crypto";

import { ACP_OFFERINGS } from "@/lib/acp/offerings";
import { parseCreateDeskBody } from "@/lib/desk/create";
import { createDeskRun, reportDeskInvestigation } from "@/lib/desk/orchestrate";
import { getDeskInvestigation, saveDeskInvestigation } from "@/lib/desk/store";
import type { DeskInvestigationType } from "@/lib/desk/types";
import { DESK_TYPE_LABEL, DESK_VERDICT_LABEL } from "@/lib/desk/types";
import { DESK_WORKFLOWS, deskWorkflow, resolveDeskCapability } from "@/lib/desk/workflows";
import { getTask } from "@/lib/engine/store";
import { INTRO_PRICE_USD_CENTS, commerceOfferingById, validateCommerceInput, workflowTemplate } from "./catalog";
import {
  getPackage,
  getRequirement,
  getService,
  getWorkflow,
  listServices,
  listPackages,
  newCommerceId,
  newCommerceReference,
  saveCommerceJob,
  savePackage,
  saveRequirement,
  saveService,
  saveWorkflow,
} from "./store";
import type {
  CapacityService,
  CommerceJob,
  CommerceOffering,
  CommerceResult,
  CommerceWorkflow,
  MarketplaceCategory,
  MarketplaceRequirement,
  PackageComponent,
  RequirementOffer,
  ResellerPackage,
  ServiceAvailability,
  WorkflowStep,
  WorkflowTemplateId,
} from "./types";
import { MARKETPLACE_CATEGORIES, WORKFLOW_TEMPLATE_IDS } from "./types";

const NOW = (): string => new Date().toISOString();

function str(v: unknown, max = 4000): string {
  // Same coercion rule as the catalog validator: JSON numbers stay numbers.
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  return "";
}

/** USD cents from an input value; null unless a positive integer. */
function parseCents(v: unknown): number | null {
  const n = Number(str(v, 20));
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

function note(record: { notes: string[] }, text: string): void {
  record.notes = [...record.notes, `${NOW()} ${text}`.slice(0, 300)].slice(-40);
}

/* ------------------------------------------------------------------ */
/* Matching — requirements × provider services × published offerings   */
/* ------------------------------------------------------------------ */

const CATEGORY_TO_DESK_TYPE: Record<Exclude<MarketplaceCategory, "other">, DeskInvestigationType> = {
  counterparty: "counterparty_due_diligence",
  asset: "asset_intelligence",
  trade_supplier: "trade_supplier_intelligence",
  listing: "listing_underwriter",
};

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "before", "on", "in", "is", "are",
  "we", "our", "need", "needs", "want", "please", "that", "this", "it", "at", "by", "from", "new",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Deterministic matching of a requirement against the board: capacity services
 * score on category fit + keyword overlap; the published ACP offering for the
 * requirement's category is always surfaced as a reference (never altered).
 */
export function matchRequirement(
  requirement: Pick<MarketplaceRequirement, "title" | "detail" | "category">,
  services: CapacityService[],
): { serviceIds: string[]; offeringIds: string[]; note: string } {
  const words = tokens(`${requirement.title} ${requirement.detail}`);
  const deskType = requirement.category === "other" ? null : CATEGORY_TO_DESK_TYPE[requirement.category];

  const scored = services
    .filter((s) => s.status === "listed")
    .map((s) => {
      let score = 0;
      if (s.category === requirement.category) score += 3;
      const serviceWords = new Set(tokens(`${s.name} ${s.summary}`));
      for (const w of words) if (serviceWords.has(w)) score += 1;
      return { id: s.id, score, name: s.name };
    })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const offeringIds = deskType
    ? ACP_OFFERINGS.filter((o) => o.investigationType === deskType).map((o) => o.id)
    : [];

  const parts: string[] = [];
  parts.push(`${scored.length} provider service match(es)`);
  if (offeringIds.length > 0) parts.push(`the published "${DESK_TYPE_LABEL[deskType!]}" offering`);
  return {
    serviceIds: scored.map((s) => s.id),
    offeringIds,
    note: `Auto-match at intake: ${parts.join(" + ") || "no matches yet — the board keeps looking as services register"}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Marketplace — requirements, offers, acceptance                      */
/* ------------------------------------------------------------------ */

export interface RequirementInput {
  title?: unknown;
  category?: unknown;
  detail?: unknown;
  budgetUsdCents?: unknown;
  deadline?: unknown;
}

export async function createRequirement(ownerWallet: string, input: RequirementInput): Promise<CommerceResult<MarketplaceRequirement>> {
  const title = str(input.title, 200);
  const detail = str(input.detail, 4000);
  const category = str(input.category, 40) as MarketplaceCategory;
  if (!title) return { ok: false, error: "a requirement title is required", status: 400 };
  if (!(MARKETPLACE_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: `category must be one of: ${MARKETPLACE_CATEGORIES.join(", ")}`, status: 400 };
  }
  if (!detail) return { ok: false, error: "describe what you need — the detail field is required", status: 400 };
  const budget = input.budgetUsdCents === undefined || input.budgetUsdCents === null || str(input.budgetUsdCents) === ""
    ? null
    : parseCents(input.budgetUsdCents);
  if (input.budgetUsdCents !== undefined && input.budgetUsdCents !== null && str(input.budgetUsdCents) !== "" && budget === null) {
    return { ok: false, error: "budget must be a positive whole number of USD cents", status: 400 };
  }

  const now = NOW();
  const requirement: MarketplaceRequirement = {
    id: newCommerceId(),
    reference: newCommerceReference("requirement"),
    title,
    category,
    detail,
    budgetUsdCents: budget,
    deadline: str(input.deadline, 120) || null,
    ownerWallet: ownerWallet.toLowerCase(),
    status: "open",
    matchedServiceIds: [],
    matchedOfferingIds: [],
    offers: [],
    workflowId: null,
    acceptedOfferId: null,
    delivery: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
  const match = matchRequirement(requirement, await listServices());
  requirement.matchedServiceIds = match.serviceIds;
  requirement.matchedOfferingIds = match.offeringIds;
  note(requirement, match.note);
  await saveRequirement(requirement);
  return { ok: true, value: requirement };
}

export async function offerOnRequirement(input: {
  requirementId: unknown;
  providerWallet: string;
  serviceId?: unknown;
  offeringRef?: unknown;
  message: unknown;
  priceUsdCents: unknown;
}): Promise<CommerceResult<MarketplaceRequirement>> {
  const requirement = await getRequirement(str(input.requirementId, 80));
  if (!requirement) return { ok: false, error: "no such requirement on the board", status: 404 };
  if (requirement.status === "closed") return { ok: false, error: "this requirement is closed", status: 400 };
  if (requirement.ownerWallet === input.providerWallet.toLowerCase()) {
    return { ok: false, error: "you cannot offer on your own requirement", status: 400 };
  }
  const price = parseCents(input.priceUsdCents);
  if (price === null) return { ok: false, error: "offer price must be a positive whole number of USD cents", status: 400 };
  const message = str(input.message, 2000);
  if (!message) return { ok: false, error: "say what you will deliver — the offer message is required", status: 400 };

  const serviceId = str(input.serviceId, 80) || null;
  const offeringRef = str(input.offeringRef, 120) || null;
  if (serviceId) {
    const service = await getService(serviceId);
    if (!service || service.status !== "listed") return { ok: false, error: "the referenced service is not listed", status: 400 };
    if (service.providerWallet !== input.providerWallet.toLowerCase()) {
      return { ok: false, error: "you can only offer your own service listings", status: 403 };
    }
  } else if (offeringRef) {
    if (!ACP_OFFERINGS.some((o) => o.id === offeringRef)) {
      return { ok: false, error: "offeringRef must be a published NIGHTSHIFT offering id", status: 400 };
    }
  } else {
    return { ok: false, error: "an offer must reference your own service listing or a published offering", status: 400 };
  }

  const offer: RequirementOffer = {
    id: randomUUID(),
    serviceId,
    offeringRef,
    providerWallet: input.providerWallet.toLowerCase(),
    message,
    priceUsdCents: price,
    status: "pending",
    createdAt: NOW(),
  };
  requirement.offers.push(offer);
  if (requirement.status === "open") requirement.status = "matched";
  note(requirement, `Offer ${offer.id.slice(0, 8)}: ${price}¢ — ${message.slice(0, 120)}`);
  await saveRequirement(requirement);
  return { ok: true, value: requirement };
}

/**
 * Accept one offer: the requirement is matched, the other offers are declined
 * with their status intact (never deleted — the board keeps its history), and
 * a coordination workflow opens for the job with the accepted offer as its
 * first recorded assignment.
 */
export async function acceptOffer(input: {
  requirementId: unknown;
  offerId: unknown;
  ownerWallet: string;
}): Promise<CommerceResult<{ requirement: MarketplaceRequirement; workflow: CommerceWorkflow | null }>> {
  const requirement = await getRequirement(str(input.requirementId, 80));
  if (!requirement) return { ok: false, error: "no such requirement on the board", status: 404 };
  if (requirement.ownerWallet !== input.ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the requirement owner can accept an offer", status: 403 };
  }
  const offer = requirement.offers.find((o) => o.id === str(input.offerId, 80));
  if (!offer) return { ok: false, error: "no such offer on this requirement", status: 404 };
  if (offer.status !== "pending") return { ok: false, error: "this offer is no longer pending", status: 400 };

  for (const o of requirement.offers) o.status = o.id === offer.id ? "accepted" : o.status === "pending" ? "declined" : o.status;
  requirement.status = "in_progress";
  requirement.acceptedOfferId = offer.id;
  requirement.delivery = null;
  note(requirement, `Offer accepted (${offer.priceUsdCents}¢) — waiting for provider delivery.`);

  const now = NOW();
  const workflow: CommerceWorkflow = {
    id: newCommerceId(),
    reference: newCommerceReference("workflow"),
    ownerWallet: requirement.ownerWallet,
    title: requirement.title,
    goal: `Fulfil the accepted offer on "${requirement.reference}" — ${offer.message.slice(0, 200)}`,
    status: "running",
    steps: [
      {
        id: randomUUID(),
        label: offer.serviceId ? `Coordinate with provider on ${offer.serviceId.slice(0, 8)}` : "Coordinate delivery of the accepted offering",
        kind: "coordination",
        deskType: null,
        subject: null,
        serviceId: offer.serviceId,
        offeringRef: offer.offeringRef,
        requirementId: requirement.id,
        investigationId: null,
        taskId: null,
        status: "pending",
        result: null,
        createdAt: now,
        completedAt: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await saveWorkflow(workflow);
  requirement.workflowId = workflow.id;
  await saveRequirement(requirement);
  return { ok: true, value: { requirement, workflow } };
}


/** Provider submits a concrete delivery record for the accepted offer. */
export async function submitRequirementDelivery(input: {
  requirementId: unknown;
  providerWallet: string;
  note: unknown;
  artifactUrl?: unknown;
}): Promise<CommerceResult<MarketplaceRequirement>> {
  const requirement = await getRequirement(str(input.requirementId, 80));
  if (!requirement) return { ok: false, error: "no such requirement on the board", status: 404 };
  const accepted = requirement.offers.find((offer) => offer.id === requirement.acceptedOfferId && offer.status === "accepted");
  if (!accepted || accepted.providerWallet !== input.providerWallet.toLowerCase()) {
    return { ok: false, error: "only the provider whose offer was accepted can submit delivery", status: 403 };
  }
  if (requirement.status === "closed" || requirement.status === "delivered") {
    return { ok: false, error: "this requirement is already closed or delivered", status: 409 };
  }
  const noteText = str(input.note, 4000);
  if (!noteText) return { ok: false, error: "a delivery note describing the completed work is required", status: 400 };
  const rawUrl = str(input.artifactUrl, 1000);
  let artifactUrl: string | null = null;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
      artifactUrl = parsed.toString();
    } catch {
      return { ok: false, error: "delivery artifact must be a valid http(s) URL", status: 400 };
    }
  }
  requirement.delivery = {
    providerWallet: input.providerWallet.toLowerCase(),
    note: noteText,
    artifactUrl,
    status: "submitted",
    submittedAt: NOW(),
    reviewedAt: null,
    reviewerNote: null,
  };
  requirement.status = "in_progress";
  note(requirement, "Provider submitted delivery for owner review.");
  await saveRequirement(requirement);
  return { ok: true, value: requirement };
}

/** The buyer accepts or rejects the provider's submitted delivery. */
export async function reviewRequirementDelivery(input: {
  requirementId: unknown;
  ownerWallet: string;
  decision: unknown;
  note?: unknown;
}): Promise<CommerceResult<MarketplaceRequirement>> {
  const requirement = await getRequirement(str(input.requirementId, 80));
  if (!requirement) return { ok: false, error: "no such requirement on the board", status: 404 };
  if (requirement.ownerWallet !== input.ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the requirement owner can review delivery", status: 403 };
  }
  if (!requirement.delivery || requirement.delivery.status !== "submitted") {
    return { ok: false, error: "there is no submitted delivery awaiting review", status: 409 };
  }
  const decision = str(input.decision, 20);
  if (decision !== "accept" && decision !== "reject") {
    return { ok: false, error: "decision must be accept or reject", status: 400 };
  }
  requirement.delivery.status = decision === "accept" ? "accepted" : "rejected";
  requirement.delivery.reviewedAt = NOW();
  requirement.delivery.reviewerNote = str(input.note, 2000) || null;
  requirement.status = decision === "accept" ? "delivered" : "in_progress";
  note(requirement, decision === "accept" ? "Buyer accepted provider delivery." : "Buyer rejected provider delivery; provider may resubmit.");
  await saveRequirement(requirement);

  if (requirement.workflowId) {
    const workflow = await getWorkflow(requirement.workflowId);
    if (workflow) {
      const step = workflow.steps.find((candidate) => candidate.requirementId === requirement.id);
      if (step) {
        if (decision === "accept") {
          step.status = "done";
          step.completedAt = NOW();
          step.result = `Buyer accepted delivery for ${requirement.reference}.`;
          if (workflow.steps.every((candidate) => candidate.status === "done")) workflow.status = "completed";
        } else {
          step.status = "pending";
          step.completedAt = null;
          step.result = "Buyer rejected the submitted delivery; provider may resubmit.";
        }
        await saveWorkflow(workflow);
      }
    }
  }
  return { ok: true, value: requirement };
}

export async function closeRequirement(requirementId: unknown, ownerWallet: string): Promise<CommerceResult<MarketplaceRequirement>> {
  const requirement = await getRequirement(str(requirementId, 80));
  if (!requirement) return { ok: false, error: "no such requirement on the board", status: 404 };
  if (requirement.ownerWallet !== ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the requirement owner can close it", status: 403 };
  }
  requirement.status = "closed";
  for (const o of requirement.offers) if (o.status === "pending") o.status = "declined";
  note(requirement, "Requirement closed by its owner.");
  await saveRequirement(requirement);
  return { ok: true, value: requirement };
}

/* ------------------------------------------------------------------ */
/* Capacity — provider service listings                                */
/* ------------------------------------------------------------------ */

export async function createService(providerWallet: string, input: Record<string, unknown>): Promise<CommerceResult<CapacityService>> {
  const name = str(input.name, 200);
  const summary = str(input.summary, 4000);
  const category = str(input.category, 40) as MarketplaceCategory;
  const price = parseCents(input.priceUsdCents);
  if (!name) return { ok: false, error: "a service name is required", status: 400 };
  if (!(MARKETPLACE_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: `category must be one of: ${MARKETPLACE_CATEGORIES.join(", ")}`, status: 400 };
  }
  if (!summary) return { ok: false, error: "describe what you deliver — the summary is required", status: 400 };
  if (price === null) return { ok: false, error: "price must be a positive whole number of USD cents", status: 400 };
  const slaHours = str(input.slaHours) ? Number(str(input.slaHours, 10)) : null;
  if (slaHours !== null && (!Number.isFinite(slaHours) || slaHours <= 0)) {
    return { ok: false, error: "turnaround must be a positive number of hours", status: 400 };
  }

  // Declared capabilities are verified against the matrix; unresolvable keys
  // keep the listing UNVERIFIED and are named — never silently dropped.
  const capabilities = str(input.capabilities, 600)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 12);
  const unresolvable: string[] = [];
  for (const key of capabilities) {
    const [mind, dimension] = key.split(":");
    try {
      resolveDeskCapability({ mind: mind ?? "", dimension: dimension ?? "" });
    } catch {
      unresolvable.push(key);
    }
  }

  const now = NOW();
  const service: CapacityService = {
    id: newCommerceId(),
    reference: newCommerceReference("service"),
    providerWallet: providerWallet.toLowerCase(),
    name,
    category,
    summary,
    priceUsdCents: price,
    availability: "available",
    slaHours: slaHours === null ? null : Math.round(slaHours),
    delivery: str(input.delivery, 2000),
    capabilities,
    verified: capabilities.length > 0 && unresolvable.length === 0,
    status: "listed",
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
  if (capabilities.length === 0) note(service, "No capability keys declared — the listing is discoverable but not matrix-verified.");
  else if (unresolvable.length > 0) note(service, `Unverified: ${unresolvable.join(", ")} did not resolve against the capability matrix.`);
  else note(service, "Every declared capability resolved against the verified matrix — listing verified.");
  await saveService(service);
  return { ok: true, value: service };
}

const AVAILABILITIES: ServiceAvailability[] = ["available", "busy", "paused"];

export async function updateService(input: { id: unknown; providerWallet: string; priceUsdCents?: unknown; availability?: unknown; summary?: unknown }): Promise<CommerceResult<CapacityService>> {
  const service = await getService(str(input.id, 80));
  if (!service) return { ok: false, error: "no such service listing", status: 404 };
  if (service.providerWallet !== input.providerWallet.toLowerCase()) {
    return { ok: false, error: "only the provider can update this listing", status: 403 };
  }
  const changesCommercialTerms = input.priceUsdCents !== undefined || input.availability !== undefined;
  if (changesCommercialTerms) {
    const dependent = (await listPackages()).filter(
      (pkg) => pkg.status === "listed" && pkg.components.some((component) => component.source === "capacity" && component.ref === service.id),
    );
    if (dependent.length > 0) {
      return {
        ok: false,
        error: "this service is included in a listed reseller package; retire or rebuild the dependent package before changing its price or availability",
        status: 409,
      };
    }
  }
  if (input.priceUsdCents !== undefined) {
    const price = parseCents(input.priceUsdCents);
    if (price === null) return { ok: false, error: "price must be a positive whole number of USD cents", status: 400 };
    service.priceUsdCents = price;
  }
  if (input.availability !== undefined) {
    const availability = str(input.availability, 20) as ServiceAvailability;
    if (!AVAILABILITIES.includes(availability)) {
      return { ok: false, error: "availability must be available, busy or paused", status: 400 };
    }
    service.availability = availability;
  }
  if (input.summary !== undefined) {
    const summary = str(input.summary, 4000);
    if (!summary) return { ok: false, error: "the summary cannot be empty", status: 400 };
    service.summary = summary;
  }
  await saveService(service);
  return { ok: true, value: service };
}

export async function retireService(id: unknown, providerWallet: string): Promise<CommerceResult<CapacityService>> {
  const service = await getService(str(id, 80));
  if (!service) return { ok: false, error: "no such service listing", status: 404 };
  if (service.providerWallet !== providerWallet.toLowerCase()) {
    return { ok: false, error: "only the provider can retire this listing", status: 403 };
  }
  const dependent = (await listPackages()).filter(
    (pkg) => pkg.status === "listed" && pkg.components.some((component) => component.source === "capacity" && component.ref === service.id),
  );
  if (dependent.length > 0) {
    return { ok: false, error: "this service is included in a listed reseller package; retire or rebuild the dependent package before retiring the service", status: 409 };
  }
  service.status = "retired";
  service.availability = "paused";
  note(service, "Retired by its provider — it stays in the record but leaves the board.");
  await saveService(service);
  return { ok: true, value: service };
}

/* ------------------------------------------------------------------ */
/* Workflows — multi-agent coordination on one commercial job          */
/* ------------------------------------------------------------------ */

interface TemplateStep {
  label: string;
  deskType: DeskInvestigationType | null;
}

const TEMPLATE_STEPS: Record<Exclude<WorkflowTemplateId, "custom">, TemplateStep[]> = {
  supplier_onboarding: [
    { label: `Counterparty due diligence`, deskType: "counterparty_due_diligence" },
    { label: `Trade & supplier intelligence`, deskType: "trade_supplier_intelligence" },
  ],
  asset_listing_review: [
    { label: `Asset intelligence`, deskType: "asset_intelligence" },
    { label: `Listing underwriting`, deskType: "listing_underwriter" },
  ],
};

function parseCustomSteps(text: string): { ok: true; steps: TemplateStep[] } | { ok: false; error: string } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12);
  if (lines.length === 0) return { ok: false, error: "a custom plan needs at least one step — one per line: Label | deskType" };
  const steps: TemplateStep[] = [];
  for (const [i, line] of lines.entries()) {
    const [label, deskTypeRaw] = line.split("|").map((p) => p.trim());
    if (!label) return { ok: false, error: `step ${i + 1} needs a label before the "|" separator` };
    if (!deskTypeRaw) {
      steps.push({ label: label.slice(0, 160), deskType: null });
      continue;
    }
    if (!deskWorkflow(deskTypeRaw)) {
      return {
        ok: false,
        error: `step ${i + 1}: "${deskTypeRaw}" is not a Deal Desk workflow — use counterparty_due_diligence, asset_intelligence, trade_supplier_intelligence, listing_underwriter, or omit the desk type for a coordination step`,
      };
    }
    steps.push({ label: label.slice(0, 160), deskType: deskTypeRaw as DeskInvestigationType });
  }
  return { ok: true, steps };
}

function newStep(input: { label: string; deskType: DeskInvestigationType | null; subject?: Record<string, string> | null }): WorkflowStep {
  return {
    id: randomUUID(),
    label: input.label,
    kind: input.deskType ? "desk_investigation" : "coordination",
    deskType: input.deskType,
    subject: input.subject ?? null,
    serviceId: null,
    offeringRef: null,
    investigationId: null,
    taskId: null,
    status: "pending",
    result: null,
    createdAt: NOW(),
    completedAt: null,
  };
}

export async function createWorkflow(input: {
  ownerWallet: string;
  title: unknown;
  goal: unknown;
  template: unknown;
  steps?: unknown;
}): Promise<CommerceResult<CommerceWorkflow>> {
  const title = str(input.title, 200);
  const goal = str(input.goal, 4000);
  if (!title) return { ok: false, error: "a job title is required", status: 400 };
  if (!goal) return { ok: false, error: "say what the job must establish — the goal is required", status: 400 };
  const template = workflowTemplate(input.template ?? "custom") ?? (str(input.template) === "" ? "custom" : null);
  if (!template) {
    return { ok: false, error: `template must be one of: ${WORKFLOW_TEMPLATE_IDS.join(", ")}`, status: 400 };
  }

  let built: TemplateStep[];
  if (template === "custom") {
    const parsed = parseCustomSteps(str(input.steps, 4000));
    if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
    built = parsed.steps;
  } else {
    built = TEMPLATE_STEPS[template].map((s) => ({ ...s }));
  }

  const now = NOW();
  const workflow: CommerceWorkflow = {
    id: newCommerceId(),
    reference: newCommerceReference("workflow"),
    ownerWallet: input.ownerWallet.toLowerCase(),
    title,
    goal,
    status: "draft",
    steps: built.map((s) =>
      newStep({
        label: s.label,
        // Template steps ride the workflow's own worked examples; a custom step
        // with a desk type does the same. Samples keep the step runnable without
        // inventing facts — the desk records them as DECLARED inputs.
        deskType: s.deskType,
        subject: s.deskType ? { ...DESK_WORKFLOWS[s.deskType].samples } : null,
      }),
    ),
    createdAt: now,
    updatedAt: now,
  };
  await saveWorkflow(workflow);
  return { ok: true, value: workflow };
}

export async function addWorkflowStep(input: { id: unknown; ownerWallet: string; label: unknown; deskType?: unknown; serviceId?: unknown }): Promise<CommerceResult<CommerceWorkflow>> {
  const wf = await getWorkflow(str(input.id, 80));
  if (!wf) return { ok: false, error: "no such workflow", status: 404 };
  if (wf.ownerWallet !== input.ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the workflow owner can add a step", status: 403 };
  }
  if (wf.status === "completed" || wf.status === "cancelled") {
    return { ok: false, error: "this workflow is closed — start a new one", status: 400 };
  }
  const label = str(input.label, 160);
  if (!label) return { ok: false, error: "a step needs a label", status: 400 };
  if (wf.steps.length >= 12) return { ok: false, error: "a workflow carries at most 12 steps", status: 400 };

  const deskTypeRaw = str(input.deskType, 80);
  const serviceId = str(input.serviceId, 80) || null;
  if (serviceId) {
    const service = await getService(serviceId);
    if (!service || service.status !== "listed") return { ok: false, error: "the referenced service is not listed", status: 400 };
  }
  if (deskTypeRaw && !deskWorkflow(deskTypeRaw)) {
    return { ok: false, error: `"${deskTypeRaw}" is not a Deal Desk workflow type`, status: 400 };
  }
  if (!deskTypeRaw && !serviceId) {
    return { ok: false, error: "a step needs a desk workflow type or a service to assign", status: 400 };
  }
  const step = newStep({
    label,
    deskType: deskTypeRaw ? (deskTypeRaw as DeskInvestigationType) : null,
    subject: deskTypeRaw ? { ...DESK_WORKFLOWS[deskTypeRaw as DeskInvestigationType].samples } : null,
  });
  if (serviceId) step.serviceId = serviceId;
  wf.steps.push(step);
  if (wf.status === "draft") wf.status = "running";
  await saveWorkflow(wf);
  return { ok: true, value: wf };
}

/**
 * Run one step. desk_investigation steps open a REAL Deal Desk file owned by
 * the workflow owner and start its FREE pre-flight (probes only, nothing
 * signed, nothing spent) — the paid run stays parked at the desk's human
 * approval gate and is never triggered from here. Coordination steps record
 * the assignment against the referenced service or offering.
 */
export async function runWorkflowStep(input: { id: unknown; stepId: unknown; ownerWallet: string }): Promise<CommerceResult<CommerceWorkflow>> {
  const wf = await getWorkflow(str(input.id, 80));
  if (!wf) return { ok: false, error: "no such workflow", status: 404 };
  if (wf.ownerWallet !== input.ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the workflow owner can run a step", status: 403 };
  }
  if (wf.status === "cancelled" || wf.status === "completed") {
    return { ok: false, error: "this workflow is closed — start a new one", status: 400 };
  }
  const step = wf.steps.find((s) => s.id === str(input.stepId, 80));
  if (!step) return { ok: false, error: "no such step in this workflow", status: 404 };
  if (step.status === "done") return { ok: false, error: "this step is already done", status: 400 };
  if (step.status === "in_progress" || step.status === "awaiting_approval") {
    return { ok: false, error: "this step is already running — its result appears when the run completes", status: 400 };
  }

  if (step.kind === "coordination") {
    const ref = step.serviceId ?? step.offeringRef ?? "(no assignment)";
    if (step.requirementId) {
      const requirement = await getRequirement(step.requirementId);
      if (!requirement || requirement.status !== "delivered") {
        return { ok: false, error: "provider delivery has not yet been accepted by the requirement owner", status: 409 };
      }
      step.status = "done";
      step.completedAt = NOW();
      step.result = `Delivery accepted for ${requirement.reference}; assignment ${ref} is complete.`;
    } else {
      step.status = "pending";
      step.result = `Assignment recorded against ${ref}${step.offeringRef ? " (published offering)" : ""}. Waiting for the provider to submit delivery evidence.`;
    }
    await saveWorkflow(wf);
    return { ok: true, value: wf };
  }

  // desk_investigation: open the file with the step's subject (template steps
  // carry the workflow's worked examples), then start the free pre-flight.
  const deskType = step.deskType;
  if (!deskType) return { ok: false, error: "this step has no desk workflow type", status: 400 };
  const parsed = parseCreateDeskBody({ type: deskType, subject: step.subject ?? {} }, `commerce:${wf.ownerWallet}`, wf.ownerWallet);
  if (!parsed.ok) {
    step.status = "failed";
    step.result = `the desk refused the inputs: ${parsed.error}`;
    await saveWorkflow(wf);
    return { ok: true, value: wf };
  }
  await saveDeskInvestigation(parsed.investigation);
  const { task } = await createDeskRun(parsed.investigation, "free", {
    actor: `commerce:${wf.reference}`,
    owner: wf.ownerWallet,
  });
  step.investigationId = parsed.investigation.id;
  step.taskId = task.id;
  step.status = task.permissions.requiresApproval ? "awaiting_approval" : "in_progress";
  step.result = `Desk file ${parsed.investigation.reference} opened · free pre-flight task ${task.id} (probes only, nothing spent).`;
  if (wf.status === "draft") wf.status = "running";
  await saveWorkflow(wf);
  return { ok: true, value: wf };
}

/**
 * Sync a workflow against reality: completed pre-flight runs are absorbed into
 * their desk file, the desk's own report is built (free mode), and the step
 * picks up the report's verdict. Failed runs fail the step with the task's own
 * words. Nothing here spends or approves anything.
 */
export async function syncWorkflowSteps(wf: CommerceWorkflow): Promise<{ changed: boolean }> {
  let changed = false;
  for (const step of wf.steps) {
    if (step.kind !== "desk_investigation" || step.status !== "in_progress" || !step.taskId) continue;
    const task = await getTask(step.taskId);
    if (!task) continue;
    if (task.state === "completed") {
      const inv = step.investigationId ? await getDeskInvestigation(step.investigationId) : null;
      if (inv) {
        // reportDeskInvestigation syncs the ledger first, builds the desk's own
        // free-mode report and persists the file — one call, no double writes.
        if (!inv.report) await reportDeskInvestigation(inv, "free");
        const fresh = await getDeskInvestigation(step.investigationId!);
        step.status = "done";
        step.completedAt = NOW();
        step.result = fresh?.report
          ? `Report on ${fresh.reference}: ${DESK_VERDICT_LABEL[fresh.report.assessment.verdict]} · confidence ${fresh.report.confidence}.`
          : `Pre-flight completed for ${fresh?.reference ?? step.investigationId}.`;
      } else {
        step.status = "done";
        step.completedAt = NOW();
        step.result = "Pre-flight completed.";
      }
      changed = true;
    } else if (task.state === "awaiting_approval") {
      step.status = "awaiting_approval";
      step.result = "The run is parked at the human approval gate — nothing is spent until a human approves it there.";
      changed = true;
    } else if (task.state === "failed" || task.state === "blocked" || task.state === "rejected") {
      step.status = "failed";
      step.completedAt = NOW();
      step.result = (task.error ?? "the run failed").slice(0, 240);
      changed = true;
    }
  }
  if (changed && wf.steps.every((s) => s.status === "done")) wf.status = "completed";
  if (changed) await saveWorkflow(wf);
  return { changed };
}

export async function cancelWorkflow(id: unknown, ownerWallet: string): Promise<CommerceResult<CommerceWorkflow>> {
  const wf = await getWorkflow(str(id, 80));
  if (!wf) return { ok: false, error: "no such workflow", status: 404 };
  if (wf.ownerWallet !== ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the workflow owner can cancel it", status: 403 };
  }
  wf.status = "cancelled";
  await saveWorkflow(wf);
  return { ok: true, value: wf };
}

/* ------------------------------------------------------------------ */
/* Reseller — packages of purchased services, priced above their parts */
/* ------------------------------------------------------------------ */

/**
 * Components must resolve to real, currently listed Capacity services.
 * The server supplies the label and price; callers cannot invent either.
 * Input format: one capacity service id per line, prefixed with "capacity:".
 */
async function parseComponents(text: string): Promise<{ ok: true; components: PackageComponent[] } | { ok: false; error: string }> {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12);
  if (lines.length === 0) return { ok: false, error: "a package needs at least one component — add capacity:<service-reference> from the Capacity directory, one per line" };
  const seen = new Set<string>();
  const services = await listServices();
  const components: PackageComponent[] = [];
  for (const [i, line] of lines.entries()) {
    const match = /^capacity:(NS-CAP-[A-F0-9]{8})$/i.exec(line);
    if (!match) return { ok: false, error: `component ${i + 1} must reference a real Capacity listing as capacity:<service-reference>; labels and prices are loaded from the listing` };
    const key = match[1];
    const service = services.find((candidate) => candidate.reference.toLowerCase() === key.toLowerCase()) ?? null;
    if (service && seen.has(service.id)) return { ok: false, error: `component ${i + 1} duplicates a service already in this package` };
    if (service) seen.add(service.id);
    if (!service || service.status !== "listed" || service.availability !== "available") {
      return { ok: false, error: `component ${i + 1} does not reference a currently listed, available Capacity service` };
    }
    components.push({ label: service.name, source: "capacity", ref: service.id, unitPriceUsdCents: service.priceUsdCents });
  }
  return { ok: true, components };
}

/** Refresh source records before repricing so margin never relies on stale prices. */
async function refreshPackageComponents(components: PackageComponent[]): Promise<{ ok: true; components: PackageComponent[] } | { ok: false; error: string }> {
  const refreshed: PackageComponent[] = [];
  for (const [i, component] of components.entries()) {
    if (component.source !== "capacity" || !component.ref) {
      return { ok: false, error: "this package contains legacy components without a verifiable Capacity source; create a new package from current listings before repricing" };
    }
    const service = await getService(component.ref);
    if (!service || service.status !== "listed" || service.availability !== "available") {
      return { ok: false, error: `component ${i + 1} is no longer a listed, available Capacity service; restore the listing before repricing` };
    }
    refreshed.push({ label: service.name, source: "capacity", ref: service.id, unitPriceUsdCents: service.priceUsdCents });
  }
  return { ok: true, components: refreshed };
}
export function packageMargin(components: PackageComponent[], packagePriceUsdCents: number): number {
  return packagePriceUsdCents - components.reduce((sum, c) => sum + c.unitPriceUsdCents, 0);
}

export async function createPackage(input: { ownerWallet: string; name: unknown; summary: unknown; components: unknown; packagePriceUsdCents: unknown }): Promise<CommerceResult<ResellerPackage>> {
  const name = str(input.name, 200);
  const summary = str(input.summary, 4000);
  const price = parseCents(input.packagePriceUsdCents);
  if (!name) return { ok: false, error: "a package name is required", status: 400 };
  if (!summary) return { ok: false, error: "say what the package delivers — the summary is required", status: 400 };
  if (price === null) return { ok: false, error: "package price must be a positive whole number of USD cents", status: 400 };
  const parsed = await parseComponents(str(input.components, 4000));
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  const margin = packageMargin(parsed.components, price);
  if (margin <= 0) {
    const sum = parsed.components.reduce((s, c) => s + c.unitPriceUsdCents, 0);
    return {
      ok: false,
      error: `your package price must sit above the components' standalone sum (${sum}¢) — a package is worth more than its parts or it does not list`,
      status: 400,
    };
  }

  const now = NOW();
  const pkg: ResellerPackage = {
    id: newCommerceId(),
    reference: newCommerceReference("package"),
    ownerWallet: input.ownerWallet.toLowerCase(),
    name,
    summary,
    components: parsed.components,
    packagePriceUsdCents: price,
    marginUsdCents: margin,
    status: "listed",
    createdAt: now,
    updatedAt: now,
  };
  await savePackage(pkg);
  return { ok: true, value: pkg };
}

export async function updatePackage(input: { id: unknown; ownerWallet: string; packagePriceUsdCents?: unknown; summary?: unknown }): Promise<CommerceResult<ResellerPackage>> {
  const pkg = await getPackage(str(input.id, 80));
  if (!pkg) return { ok: false, error: "no such package", status: 404 };
  if (pkg.ownerWallet !== input.ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the package owner can update it", status: 403 };
  }
  if (input.summary !== undefined) {
    const summary = str(input.summary, 4000);
    if (!summary) return { ok: false, error: "the summary cannot be empty", status: 400 };
    pkg.summary = summary;
  }
  if (input.packagePriceUsdCents !== undefined) {
    const price = parseCents(input.packagePriceUsdCents);
    if (price === null) return { ok: false, error: "package price must be a positive whole number of USD cents", status: 400 };
    const refreshed = await refreshPackageComponents(pkg.components);
    if (!refreshed.ok) return { ok: false, error: refreshed.error, status: 409 };
    const margin = packageMargin(refreshed.components, price);
    if (margin <= 0) return { ok: false, error: "the price must stay above the current standalone prices of its Capacity components", status: 400 };
    pkg.components = refreshed.components;
    pkg.packagePriceUsdCents = price;
    pkg.marginUsdCents = margin;
  }
  await savePackage(pkg);
  return { ok: true, value: pkg };
}

export async function retirePackage(id: unknown, ownerWallet: string): Promise<CommerceResult<ResellerPackage>> {
  const pkg = await getPackage(str(id, 80));
  if (!pkg) return { ok: false, error: "no such package", status: 404 };
  if (pkg.ownerWallet !== ownerWallet.toLowerCase()) {
    return { ok: false, error: "only the package owner can retire it", status: 403 };
  }
  pkg.status = "retired";
  await savePackage(pkg);
  return { ok: true, value: pkg };
}

/* ------------------------------------------------------------------ */
/* The internal purchase rail — fulfillment of the four offerings      */
/* ------------------------------------------------------------------ */

/**
 * Fulfill a purchase of one of the four introductory offerings. The purchase
 * settles on the internal credit rail (no wallet signature, no escrow, no
 * on-chain movement) and produces a REAL artifact: a live requirement with
 * matches, a verified-or-flagged service listing, an executable workflow whose
 * first desk step starts its free pre-flight, or a listed reseller package.
 */
export async function fulfillCommercePurchase(input: {
  offeringId: unknown;
  buyerWallet: string;
  input: Record<string, unknown>;
}): Promise<CommerceResult<CommerceJob>> {
  const offering = commerceOfferingById(str(input.offeringId, 80));
  if (!offering) {
    return { ok: false, error: `unknown commerce offering "${str(input.offeringId, 40)}" — the four intro offerings are commerce_marketplace, commerce_capacity, commerce_workflows and commerce_reseller`, status: 400 };
  }
  const validation = validateCommerceInput(offering, input.input ?? {});
  if (!validation.ok) {
    return { ok: false, error: `the purchase does not satisfy ${offering.id}: ${validation.error}`, status: 400 };
  }
  const buyerWallet = input.buyerWallet.toLowerCase();

  const artifact = await (async (): Promise<CommerceResult<{ artifactId: string; artifactReference: string; deliverable: string }>> => {
    switch (offering.section) {
      case "marketplace": {
        const created = await createRequirement(buyerWallet, validation.values);
        return created.ok
          ? { ok: true, value: { artifactId: created.value.id, artifactReference: created.value.reference, deliverable: `Requirement "${created.value.title}" is live on the board with ${created.value.matchedServiceIds.length} service match(es).` } }
          : created;
      }
      case "capacity": {
        const created = await createService(buyerWallet, validation.values);
        return created.ok
          ? { ok: true, value: { artifactId: created.value.id, artifactReference: created.value.reference, deliverable: `Service "${created.value.name}" is ${created.value.verified ? "listed and matrix-verified" : "listed (unverified capability keys — see the listing note)"}.` } }
          : created;
      }
      case "workflows": {
        const created = await createWorkflow({ ownerWallet: buyerWallet, title: validation.values.title, goal: validation.values.goal, template: validation.values.template, steps: validation.values.steps });
        if (!created.ok) return created;
        const wf = created.value;
        const first = wf.steps[0];
        if (first) await runWorkflowStep({ id: wf.id, stepId: first.id, ownerWallet: buyerWallet });
        const fresh = (await getWorkflow(wf.id)) ?? wf;
        const firstResult = fresh.steps[0]?.result ?? "ready to run";
        return {
          ok: true,
          value: {
            artifactId: fresh.id,
            artifactReference: fresh.reference,
            deliverable: `Workflow "${fresh.title}" created with ${fresh.steps.length} step(s) — first step: ${firstResult}`,
          },
        };
      }
      case "reseller": {
        const created = await createPackage({ ownerWallet: buyerWallet, name: validation.values.name, summary: validation.values.summary, components: validation.values.components, packagePriceUsdCents: validation.values.packagePriceUsdCents });
        return created.ok
          ? { ok: true, value: { artifactId: created.value.id, artifactReference: created.value.reference, deliverable: `Package "${created.value.name}" is listed on the board at ${created.value.packagePriceUsdCents}¢ (margin ${created.value.marginUsdCents}¢).` } }
          : created;
      }
    }
  })();

  const now = NOW();
  if (!artifact.ok) {
    // The purchase is recorded as failed WITH its reason — never silently dropped.
    const job: CommerceJob = {
      id: newCommerceId(),
      offeringId: offering.id,
      section: offering.section,
      buyerWallet,
      priceUsdCents: INTRO_PRICE_USD_CENTS,
      rail: "internal_credit",
      settled: false,
      settlementNote: "Nothing settled — the request was refused before fulfillment: " + artifact.error.slice(0, 200),
      input: validation.values,
      deliverable: null,
      status: "failed",
      createdAt: now,
      updatedAt: now,
    };
    await saveCommerceJob(job);
    return artifact;
  }

  const job: CommerceJob = {
    id: newCommerceId(),
    offeringId: offering.id,
    section: offering.section,
    buyerWallet,
    priceUsdCents: INTRO_PRICE_USD_CENTS,
    rail: "internal_credit",
    settled: true,
    settlementNote: "Settled internally by NIGHTSHIFT at the introductory price. No wallet signature was requested; no escrow, no on-chain movement.",
    input: validation.values,
    deliverable: {
      title: `${offering.name} — fulfilled`,
      detail: artifact.value.deliverable,
      artifactId: artifact.value.artifactId,
      artifactReference: artifact.value.artifactReference,
    },
    status: "fulfilled",
    createdAt: now,
    updatedAt: now,
  };
  await saveCommerceJob(job);
  return { ok: true, value: job };
}

/** The storefront-facing shape of an offering purchase (price + honesty note). */
export function offeringRail(offering: CommerceOffering): { priceUsdCents: number; rail: string; note: string } {
  return { priceUsdCents: offering.priceUsdCents, rail: "internal_credit", note: INTRO_PRICE_NOTE };
}

const INTRO_PRICE_NOTE = "Introductory price $0.01 — settled internally. No wallet signature, no escrow, no on-chain movement.";
