/**
 * The four introductory Agent Commerce offerings — the purchasable face of the
 * Marketplace / Capacity / Workflows / Reseller sections inside the Buyer Desk.
 *
 * Introductory pricing is $0.01 USDC per offering. These are NIGHTSHIFT-internal
 * offerings on the internal credit rail: they are NOT registered with the
 * Virtuals ACP marketplace and never appear in src/lib/acp/offerings.ts. An
 * existing ACP listing is untouched by this file and by anything that imports it.
 */

import { COMMERCE_SECTIONS, MARKETPLACE_CATEGORIES, WORKFLOW_TEMPLATE_IDS } from "./types";
import type { CommerceOffering, CommerceSection, MarketplaceCategory } from "./types";

/** Introductory price for all four commerce offerings: $0.01. */
export const INTRO_PRICE_USD_CENTS = 1;

export const INTRO_RAIL_NOTE =
  "Introductory price — settled internally by NIGHTSHIFT during the intro period. No wallet signature, no escrow, no on-chain movement is requested.";

const CATEGORIES = MARKETPLACE_CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, " ") }));

/** The four introductory offerings, in section order. */
export const COMMERCE_OFFERINGS: CommerceOffering[] = [
  {
    id: "commerce_marketplace",
    section: "marketplace",
    name: "Marketplace — requirement intake & matching",
    description:
      "Publish what you need to the Agent Commerce board and get it matched against every registered provider service and published offering. Your requirement stays open for offers from any provider.",
    priceUsdCents: INTRO_PRICE_USD_CENTS,
    inputs: [
      { name: "title", label: "Requirement title", kind: "text", required: true, help: "One line a provider can scan, e.g. \"Verify a new supplier before first PO\"." },
      { name: "category", label: "Category", kind: "select", required: true, options: CATEGORIES, help: "Drives the matching — pick the closest fit." },
      { name: "detail", label: "What you need", kind: "textarea", required: true, help: "Scope, depth, what a good answer contains. Recorded verbatim." },
      { name: "budgetUsdCents", label: "Budget in USD cents (optional)", kind: "number", required: false, help: "e.g. 200 = $2.00. Providers see it and pitch under it." },
      { name: "deadline", label: "Deadline (optional)", kind: "text", required: false, help: "Free text, e.g. \"before Friday's PO\"." },
    ],
    deliverable:
      "A live requirement on the marketplace board with auto-matches against registered provider services and the published NIGHTSHIFT offerings, open for provider offers.",
    samples: {
      title: "Verify a new supplier before the first purchase order",
      category: "counterparty",
      detail:
        "Screen the supplier's registry, sanctions and financial standing before we release the first purchase order.",
      budgetUsdCents: "200",
      deadline: "before Friday's PO",
    },
  },
  {
    id: "commerce_capacity",
    section: "capacity",
    name: "Capacity — provider listing registration",
    description:
      "Register what you can deliver, at what price, with what availability. Listings declare their capabilities against NIGHTSHIFT's verified capability matrix and become bookable from the marketplace.",
    priceUsdCents: INTRO_PRICE_USD_CENTS,
    inputs: [
      { name: "name", label: "Service name", kind: "text", required: true, help: "What buyers see on the board, e.g. \"Sanctions screening with source citations\"." },
      { name: "category", label: "Category", kind: "select", required: true, options: CATEGORIES, help: "Which requirements you want matched against this listing." },
      { name: "summary", label: "What you deliver", kind: "textarea", required: true, help: "Scope and depth in plain words. Recorded verbatim." },
      { name: "priceUsdCents", label: "Price in USD cents", kind: "number", required: true, help: "e.g. 150 = $1.50 per delivery." },
      { name: "delivery", label: "What the buyer receives (optional)", kind: "textarea", required: false },
      { name: "slaHours", label: "Turnaround in hours (optional)", kind: "number", required: false },
      { name: "capabilities", label: "Capability keys (optional)", kind: "text", required: false, help: "Comma-separated mind:dimension keys verified against the capability matrix. Unresolvable keys keep the listing unverified — never silently dropped." },
    ],
    deliverable:
      "A live provider service listing with pricing, availability and a verification verdict against the verified capability matrix.",
    samples: {
      name: "Sanctions screening with source citations",
      category: "counterparty",
      summary: "Sanctions and watchlist screening of a named entity with per-source citations and a clear verdict.",
      priceUsdCents: "150",
      delivery: "A screening report with the verdict, per-source citations and named gaps.",
      slaHours: "24",
      capabilities: "",
    },
  },
  {
    id: "commerce_workflows",
    section: "workflows",
    name: "Workflows — multi-agent job setup",
    description:
      "Turn one commercial job into an ordered plan across multiple specialist agents. The first step opens a real Deal Desk file and runs its free pre-flight immediately — real coordination, not a mock.",
    priceUsdCents: INTRO_PRICE_USD_CENTS,
    inputs: [
      { name: "title", label: "Job title", kind: "text", required: true, help: "e.g. \"Onboard supplier ABC before first purchase order\"." },
      { name: "goal", label: "What the job must establish", kind: "textarea", required: true },
      { name: "template", label: "Plan template", kind: "select", required: true, options: [
        { value: "supplier_onboarding", label: "Supplier onboarding — counterparty DD, then trade & supplier intelligence" },
        { value: "asset_listing_review", label: "Asset listing review — asset intelligence, then listing underwriting" },
        { value: "custom", label: "Custom — one step per line, \"Label | deskType\" (empty deskType = coordination step)" },
      ], help: "The templates ride the existing Deal Desk workflows with their worked examples pre-filled." },
      { name: "steps", label: "Custom steps (optional)", kind: "textarea", required: false, help: "One per line: Label | counterparty_due_diligence, asset_intelligence, trade_supplier_intelligence or listing_underwriter. Without a desk type the step records an assignment to coordinate." },
    ],
    deliverable:
      "An executable workflow whose first desk step is opened as a real Deal Desk file with its free pre-flight already running, and whose remaining steps are ready to run in order.",
    samples: {
      title: "Onboard supplier ABC before the first purchase order",
      goal: "Establish that the supplier exists, is not sanctioned, and can be paid safely before the first PO is released.",
      template: "supplier_onboarding",
      steps: "",
    },
  },
  {
    id: "commerce_reseller",
    section: "reseller",
    name: "Reseller — package builder",
    description:
      "Package purchased specialist services into one higher-value offering with your own price. The margin is computed from the components' standalone prices and must be positive — a package is worth more than its parts or it does not list.",
    priceUsdCents: INTRO_PRICE_USD_CENTS,
    inputs: [
      { name: "name", label: "Package name", kind: "text", required: true, help: "e.g. \"Supplier onboarding package\"." },
      { name: "summary", label: "What the package delivers", kind: "textarea", required: true },
      { name: "components", label: "Components", kind: "textarea", required: true, help: "One per line: Component label | standalone price in USD cents. e.g. \"Counterparty DD | 200\"." },
      { name: "packagePriceUsdCents", label: "Your package price in USD cents", kind: "number", required: true, help: "Must be above the sum of the components — the reseller margin is what makes it a business." },
    ],
    deliverable: "A listed reseller package on the marketplace board with its margin computed and validated.",
    samples: {
      name: "Supplier onboarding package",
      summary: "Registry, sanctions and trade-document verification for one new supplier, delivered as one package.",
      components: "Counterparty DD | 200\nTrade & supplier intelligence | 150",
      packagePriceUsdCents: "400",
    },
  },
];

export function commerceOfferingById(id: string): CommerceOffering | undefined {
  return COMMERCE_OFFERINGS.find((o) => o.id === id.trim().toLowerCase());
}

export interface CommerceInputValidation {
  ok: boolean;
  values: Record<string, string>;
  missing: string[];
  error: string | null;
}

function str(v: unknown, max = 4000): string {
  // JSON bodies carry numbers as numbers (a 180-cent price is `180`, not "180");
  // coerce finite numbers like the ACP validator does, drop everything else.
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  return "";
}

/**
 * Validate a purchase input against the offering's schema — same discipline as
 * the ACP requirement validation: required fields present, selects from the
 * option list, numbers numeric, nothing coerced or invented.
 */
export function validateCommerceInput(offering: CommerceOffering, input: Record<string, unknown>): CommerceInputValidation {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of offering.inputs) {
    const value = str(input[field.name], field.kind === "textarea" ? 4000 : 400);
    if (!value) {
      if (field.required) missing.push(field.name);
      continue;
    }
    if (field.kind === "number" && !Number.isFinite(Number(value))) {
      missing.push(field.name);
      continue;
    }
    if (field.kind === "select" && field.options && !field.options.some((o) => o.value === value)) {
      missing.push(field.name);
      continue;
    }
    values[field.name] = value;
  }
  return {
    ok: missing.length === 0,
    values,
    missing,
    error: missing.length > 0 ? `missing or invalid input(s): ${missing.join(", ")}` : null,
  };
}

/** Category of a requirement/service, or null when the value is not one of the board categories. */
export function marketplaceCategory(value: unknown): MarketplaceCategory | null {
  const v = str(value, 40);
  return (MARKETPLACE_CATEGORIES as readonly string[]).includes(v) ? (v as MarketplaceCategory) : null;
}

/** Guard the template select against typos. */
export function workflowTemplate(value: unknown): (typeof WORKFLOW_TEMPLATE_IDS)[number] | null {
  const v = str(value, 40);
  return (WORKFLOW_TEMPLATE_IDS as readonly string[]).includes(v) ? (v as (typeof WORKFLOW_TEMPLATE_IDS)[number]) : null;
}

export function sectionOf(offeringId: string): CommerceSection | null {
  return commerceOfferingById(offeringId)?.section ?? null;
}
