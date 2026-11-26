import { newDeskInvestigationId, newDeskReference, auditDesk } from "./store";
import { DESK_WORKFLOWS, deskWorkflow, resolveDeskGap, capabilityKey } from "./workflows";
import type { DeskInvestigation, DeskInvestigationType, DeskUnsupportedRequirement } from "./types";
import { DESK_TYPE_LABEL } from "./types";

const DEFAULT_SPEND_LIMIT_USD_CENTS = 10; // $0.10

export interface CreateDeskBody {
  type?: unknown;
  subject?: unknown;
  spendLimitUsdCents?: unknown;
}

function str(v: unknown, max = 600): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function deskSubjectLine(inv: DeskInvestigation): string {
  switch (inv.type) {
    case "counterparty_due_diligence":
      return `${inv.subject.legalName ?? "Unnamed counterparty"} · ${inv.subject.jurisdiction ?? "?"}`;
    case "asset_intelligence":
      return `${inv.subject.assetName ?? "Unnamed asset"} · ${inv.subject.assetClass ?? "?"}`;
    case "trade_supplier_intelligence":
      return `${inv.subject.supplierName ?? "Unnamed supplier"} · ${inv.subject.jurisdiction ?? "?"}`;
  }
}

/** Declared-input evidence: the form answers, labelled as operator input. */
export function declaredInputEvidence(inv: DeskInvestigation) {
  const workflow = DESK_WORKFLOWS[inv.type];
  return workflow.fields
    .filter((f) => f.name !== "spendLimitUsdCents")
    .filter((f) => (inv.subject[f.name] ?? "").trim().length > 0)
    .map((f) => ({
      id: `declared:${f.name}`,
      provenance: "unverified" as const,
      class: "declared" as const,
      capability: "operator_input",
      label: f.label,
      title: `Declared input · ${f.label}`,
      detail: `Supplied by the caller and recorded verbatim. Declared inputs are never verified by this workflow${f.unlocks?.length ? `; they unlock ${f.unlocks.join(", ")}.` : "."}`,
      facts: { value: inv.subject[f.name].slice(0, 400) },
      source: { kind: "operator" as const, ref: f.name, label: "guided form", observedAt: inv.createdAt },
    }));
}

export function parseCreateDeskBody(
  body: CreateDeskBody,
  createdBy = "operator",
  owner: string | null = null,
): { ok: true; investigation: DeskInvestigation } | { ok: false; error: string } {
  const type = str(body.type, 80) as DeskInvestigationType;
  if (!deskWorkflow(type)) {
    return { ok: false, error: `unknown investigation type: ${type || "(missing)"}` };
  }
  if (typeof body.subject !== "object" || body.subject === null || Array.isArray(body.subject)) {
    return { ok: false, error: "subject (the guided form answers) is required" };
  }
  const rawSubject = body.subject as Record<string, unknown>;
  const workflow = DESK_WORKFLOWS[type];

  const subject: Record<string, string> = {};
  for (const field of workflow.fields) {
    const value = str(rawSubject[field.name], field.kind === "textarea" ? 4000 : 400);
    if (field.required && !value) {
      return { ok: false, error: `${field.label} is required` };
    }
    if (field.kind === "number" && value && !Number.isFinite(Number(value))) {
      return { ok: false, error: `${field.label} must be a number` };
    }
    if (field.kind === "select" && value && field.options && !field.options.some((o) => o.value === value)) {
      return { ok: false, error: `${field.label} must be one of: ${field.options.map((o) => o.label).join(", ")}` };
    }
    if (value) subject[field.name] = value;
  }

  const limit = Number(body.spendLimitUsdCents ?? subject.spendLimitUsdCents);
  const spendLimitUsdCents = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : DEFAULT_SPEND_LIMIT_USD_CENTS;

  // Declared unsupported requirements, resolved from the verified matrix.
  const unsupported: DeskUnsupportedRequirement[] = workflow.gapRefs.map((ref) => {
    const gap = resolveDeskGap(ref);
    return {
      capabilityKey: capabilityKey(ref),
      label: gap.label,
      requirement: gap.requirement,
      reason: gap.missingReason ?? "unsupported on the network",
      resolution: gap.resolution ?? "keep it named as a gap — when a verifiable source exists outside Telegraph, attach it as operator evidence instead of inferring the fact.",
    };
  });

  const now = new Date().toISOString();
  const investigation: DeskInvestigation = {
    id: newDeskInvestigationId(),
    reference: newDeskReference(type),
    kind: "desk",
    type,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    dataMode: "live",
    owner: owner ? owner.toLowerCase() : null,
    subject,
    unsupported,
    evidence: [],
    findings: [],
    report: null,
    runs: [],
    spendLimitUsdCents,
    operator: { createdBy, tenant: "nightshift-deal-desk" },
    audit: [],
  };

  auditDesk(
    investigation,
    createdBy,
    "desk_investigation_created",
    `${DESK_TYPE_LABEL[type]} file opened · ${deskSubjectLine(investigation)} · ${unsupported.length} named unsupported requirement(s).`,
  );
  return { ok: true, investigation };
}
