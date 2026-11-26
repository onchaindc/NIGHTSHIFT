/**
 * Deal Desk investigation orchestration.
 *
 * The shared layer all three specialised workflows run through:
 *
 *   plan     — interpret the guided-form subject into a capability plan:
 *              which verified matrix dimensions to ask, with which params,
 *              and which requirements cannot be asked (declared gaps, or
 *              required inputs the caller never supplied)
 *   execute  — an ordinary engine task (`jobType: "capability_run"`), so the
 *              run inherits the approval gate, the spend ledger, the per-ask
 *              drift check and the node-signal verification
 *   absorb   — translate completed runs into the evidence ledger with
 *              explicit provenance (verified / unverified / missing)
 *   report   — findings, discrepancies, sections, confidence limitations and
 *              outstanding questions, built from recorded evidence only
 *
 * Nothing here invents a capability, a source, a verification result or a
 * completed investigation. Analysis is labelled as analysis and cites the
 * evidence it used.
 */

import { createTask, defaultDeps, EngineError } from "@/lib/engine/engine";
import { getTask, saveTask } from "@/lib/engine/store";
import type { PlanStep, TaskRecord, VerificationCriteria } from "@/lib/engine/types";
import { capabilityKey, DESK_WORKFLOWS, resolveDeskCapability } from "./workflows";
import { auditDesk, saveDeskInvestigation } from "./store";
import { declaredInputEvidence, deskSubjectLine } from "./create";
import type { DeskRunConfig } from "./execute";
import type {
  DeskAssessment,
  DeskConfidence,
  DeskDiscrepancy,
  DeskEvidence,
  DeskFinding,
  DeskInvestigation,
  DeskNextAction,
  DeskReport,
  DeskReportSection,
  DeskSeverity,
  DeskUnsupportedRequirement,
  DeskVerdict,
  ProvenanceClass,
} from "./types";
import { DESK_TYPE_LABEL } from "./types";

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

export interface PlannedCapability {
  key: string;
  params: Record<string, unknown>;
}

export interface PlannedInputGap {
  key: string;
  label: string;
  required: string[];
}

export interface DeskPlan {
  capabilities: PlannedCapability[];
  inputGaps: PlannedInputGap[];
  unsupported: DeskUnsupportedRequirement[];
  declared: DeskEvidence[];
}

/**
 * Interpret the subject into the capability plan. A capability whose required
 * inputs were not supplied is a NAMED input gap, never a silent skip and
 * never an approximate ask.
 */
export function planDeskCapabilities(inv: DeskInvestigation): DeskPlan {
  const workflow = DESK_WORKFLOWS[inv.type];
  const capabilities: PlannedCapability[] = [];
  const inputGaps: PlannedInputGap[] = [];

  for (const ref of workflow.capabilities) {
    if (ref.when && !ref.when(inv.subject)) continue;
    const dim = resolveDeskCapability(ref);
    const key = capabilityKey(ref);
    if (dim.status === "gap" || !dim.intent) {
      // The matrix gap list is the declared-unsupported ledger; a capability
      // reference must never point at a gap (workflows.ts asserts this).
      continue;
    }
    const params = ref.params(inv.subject);
    if (!params) {
      inputGaps.push({
        key,
        label: dim.label,
        required: Object.entries(dim.params ?? {})
          .filter(([, spec]) => spec.required)
          .map(([name, spec]) => `${name} (${spec.description})`),
      });
      continue;
    }
    capabilities.push({ key, params });
  }

  return {
    capabilities,
    inputGaps,
    unsupported: inv.unsupported,
    declared: declaredInputEvidence(inv),
  };
}

/* ------------------------------------------------------------------ */
/* Run creation (engine task)                                          */
/* ------------------------------------------------------------------ */

/**
 * Creates the run for this file. A paid run always stops at
 * `awaiting_approval`; approval uses the existing
 * POST /api/tasks/:id/action {action:"approve"} gate. A free run executes
 * immediately and probes only.
 */
export async function createDeskRun(
  inv: DeskInvestigation,
  mode: "free" | "intel",
  opts: { spendLimitUsdCents?: number; actor?: string; owner?: string | null } = {},
): Promise<{ task: TaskRecord; accepted: boolean }> {
  const plan = planDeskCapabilities(inv);
  if (plan.capabilities.length === 0) {
    throw new EngineError(
      "this file has no capability with complete inputs, so no run was planned — supply the missing form answers first",
    );
  }

  const config: DeskRunConfig = {
    investigationId: inv.id,
    reference: inv.reference,
    type: inv.type,
    mode,
    capabilities: plan.capabilities.map((c) => {
      const [mind, dimension] = c.key.split(":");
      return { key: c.key, mind: mind ?? "", dimension: dimension ?? "" };
    }),
    inputs: Object.fromEntries(plan.capabilities.map((c) => [c.key, c.params])),
  };
  const target = JSON.stringify(config);
  const paid = mode === "intel";

  const criteria: VerificationCriteria = {
    primaryVerifiedAgainstNodeSignal: paid,
    answerSane: paid,
    answerMaxAgeSeconds: 3600,
    ownPaymentSettledOnChain: false,
    reconcileLedgerEntries: paid,
    goalIntent: "information",
    primarySource: paid ? "telegraph" : "free",
  };

  const steps: PlanStep[] = [
    {
      id: "desk-baseline",
      kind: "desk_baseline",
      description: `Unpaid pre-flight for ${inv.reference}: probe ${config.capabilities.length} planned dimension(s) with their canonical schema and record the live price; nothing is signed`,
      target,
    },
  ];
  if (paid) {
    steps.push({
      id: "desk-intel",
      kind: "desk_intel",
      description: `PAID intelligence for ${inv.reference}: one attempt per planned dimension, each drift-checked against its approved offer and guarded by the plan's ceiling`,
      target,
      maxCostUsdCents: opts.spendLimitUsdCents ?? inv.spendLimitUsdCents,
    });
  }
  steps.push({
    id: "desk-report",
    kind: "desk_report",
    description: "Per-dimension status ledger from the recorded signals and receipts; refused or unverified answers never become findings",
    target,
  });

  const task = await createTask({
    goal: `${DESK_TYPE_LABEL[inv.type]} ${paid ? "intelligence" : "pre-flight"} · ${inv.reference} · ${deskSubjectLine(inv)}`,
    spendLimitUsdCents: opts.spendLimitUsdCents ?? inv.spendLimitUsdCents,
    requiresApproval: paid,
    origin: { source: "web" },
    jobType: "capability_run",
    plan: steps,
    criteria,
    // Ownership follows the file, so the requesting wallet can approve its own
    // run — the same model as Minds and settlement files.
    ...(opts.owner ? { owner: opts.owner.toLowerCase() } : {}),
    assumptions: [
      ...DESK_WORKFLOWS[inv.type].honestyNotes,
      "paid asks are one attempt each, pinned to their provider and refused if the live offer drifts from the approved one",
      paid
        ? "nothing is signed until a human approves this exact plan"
        : "free mode plans no purchase and spends nothing",
    ],
  });

  task.labels = [...(task.labels ?? []), `desk:${inv.id}`, `desk-type:${inv.type}`, `desk-mode:${mode}`];
  await saveTask(task);

  if (task.state === "executing") {
    void runTaskQuietly(task.id);
  }

  inv.runs.push({
    taskId: task.id,
    mode,
    createdAt: new Date().toISOString(),
    taskState: task.state,
    ceilingUsdCents: task.spend.limitUsdCents,
    absorbed: false,
  });
  auditDesk(inv, opts.actor ?? "operator", "desk_run_created", `${mode} run ${task.id} at ${task.state} · ${plan.capabilities.length} planned capability(ies), ${plan.inputGaps.length} input gap(s).`);
  if (inv.status === "draft") inv.status = "collecting";
  await saveDeskInvestigation(inv);

  return { task, accepted: task.state === "executing" };
}

async function runTaskQuietly(taskId: string): Promise<void> {
  const { runTask } = await import("@/lib/engine/engine");
  runTask(taskId, defaultDeps()).catch((err) =>
    console.error("desk free run failed:", err instanceof Error ? err.message : err),
  );
}

/* ------------------------------------------------------------------ */
/* Evidence absorption                                                 */
/* ------------------------------------------------------------------ */

function factsFromValues(values: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).slice(0, 8).join("; ");
    else out[k] = JSON.stringify(v).slice(0, 400);
  }
  return out;
}

function gapEvidence(inv: DeskInvestigation): DeskEvidence[] {
  const observedAt = inv.createdAt;
  return inv.unsupported.map((gap) => ({
    id: `gap:${gap.capabilityKey}`,
    provenance: "missing" as const,
    class: "missing" as const,
    capability: gap.capabilityKey,
    label: gap.label,
    title: `${gap.label} · unsupported on the network`,
    detail: `${gap.reason} Resolution: ${gap.resolution}`,
    facts: {},
    source: { kind: "none" as const, ref: gap.capabilityKey, label: "named network gap", observedAt },
  }));
}

function inputGapEvidence(inv: DeskInvestigation, gaps: Array<{ key: string; label: string; required: string[] }>, taskId?: string): DeskEvidence[] {
  const observedAt = new Date().toISOString();
  return gaps.map((gap) => ({
    id: `input-gap:${gap.key}`,
    provenance: "missing" as const,
    class: "missing" as const,
    capability: gap.key,
    label: gap.label,
    title: `${gap.label} · not asked (inputs missing)`,
    detail: `This capability was planned for the workflow but the required inputs were not supplied: ${gap.required.join("; ")}. Nothing was approximated or guessed.`,
    facts: {},
    source: { kind: "none" as const, ref: gap.key, label: "missing inputs", observedAt },
    ...(taskId ? { taskId } : {}),
  }));
}

/**
 * Pull completed runs into the evidence ledger. Idempotent per run: a run is
 * absorbed once, and an answer is provenance-verified only when its
 * committed payload re-derived against the node signal (or was recorded by
 * the node with a retained signal).
 */
export async function syncDeskInvestigation(inv: DeskInvestigation): Promise<{ added: number; notes: string[] }> {
  const notes: string[] = [];
  let added = 0;

  const plan = planDeskCapabilities(inv);
  if (inv.evidence.length === 0) {
    // Seed the ledger: declared inputs and named missing evidence, so a file
    // that never ran still tells the truth about what it holds.
    inv.evidence.push(...plan.declared, ...gapEvidence(inv), ...inputGapEvidence(inv, plan.inputGaps));
    added += plan.declared.length + inv.unsupported.length + plan.inputGaps.length;
    notes.push(`Seeded ${plan.declared.length} declared input(s), ${inv.unsupported.length} unsupported requirement(s), ${plan.inputGaps.length} input gap(s).`);
  }

  for (const run of inv.runs) {
    const task = await getTask(run.taskId);
    if (!task) {
      notes.push(`Run ${run.taskId} is no longer in the task store; its evidence cannot be recovered.`);
      continue;
    }
    run.taskState = task.state;
    if (run.absorbed) continue;
    if (task.state === "failed" || task.state === "blocked" || task.state === "rejected") {
      notes.push(`Run ${run.taskId} ended ${task.state}; no intelligence was absorbed from it.`);
      continue;
    }
    const report = task.result?.capabilityReport;
    if (!report) continue;

    for (const dim of report.dimensions) {
      const key = dim.dimension;
      const exists = inv.evidence.some((e) => e.capability === key && e.id.startsWith(run.taskId));
      if (exists) continue;
      if (dim.status === "gap") {
        // Declared gaps were seeded already; a run-time gap that was not
        // declared means the plan itself drifted — record it honestly.
        if (!inv.evidence.some((e) => e.capability === key && e.provenance === "missing")) {
          inv.evidence.push({
            id: `${run.taskId}:${key}:gap`,
            provenance: "missing",
            class: "missing",
            capability: key,
            label: dim.label,
            title: `${dim.label} · unsupported`,
            detail: dim.detail,
            facts: {},
            source: { kind: "none", ref: key, label: "named network gap", observedAt: report.preparedAt },
            taskId: run.taskId,
          });
          added += 1;
        }
        continue;
      }
      if (dim.status === "verified" || dim.status === "recorded") {
        if (!dim.signalHash) {
          notes.push(`${dim.label}: ${dim.status} without a signal hash, so it is not admissible.`);
          continue;
        }
        inv.evidence.push({
          id: `${run.taskId}:${key}`,
          provenance: "verified",
          class: "node_verified",
          capability: key,
          label: dim.label,
          title: dim.label,
          detail: `${dim.detail}${dim.missingFields?.length ? ` Missing fields: ${dim.missingFields.join(", ")}.` : ""}`,
          facts: factsFromValues(dim.values),
          source: {
            kind: "telegraph",
            ref: dim.signalHash,
            label: `${dim.provider ?? "router"} · ${dim.intent ?? "intent"}`,
            observedAt: dim.verifiedAt ?? report.preparedAt,
          },
          taskId: run.taskId,
          signalHash: dim.signalHash,
          receiptHash: dim.receiptHash,
          minerId: dim.provider,
          costUsdCents: dim.priceUsdCents,
          missingFields: dim.missingFields,
          viaRouterFallback: dim.viaRouterFallback,
        });
        added += 1;
        continue;
      }
      if (dim.status === "unverified") {
        inv.evidence.push({
          id: `${run.taskId}:${key}:unverified`,
          provenance: "unverified",
          class: "paid_unverified",
          capability: key,
          label: dim.label,
          title: `${dim.label} · paid answer that could not be verified`,
          detail: dim.detail,
          facts: {},
          source: { kind: "telegraph", ref: dim.intent ?? key, label: `${dim.provider ?? "router"} paid answer`, observedAt: report.preparedAt },
          taskId: run.taskId,
          ...(dim.signalHash ? { signalHash: dim.signalHash } : {}),
          ...(dim.receiptHash ? { receiptHash: dim.receiptHash } : {}),
          costUsdCents: dim.priceUsdCents,
        });
        added += 1;
        continue;
      }
      // routable_unverified: route and price verified by the free probe only.
      inv.evidence.push({
        id: `${run.taskId}:${key}:probe`,
        provenance: "unverified",
        class: "probe_verified",
        capability: key,
        label: dim.label,
        title: `${dim.label} · route verified, no answer purchased`,
        detail: dim.detail,
        facts: { intent: dim.intent ?? "", provider: dim.provider ?? "", priceUsdCents: dim.priceUsdCents ?? 0 },
        source: {
          kind: "telegraph",
          ref: dim.intent ?? "unpaid probe",
          label: `${dim.provider ?? "router"} unpaid probe`,
          observedAt: report.preparedAt,
        },
        taskId: run.taskId,
      });
      added += 1;
    }
    run.absorbed = true;
    notes.push(`Absorbed ${report.counts.verified} verified and ${report.counts.routable_unverified} probe-only dimension(s) from run ${run.taskId}.`);
  }

  return { added, notes };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOTABLE: Array<{
  match: (capability: string, facts: Record<string, string | number | boolean | null>) => DeskSeverity | null;
  title: (facts: Record<string, string | number | boolean | null>) => string;
  significance: string;
}> = [
  {
    match: (capability, facts) =>
      /name_screening|sanctions|vessel_screening/.test(capability) && facts.matched === true ? "critical" : null,
    title: (facts) =>
      `Sanctions name match${typeof facts.lists === "string" && facts.lists ? ` (${facts.lists})` : typeof facts.list_name === "string" ? ` (${facts.list_name})` : ""}`,
    significance:
      "A sanctions list matched a name in this file at the provider. Treat the file as blocked pending human review; a name screen is probabilistic and is not a legal determination, and for a controller or vessel the match is name-based only.",
  },
  {
    match: (capability, facts) => (/registry/.test(capability) && facts.active === false ? "material" : null),
    title: () => "Registry record is not active",
    significance:
      "The official register does not show the entity as active. Resolve the status before any payment or contract relies on this identity.",
  },
  {
    match: (capability, facts) => (/tx_risk/.test(capability) && typeof facts.risk_level === "string"
      ? /high|critical|severe/i.test(facts.risk_level)
        ? "critical"
        : /medium|elevated/i.test(facts.risk_level)
          ? "material"
          : null
      : null),
    title: (facts) => `Transaction risk flagged (${String(facts.risk_level)})`,
    significance:
      "The risk provider flagged the transaction. A provider risk score is a judgment, not an attribution; review the signals with the cited evidence.",
  },
  {
    match: (capability, facts) => (/invoice_reconcile/.test(capability) && facts.reconciled === false ? "material" : null),
    title: () => "Invoice does not reconcile with the ledger",
    significance:
      "The provider reports a reconciliation discrepancy. Do not release payment against it; the recorded explanation and evidence sit with the finding.",
  },
  {
    match: (capability, facts) => (/po_verify/.test(capability) && facts.verified === false ? "material" : null),
    title: () => "Purchase order could not be verified",
    significance:
      "The source system did not confirm the purchase order as asked. Confirm the reference and vendor with the source system before relying on it.",
  },
  {
    match: (capability, facts) => (/vendor_identity/.test(capability) && facts.valid === false ? "material" : null),
    title: (facts) => `VAT identity does not validate${typeof facts.vat_number === "string" ? ` (${facts.vat_number})` : ""}`,
    significance:
      "The tax registration could not be validated for this entity. Until the supplier supplies a correct registration, the chain between the invoice you hold and the entity you screened is broken — hold payment-relevant decisions on it.",
  },
  {
    match: (capability, facts) => (/wash_trading/.test(capability) && typeof facts.verdict === "string" && /wash/i.test(facts.verdict) ? "material" : null),
    title: (facts) => `Wash-trading signals reported (${String(facts.verdict)})`,
    significance:
      "The provider's heuristic reports wash-trading patterns. It is not proof of intent; read the signals with the evidence.",
  },
  {
    match: (capability, facts) => (/adverse_media/.test(capability) && typeof facts.result_count === "number" && facts.result_count > 0 ? "minor" : null),
    title: (facts) => `Adverse-coverage search returned ${facts.result_count} item(s)`,
    significance:
      "The search returned press coverage for this subject. Coverage is not adjudication and a news item is not a court record — review the cited sources for matters material to the relationship.",
  },
  {
    match: (capability, facts) => (/fact_check/.test(capability) && typeof facts.verdict === "string" && facts.verdict.length > 0 ? "minor" : null),
    title: (facts) => `Claim check verdict: ${String(facts.verdict)}`,
    significance:
      "The provider's verdict on public support for the declared claim, reported verbatim. It checks public sources; it is not a legal determination.",
  },
];

/**
 * Why this record matters for the decision the workflow serves. Per
 * capability family, not generic — the significance names the decision the
 * record feeds (onboarding, payment release, investment screening).
 */
function significanceFor(capability: string): string {
  if (/counterparty-intelligence:registry|entity_registry|party_registry|owner_registry|operator_registry|counterparty_registry|index-reconstitution-desk:registry/.test(capability)) {
    return "The registry record anchors the entity's legal identity — contracts, payments and screening should name the entity exactly as registered. Read it with the cited signal.";
  }
  if (/vendor_identity/.test(capability)) {
    return "A validated VAT registration ties the trading name to a tax identity; it is the cheapest independent check that the entity you screened is the entity that invoices you. It is not beneficial ownership.";
  }
  if (/b2b_enrichment/.test(capability)) {
    return "Firmographics disambiguate same-name entities and give scale context. The pinned provider is an aggregator, so treat the fields as leads, not confirmed facts, until reconciled.";
  }
  if (/name_screening|sanctions|vessel_screening/.test(capability)) {
    return "A sanctions screen is a hard gate in onboarding and payment flows: a match blocks, a clean screen narrows but never closes the question, because name screens miss aliases and transliterations.";
  }
  if (/filings|regulatory_filings/.test(capability)) {
    return "Filings show what the entity publicly disclosed in the period. They are source-linked, not adjudicated — read them against the claims the counterparty makes.";
  }
  if (/adverse_media/.test(capability)) {
    return "Adverse coverage flags relationship risk that registries cannot: disputes, investigations, incidents. Press coverage is not adjudication — the sources decide, not the count.";
  }
  if (/fact_check/.test(capability)) {
    return "The claim check tests public support for one declared claim; it bounds how far the counterparty's own statement can be relied on, nothing more.";
  }
  if (/wallet_balance|onchain_metric/.test(capability)) {
    return "The on-chain read is the network's own record of holdings at the stated chain and block — the baseline every custody or treasury claim in the file is checked against.";
  }
  if (/tx_lookup/.test(capability)) {
    return "The transaction record ties the hash to its on-chain facts — parties, value and status — so the rest of the file reasons about a real movement of funds, not a described one.";
  }
  if (/tx_risk/.test(capability)) {
    return "Risk signals on the transaction bear directly on whether to accept the funds or the counterparty behind them. The score is a provider judgment, not an attribution.";
  }
  if (/holder_concentration|holders/.test(capability)) {
    return "Holder supply context is first-order for token investment screening: distribution and holder base size bound how the asset can trade. The canonical answer is a count, not a top-holder table.";
  }
  if (/supply/.test(capability)) {
    return "Total supply grounds every per-token valuation and the stated-vs-verified comparison. It is not circulating float, which the network cannot ask.";
  }
  if (/index-reconstitution-desk:price|btc_price/.test(capability)) {
    return "The verified USD price fixes the market value used in this file at an observed moment — declared or stale prices never substitute for it.";
  }
  if (/liquidity/.test(capability)) {
    return "Pool depth bounds exit size for the position; thin liquidity is a material investment constraint even when the token's price looks stable.";
  }
  if (/wash_trading/.test(capability)) {
    return "Wash-trading signals bear on whether recorded volume reflects real demand. A heuristic verdict is not proof of intent.";
  }
  if (/po_verify/.test(capability)) {
    return "A verified purchase order is the contractual baseline payment release is checked against; an unverifiable PO stops the payment chain here.";
  }
  if (/invoice_reconcile/.test(capability)) {
    return "Invoice-to-ledger reconciliation is the last automated check before money leaves; a failed reconcile is a payment stopper, not a footnote.";
  }
  if (/commerce_verify/.test(capability)) {
    return "The commerce order record confirms the order and its amount at the merchant — the counterpart of the invoice in consumer-style flows.";
  }
  if (/delivery_window|package_status|vessel_telemetry/.test(capability)) {
    return "Shipment evidence tests the delivery story against the carrier's own records — the difference between a promised and an actual fulfilment.";
  }
  if (/port_congestion|storm_risk|route_eta|ship_rate|carrier_scope/.test(capability)) {
    return "Route conditions and pricing bound whether the quoted delivery and cost terms are realistic for the contract window.";
  }
  if (/hashprice_network|energy_price|grid_price|current_temperature|weather_history/.test(capability)) {
    return "Power and market economics are the input costs the asset's margin is computed from; each is pinned to its node and interval.";
  }
  return "A verified fact for this investigation, re-derived against the node signal; read it with the cited source.";
}

/**
 * A specific, fact-carrying title for a verified record — what the answer
 * actually said, not the capability label. Deterministic from the facts, and
 * gated on the discriminant field actually being present: a branch whose
 * facts never arrived falls back to the plain label rather than implying a
 * verdict the answer did not carry.
 */
function factTitle(e: DeskEvidence): string {
  const f = e.facts;
  const has = (...keys: string[]): boolean => keys.some((k) => f[k] !== undefined && f[k] !== null && f[k] !== "");
  const v = (k: string): string => (f[k] === null || f[k] === undefined ? "" : String(f[k]));
  if (/registry|entity_registry|party_registry/.test(e.capability) && typeof f.legal_name === "string") {
    const status = f.active === true ? "active" : f.active === false ? "not active" : "status unreported";
    const lei = v("lei") ? `, LEI ${v("lei")}` : "";
    return `Registry record: ${v("legal_name")} (${v("jurisdiction") || "jurisdiction unreported"}) — ${status}${lei}`;
  }
  if (/vendor_identity/.test(e.capability) && has("valid", "vendor", "registered_name")) {
    return `VAT ${f.valid === true ? "valid" : f.valid === false ? "not valid" : "check returned"} for ${v("vendor") || "vendor"} (${v("vat_number")}) — registered as "${v("registered_name") || "name unreported"}"`;
  }
  if (/name_screening|sanctions_check|operator_sanctions|vessel_screening/.test(e.capability) && typeof f.matched === "boolean") {
    return `Sanctions screen: ${f.matched ? "match reported" : "no match"} for ${v("name") || v("subject") || "the screened name"}${v("match_score") ? ` (score ${v("match_score")})` : ""}`;
  }
  if (/filings|regulatory_filings/.test(e.capability) && has("filing_count")) {
    return `${v("filing_count")} filing(s) disclosed by the named entity in the period`;
  }
  if (/adverse_media/.test(e.capability) && has("result_count")) {
    return `Adverse-coverage search: ${v("result_count")} item(s) for the subject`;
  }
  if (/fact_check/.test(e.capability) && has("verdict")) {
    return `Claim check on the declared claim: verdict "${v("verdict")}"`;
  }
  if (/wallet_balance/.test(e.capability) && has("balance", "address")) {
    return `Wallet ${v("address") || ""} on ${v("chain") || "chain"}: balance ${v("balance") || "?"}${v("token_symbol") ? ` ${v("token_symbol")}` : ""}`;
  }
  if (/onchain_metric/.test(e.capability) && has("block", "tx_count", "balance_gwei")) {
    return `Account at block ${v("block") || "?"} on ${v("chain") || "chain"}: ${v("tx_count") || "?"} transaction(s), ${v("balance_gwei") || "?"} gwei`;
  }
  if (/tx_lookup/.test(e.capability) && has("tx_hash", "status", "block_number")) {
    return `Transaction ${(v("tx_hash") || "").slice(0, 14) || "0x"}…: ${v("status") || "status unreported"}, value ${v("value_eth") || "?"} ETH, block ${v("block_number") || "?"}`;
  }
  if (/tx_risk/.test(e.capability) && has("risk_level", "risk_score")) {
    return `Transaction risk: ${v("risk_level") || "unreported"} (score ${v("risk_score") || "?"})`;
  }
  if (/holder_concentration|holders/.test(e.capability) && has("holders_count")) {
    return `Holder base: ${v("holders_count")} holder(s)${v("token_symbol") ? ` of ${v("token_symbol")}` : ""}${v("chain") ? ` on ${v("chain")}` : ""}`;
  }
  if (/:supply|total_supply/.test(e.capability) && has("total_supply")) {
    return `Verified total supply: ${v("total_supply")}`;
  }
  if (/price/.test(e.capability) && has("price_usd")) {
    return `Verified USD price: $${v("price_usd")}`;
  }
  if (/liquidity/.test(e.capability) && has("liquidity_usd")) {
    return `Pool depth: $${v("liquidity_usd")}`;
  }
  if (/wash_trading/.test(e.capability) && has("verdict", "subject")) {
    return `Wash-trading check on ${v("subject") || "the market"}: verdict "${v("verdict") || "?"}"${v("wash_volume_pct") ? `, ${v("wash_volume_pct")}% flagged volume` : ""}`;
  }
  if (/po_verify/.test(e.capability) && has("verified", "po_number", "amount")) {
    return `Purchase order ${v("po_number") || ""}: ${f.verified === true ? "verified" : f.verified === false ? "not verified" : "verdict unreported"}${v("amount") ? `, amount ${v("amount")}` : ""}${v("status") ? `, status ${v("status")}` : ""}`;
  }
  if (/invoice_reconcile/.test(e.capability) && typeof f.reconciled === "boolean") {
    return `Invoice reconciliation: ${f.reconciled ? "reconciled" : "does not reconcile"}${v("discrepancy") ? ` (${v("discrepancy")})` : ""}`;
  }
  if (/commerce_verify/.test(e.capability) && has("verified", "order_id", "amount")) {
    return `Commerce order ${v("order_id") || ""}: ${f.verified === true ? "verified" : f.verified === false ? "not verified" : "verdict unreported"}${v("amount") ? `, ${v("amount")} ${v("currency") ?? ""}` : ""}`;
  }
  if (/delivery_window/.test(e.capability) && has("transit_days_min", "transit_days_max")) {
    return `Delivery window ${v("carrier") || ""} on ${v("route") || "route"}: ${v("transit_days_min") || "?"}–${v("transit_days_max") || "?"} day(s)${f.is_estimate === true ? " (estimate)" : ""}`;
  }
  if (/package_status/.test(e.capability) && has("status", "delivered", "tracking_number")) {
    return `Package ${v("tracking_number") || ""}: ${v("status") || "status unreported"}${f.delivered === true ? " — delivered" : f.delivered === false ? " — not delivered" : ""}${v("last_location") ? `, last at ${v("last_location")}` : ""}`;
  }
  if (/vessel_telemetry/.test(e.capability) && has("vessel", "latitude")) {
    return `Vessel ${v("vessel") || ""}: ${v("speed_knots") || "?"} kn at ${v("latitude") || "?"}, ${v("longitude") || "?"} (observed ${v("observed_at") || "?"})`;
  }
  if (/port_congestion/.test(e.capability) && has("port", "congestion_level", "vessels_waiting")) {
    return `Port ${v("port") || ""}: ${v("congestion_level") || "level unreported"}, ${v("vessels_waiting") || "?"} vessel(s) waiting ~${v("wait_hours") || "?"} h`;
  }
  if (/ship_rate/.test(e.capability) && has("rate")) {
    return `Shipment ${v("origin") ? `${v("origin")}→${v("destination")}` : ""}: ${v("rate")} ${v("currency") || ""}, transit ${v("transit_days") || "?"} d, ETA ${v("eta") || "?"}`;
  }
  if (/carrier_scope/.test(e.capability) && has("carrier", "serviceable")) {
    return `Carrier ${v("carrier") || ""} in ${v("area") || ""}: ${f.serviceable === true ? "serviceable" : f.serviceable === false ? "not serviceable" : "coverage unreported"}`;
  }
  if (/route_eta/.test(e.capability) && has("duration")) {
    return `Route ETA ${v("origin") ? `${v("origin")}→${v("destination")}` : ""}: ${v("duration")}`;
  }
  if (/storm_risk/.test(e.capability) && has("risk_level", "risk_score")) {
    return `Storm risk at ${v("location") || ""}: ${v("risk_level") || "unreported"} (score ${v("risk_score") || "?"}), gusts ${v("peak_gust_kmh") || "?"} km/h`;
  }
  if (/hashprice_network/.test(e.capability) && has("hashprice_usd_per_ph_day", "block_height")) {
    return `Hashprice $${v("hashprice_usd_per_ph_day") || "?"}/PH/day at block ${v("block_height") || "?"}; network ${v("hashrate_eh_s") || "?"} EH/s`;
  }
  if (/energy_price|grid_price/.test(e.capability) && has("lmp_usd_per_mwh")) {
    return `Grid price at ${v("node_or_zone") || ""}: $${v("lmp_usd_per_mwh")}/MWh for ${v("interval_start") || "the interval"}`;
  }
  if (/current_temperature/.test(e.capability) && has("temperature_c")) {
    return `Temperature at the site: ${v("temperature_c")} °C`;
  }
  if (/weather_history/.test(e.capability) && has("date", "temp_max_c")) {
    return `Weather on ${v("date") || "the date"} at ${v("location") || ""}: ${v("temp_max_c") || "?"}/${v("temp_min_c") || "?"} °C, ${v("precipitation_mm") || "?"} mm, ${v("condition") || "?"}`;
  }
  return `Verified: ${e.label}`;
}

function buildFindings(inv: DeskInvestigation): DeskFinding[] {
  const findings: DeskFinding[] = [];
  let i = 0;
  for (const e of inv.evidence) {
    if (e.provenance !== "verified") continue;
    const notable = NOTABLE.map((n) => ({ rule: n, severity: n.match(e.capability, e.facts) })).find((r) => r.severity);
    if (notable) {
      findings.push({
        id: `finding:${i++}`,
        severity: notable.severity as DeskSeverity,
        title: notable.rule.title(e.facts),
        detail: e.detail,
        significance: notable.rule.significance,
        evidenceIds: [e.id],
        provenance: "verified",
      });
      continue;
    }
    if (Object.keys(e.facts).length > 0) {
      findings.push({
        id: `finding:${i++}`,
        severity: "info",
        title: factTitle(e),
        detail: e.detail,
        significance: significanceFor(e.capability),
        evidenceIds: [e.id],
        provenance: "verified",
      });
    }
  }
  const order: Record<DeskSeverity, number> = { critical: 0, material: 1, minor: 2, info: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** First number in a free-text amount like "INV-2026-1042 12,000.00 USD". */
function parseAmount(text: unknown): number | null {
  const m = String(text ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Trailing standalone country code in an address string ("Austin, TX, US"). */
function trailingCountryCode(text: unknown): string | null {
  const m = String(text ?? "").trim().match(/(?:^|[\s,;])([A-Za-z]{2})$/);
  return m ? m[1].toUpperCase() : null;
}

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale;
}

function buildDiscrepancies(inv: DeskInvestigation): DeskDiscrepancy[] {
  const out: DeskDiscrepancy[] = [];
  let i = 0;
  const subjectName = normalizeName(inv.subject.legalName ?? inv.subject.supplierName ?? inv.subject.assetName ?? "");
  const subjectJurisdiction = (inv.subject.jurisdiction ?? "").trim().toUpperCase();

  for (const e of inv.evidence) {
    if (e.provenance !== "verified") continue;
    const returnedJurisdiction = typeof e.facts.jurisdiction === "string" ? e.facts.jurisdiction.trim().toUpperCase() : "";
    if (subjectJurisdiction && returnedJurisdiction && returnedJurisdiction !== subjectJurisdiction) {
      out.push({
        id: `disc:${i++}`,
        kind: "jurisdiction_refinement",
        title: "Jurisdiction differs from the request",
        detail: `Requested ${subjectJurisdiction}; the registry answer carries ${returnedJurisdiction}. This is commonly a refinement (e.g. US → US-NV) — read it with the evidence, not as an error.`,
        evidenceIds: [e.id],
      });
    }
    const returnedName = typeof e.facts.legal_name === "string" ? normalizeName(e.facts.legal_name) : "";
    if (subjectName && returnedName && returnedName !== subjectName) {
      out.push({
        id: `disc:${i++}`,
        kind: "name_variance",
        title: "Registered name differs from the requested name",
        detail: `Requested "${inv.subject.legalName ?? inv.subject.supplierName ?? ""}"; the registry answers with "${String(e.facts.legal_name)}". Verify you asked about the intended entity.`,
        evidenceIds: [e.id],
      });
    }
    // VAT identity: the registered tax name must match the entity on the file.
    if (/vendor_identity/.test(e.capability) && typeof e.facts.registered_name === "string") {
      const vatName = normalizeName(e.facts.registered_name);
      if (subjectName && vatName && vatName !== subjectName) {
        out.push({
          id: `disc:${i++}`,
          kind: "field_conflict",
          title: "VAT registration names a different entity",
          detail: `The file is about "${inv.subject.legalName ?? inv.subject.supplierName ?? ""}"; the VAT check returns registered name "${String(e.facts.registered_name)}". The invoice chain must name the registered entity — resolve before releasing payment.`,
          evidenceIds: [e.id],
        });
      }
    }
    // Firmographics: the enrichment's trailing country code against the file's.
    if (/b2b_enrichment/.test(e.capability) && subjectJurisdiction.length === 2) {
      const hq = trailingCountryCode(e.facts.headquarters);
      if (hq && hq !== subjectJurisdiction) {
        out.push({
          id: `disc:${i++}`,
          kind: "field_conflict",
          title: "Enrichment headquarters sits outside the file's jurisdiction",
          detail: `The file asks about jurisdiction ${subjectJurisdiction}; the enrichment record ends in "${String(e.facts.headquarters)}" (country code ${hq}). Same-name entities across borders are the classic screening miss — confirm which entity you are dealing with.`,
          evidenceIds: [e.id],
        });
      }
    }
    if (e.missingFields?.length) {
      out.push({
        id: `disc:${i++}`,
        kind: "missing_fields",
        title: `${e.label}: promised fields missing from the committed answer`,
        detail: `The dimension expects ${e.missingFields.length} field(s) the answer did not carry: ${e.missingFields.join(", ")}. They are reported missing, never filled.`,
        evidenceIds: [e.id],
      });
    }
    if (e.viaRouterFallback) {
      out.push({
        id: `disc:${i++}`,
        kind: "provider_drift",
        title: `${e.label}: served by the router's fallback`,
        detail: `The pinned provider did not serve this answer; the node's router selected an alternate provider. Attribution is recorded on the evidence.`,
        evidenceIds: [e.id],
      });
    }
  }

  // Cross-source conflicts: registry legal name vs enrichment company name.
  const registry = inv.evidence.find((e) => e.provenance === "verified" && typeof e.facts.legal_name === "string");
  const enrichment = inv.evidence.find(
    (e) => e.provenance === "verified" && /b2b_enrichment|firmographic/.test(e.capability) && typeof e.facts.company === "string",
  );
  if (registry && enrichment && normalizeName(registry.facts.legal_name) !== normalizeName(enrichment.facts.company)) {
    out.push({
      id: `disc:${i++}`,
      kind: "field_conflict",
      title: "Registry name and enrichment name disagree",
      detail: `Registry: "${String(registry.facts.legal_name)}". Enrichment: "${String(enrichment.facts.company)}". Both are verified against their own signals; the conflict is unresolved and named.`,
      evidenceIds: [registry.id, enrichment.id],
    });
  }

  // Stated supply vs the network-verified total supply (asset workflow).
  if (inv.type === "asset_intelligence" || inv.type === "listing_underwriter") {
    const declaredSupply = inv.evidence.find((e) => e.id === "declared:declaredSupply");
    const verifiedSupply = inv.evidence.find((e) => e.provenance === "verified" && /:supply/.test(e.capability) && e.facts.total_supply !== undefined);
    if (declaredSupply && verifiedSupply) {
      const stated = parseAmount(declaredSupply.facts.value);
      const verified = Number(verifiedSupply.facts.total_supply);
      if (stated !== null && Number.isFinite(verified) && relDiff(stated, verified) > 0.005) {
        out.push({
          id: `disc:${i++}`,
          kind: "field_conflict",
          title: "Stated supply differs from the verified total supply",
          detail: `The issuer's materials state ${stated.toLocaleString("en-US")}; the network-verified answer carries ${verified.toLocaleString("en-US")}. The gap is unresolved — treat the token's stated economics with suspicion until it is explained.`,
          evidenceIds: [declaredSupply.id, verifiedSupply.id],
        });
      }
    }
  }

  // Trade: the purchase order's amount against the declared ledger line, and
  // a failed reconciliation recorded as the conflict it is.
  if (inv.type === "trade_supplier_intelligence") {
    const po = inv.evidence.find((e) => e.provenance === "verified" && /po_verify/.test(e.capability) && e.facts.amount !== undefined);
    const declaredLedger = inv.evidence.find((e) => e.id === "declared:ledgerRef");
    if (po && declaredLedger) {
      const poAmount = parseAmount(po.facts.amount);
      const ledgerAmount = parseAmount(declaredLedger.facts.value);
      if (poAmount !== null && ledgerAmount !== null && relDiff(poAmount, ledgerAmount) > 0.005) {
        out.push({
          id: `disc:${i++}`,
          kind: "field_conflict",
          title: "Purchase-order amount differs from the declared ledger amount",
          detail: `The verified purchase order carries ${String(po.facts.amount)}; the ledger line you supplied reads "${inv.subject.ledgerRef}". Amount drift between PO and ledger is the classic over-billing pattern — reconcile before any payment release.`,
          evidenceIds: [po.id, declaredLedger.id],
        });
      }
    }
    const failedReconcile = inv.evidence.find((e) => e.provenance === "verified" && /invoice_reconcile/.test(e.capability) && e.facts.reconciled === false);
    if (failedReconcile) {
      out.push({
        id: `disc:${i++}`,
        kind: "field_conflict",
        title: "Invoice does not reconcile with the declared ledger record",
        detail: `The reconciliation provider reports a discrepancy${typeof failedReconcile.facts.discrepancy === "string" ? `: "${failedReconcile.facts.discrepancy}"` : ""}${typeof failedReconcile.facts.explanation === "string" ? ` — ${failedReconcile.facts.explanation}` : ""}. The declared ledger line: "${inv.subject.ledgerRef ?? ""}".`,
        evidenceIds: [failedReconcile.id, ...(inv.evidence.some((e) => e.id === "declared:ledgerRef") ? ["declared:ledgerRef"] : [])],
      });
    }
  }

  return out;
}

function sectionProvenance(evidence: DeskEvidence[]): ProvenanceClass {
  if (evidence.some((e) => e.provenance === "verified")) return "verified";
  if (evidence.some((e) => e.provenance === "unverified")) return "unverified";
  return "missing";
}

function buildSections(inv: DeskInvestigation): DeskReportSection[] {
  const workflow = DESK_WORKFLOWS[inv.type];
  const sections: DeskReportSection[] = [];
  for (const section of workflow.sections) {
    const relevant = inv.evidence.filter((e) => section.capabilities.includes(e.capability));
    const verified = relevant.filter((e) => e.provenance === "verified").length;
    const unverified = relevant.filter((e) => e.provenance === "unverified").length;
    const missing = relevant.filter((e) => e.provenance === "missing").length;
    const summary =
      relevant.length === 0
        ? "No capability from this section was planned or asked."
        : `${relevant.length} record(s): ${verified} verified, ${unverified} unverified, ${missing} missing.`;
    sections.push({
      id: section.id,
      title: section.title,
      summary,
      capabilityKeys: section.capabilities,
      evidenceIds: relevant.map((e) => e.id),
      provenance: sectionProvenance(relevant),
    });
  }
  return sections;
}

function confidenceOf(inv: DeskInvestigation, verified: number, askedVerifiedOrUnverified: number): DeskConfidence {
  if (verified > 0 && verified === askedVerifiedOrUnverified) return "signal_verified";
  if (verified > 0) return "partially_verified";
  const routable = inv.evidence.filter((e) => e.provenance === "unverified" && e.class === "probe_verified").length;
  if (routable > 0) return "route_verified_only";
  return "unverified";
}

/* ------------------------------------------------------------------ */
/* Executive assessment                                                */
/* ------------------------------------------------------------------ */

const VERDICT_SENTENCE: Record<DeskVerdict, string> = {
  hold_pending_review:
    "Verdict: hold. At least one verified signal is a hard stop in ordinary onboarding and payment flows — route it to a human reviewer before money moves or commitments are made.",
  proceed_with_conditions:
    "Verdict: proceed with conditions. Nothing verified here is a hard stop, but the material findings and unresolved conflicts below must be resolved before the relationship or payment proceeds.",
  proceed_on_record:
    "Verdict: no adverse signal in the recorded checks. This is the absence of red flags in what the file asked — not a clean bill of health beyond those questions.",
  insufficient_verified_evidence:
    "Verdict: insufficient verified evidence. Nothing in this file is established as fact yet, so no assessment of the subject is possible — buy the routable answers or supply the missing inputs first.",
};

/** Titles of the negative checks that actually ran and came back clean. */
function cleanCheckLines(inv: DeskInvestigation): string[] {
  const lines: string[] = [];
  const screens = inv.evidence.filter((e) => e.provenance === "verified" && /name_screening|sanctions|vessel_screening/.test(e.capability) && e.facts.matched === false);
  if (screens.length > 0) {
    lines.push(`Sanctions screens returned no match (${screens.length} screen(s) verified${screens.length > 1 ? ", including the named controller" : ""}).`);
  }
  const registries = inv.evidence.filter((e) => e.provenance === "verified" && /registry/.test(e.capability) && e.facts.active === true);
  if (registries.length > 0) {
    lines.push(`The registry record(s) show the entity active (${registries.length} record(s) verified).`);
  }
  const reconciles = inv.evidence.filter((e) => e.provenance === "verified" && /invoice_reconcile/.test(e.capability) && e.facts.reconciled === true);
  if (reconciles.length > 0) lines.push("The invoice reconciled against the declared ledger line.");
  const pos = inv.evidence.filter((e) => e.provenance === "verified" && /po_verify/.test(e.capability) && e.facts.verified === true);
  if (pos.length > 0) lines.push("The purchase order verified against its source system.");
  return lines;
}

function buildAssessment(
  inv: DeskInvestigation,
  parts: {
    findings: DeskFinding[];
    discrepancies: DeskDiscrepancy[];
    counts: DeskReport["counts"];
    mode: "free" | "intel";
    routableOffers?: number;
  },
): DeskAssessment {
  const criticals = parts.findings.filter((f) => f.severity === "critical");
  const materials = parts.findings.filter((f) => f.severity === "material");
  const conflicts = parts.discrepancies.filter((d) => d.kind === "field_conflict");
  const verified = inv.evidence.filter((e) => e.provenance === "verified");
  const verifiedCapabilities = new Set(verified.map((e) => e.capability)).size;
  const inputGapCount = inv.evidence.filter((e) => e.id.startsWith("input-gap:")).length;
  const declaredCount = inv.evidence.filter((e) => e.class === "declared").length;
  const paid = parts.mode === "intel";

  const verdict: DeskVerdict =
    criticals.length > 0
      ? "hold_pending_review"
      : materials.length > 0 || conflicts.length > 0
        ? "proceed_with_conditions"
        : verified.length === 0
          ? "insufficient_verified_evidence"
          : "proceed_on_record";

  // Summary: what was established → what is adverse → what the file cannot
  // speak to → the verdict. Every sentence derives from the ledger, and the
  // established-evidence sentence keys off the ledger, not the requesting
  // mode: a free rebuild of a file that already holds paid verified records
  // must never claim nothing is established.
  const summaryParts: string[] = [];
  if (verified.length > 0) {
    summaryParts.push(
      `${verified.length} verified record(s) across ${verifiedCapabilities} checked capabilit${verifiedCapabilities === 1 ? "y" : "ies"} rest on paid, hash-committed answers.`,
    );
  } else if (paid) {
    summaryParts.push("The paid run returned nothing that could be verified, so this file establishes no facts.");
  } else {
    summaryParts.push(`This is a route-only pre-flight: ${parts.counts.unverified} route(s) were priced and schema-checked, no answer was purchased, and nothing here is established fact.`);
  }
  if (criticals.length > 0) {
    summaryParts.push(`Decisive adverse signal(s): ${criticals.map((f) => f.title.toLowerCase()).join("; ")}.`);
  } else if (materials.length > 0) {
    summaryParts.push(`Material findings needing resolution: ${materials.map((f) => f.title.toLowerCase()).join("; ")}.`);
  } else if (paid && verified.length > 0) {
    const clean = cleanCheckLines(inv);
    summaryParts.push(clean.length > 0 ? clean.join(" ") : "No adverse signal appeared in the checks this file ran.");
  }
  const cannotSpeakTo: string[] = [];
  if (inv.unsupported.length > 0) cannotSpeakTo.push(`${inv.unsupported.length} requirement(s) unsupported on the network (${inv.unsupported.map((g) => g.label).join(", ")})`);
  if (inputGapCount > 0) cannotSpeakTo.push(`${inputGapCount} capability(ies) not asked for lack of inputs`);
  if (declaredCount > 0) cannotSpeakTo.push(`${declaredCount} declared input(s) never verified`);
  if (parts.counts.unverified > 0) cannotSpeakTo.push(`${parts.counts.unverified} unverified record(s)`);
  if (cannotSpeakTo.length > 0) {
    summaryParts.push(`The file cannot speak to: ${cannotSpeakTo.join("; ")}.`);
  }
  summaryParts.push(VERDICT_SENTENCE[verdict]);

  // Basis: the decisive inputs, one line each, traced. Clean checks stay
  // visible even next to adverse ones — they bound what the adverse finding
  // means (e.g. the company screened clean while its controller did not).
  const basis: string[] = [];
  for (const f of [...criticals, ...materials].slice(0, 5)) {
    basis.push(`${f.title} — evidence ${f.evidenceIds.join(", ")}`);
  }
  basis.push(...cleanCheckLines(inv));
  if (conflicts.length > 0) basis.push(`${conflicts.length} unresolved conflict(s) between sources — each names the evidence on both sides.`);
  if (inv.unsupported.length > 0) basis.push(`Unsupported on the network, named not approximated: ${inv.unsupported.map((g) => g.label).join(", ")}.`);
  if (inputGapCount > 0) basis.push(`${inputGapCount} capability(ies) were never asked — their required inputs were not supplied.`);
  if (declaredCount > 0) basis.push(`${declaredCount} declared input(s) come from the guided form and are never verified by this workflow.`);

  // Next actions: most decisive first, each traced to its evidence or gap.
  const nextActions: DeskNextAction[] = [];
  for (const f of criticals.slice(0, 3)) {
    if (/sanctions|vessel_screening/i.test(f.title)) {
      nextActions.push({
        title: "Route the sanctions match to human compliance review before any payment or commitment",
        detail: "The screen matched a name in this file at the provider. The match is probabilistic and name-based — the reviewer must confirm or clear it against the underlying list entry; the desk cannot do that for you.",
        basis: f.evidenceIds,
      });
    } else if (/risk/i.test(f.title)) {
      nextActions.push({
        title: "Review the flagged transaction's risk signals before accepting funds from this counterparty",
        detail: "The provider flagged the transaction at a severity that blocks ordinary acceptance. Read the recorded signals with the cited evidence; a score is a judgment, not an attribution.",
        basis: f.evidenceIds,
      });
    } else {
      nextActions.push({
        title: `Resolve before proceeding: ${f.title}`,
        detail: f.significance,
        basis: f.evidenceIds,
      });
    }
  }
  for (const f of materials.slice(0, 3)) {
    if (/not active/i.test(f.title)) {
      nextActions.push({
        title: "Confirm the registry status with the register or the counterparty directly before contracting",
        detail: "A registry record that is not active may be a data lag, a deregistration or a wrong entity match. The desk cannot distinguish these; ask the counterparty for evidence of good standing.",
        basis: f.evidenceIds,
      });
    } else if (/VAT/i.test(f.title)) {
      nextActions.push({
        title: "Ask the counterparty for the correct VAT registration and re-check it",
        detail: "Until a valid registration ties the trading name to a tax identity, the invoice chain is unanchored — hold payment-relevant decisions on this file.",
        basis: f.evidenceIds,
      });
    } else if (/reconcile/i.test(f.title)) {
      nextActions.push({
        title: "Stop payment release; obtain a corrected invoice or ledger entry and re-run the reconciliation",
        detail: "The recorded reconciliation failure is a payment stopper, not a footnote. The recorded explanation sits with the evidence.",
        basis: f.evidenceIds,
      });
    } else if (/Purchase order/i.test(f.title)) {
      nextActions.push({
        title: "Confirm the purchase-order reference and vendor with the source system, then re-ask",
        detail: "The source system did not confirm the PO as asked — the payment chain has no contractual baseline until it verifies.",
        basis: f.evidenceIds,
      });
    } else {
      nextActions.push({
        title: `Resolve before proceeding: ${f.title}`,
        detail: f.significance,
        basis: f.evidenceIds,
      });
    }
  }
  if (conflicts.length > 0) {
    nextActions.push({
      title: `Resolve the ${conflicts.length} recorded conflict(s) between sources`,
      detail: "Each conflict names the evidence on both sides; none is resolved by assumption. Pick the authoritative source per field or obtain the missing document.",
      basis: conflicts.flatMap((d) => d.evidenceIds).slice(0, 8),
    });
  }
  const inputGaps = planDeskCapabilities(inv).inputGaps;
  for (const gap of inputGaps.slice(0, 6)) {
    nextActions.push({
      title: `Supply the missing inputs to ask "${gap.label}"`,
      detail: `This capability was planned but not asked — it needs ${gap.required.join("; ")}. Add them to the file and re-run.`,
      basis: [gap.key],
    });
  }
  for (const g of inv.unsupported.slice(0, 2)) {
    nextActions.push({
      title: `Cover "${g.label}" outside the network`,
      detail: g.resolution,
      basis: [g.capabilityKey],
    });
  }
  if (!paid && (parts.routableOffers ?? 0) > 0) {
    nextActions.push({
      title: `Approve a paid run to purchase the ${parts.routableOffers} routable answer(s) at the probed prices`,
      detail: "The free pre-flight verified routes and prices only; the answers themselves are what turn this file into evidence.",
      basis: ["free pre-flight"],
    });
  }
  if (inv.runs.length === 0) {
    nextActions.push({
      title: "Run the free pre-flight",
      detail: "No run has been executed yet — the free pre-flight plans the capabilities, checks every route and records the live prices without spending.",
      basis: ["no runs recorded"],
    });
  }

  return { verdict, summary: summaryParts.join(" "), basis: basis.slice(0, 10), nextActions: nextActions.slice(0, 15) };
}

/**
 * Build the report from the evidence ledger only. Deterministic: the same
 * ledger always produces the same report.
 */
export function buildDeskReport(inv: DeskInvestigation, opts: { mode: "free" | "intel"; spendUsdCents?: number; routableOffers?: number }): DeskReport {
  const findings = buildFindings(inv);
  const discrepancies = buildDiscrepancies(inv);
  const sections = buildSections(inv);
  const counts = {
    verified: inv.evidence.filter((e) => e.provenance === "verified").length,
    unverified: inv.evidence.filter((e) => e.provenance === "unverified").length,
    missing: inv.evidence.filter((e) => e.provenance === "missing").length,
    analysis: 0,
  };

  const limitations: string[] = [];
  const paid = opts.mode === "intel";
  limitations.push(
    paid
      ? `${counts.verified} record(s) rest on paid, hash-committed answers; ${counts.unverified} remain unverified.`
      : `Free run: no answer was purchased. The ${counts.unverified} route-verified record(s) carry schema, routing and price only — they are not findings.`,
  );
  if (inv.unsupported.length > 0) {
    limitations.push(
      `${inv.unsupported.length} requirement(s) are unsupported on the network and are named, not approximated: ${inv.unsupported.map((g) => g.label).join(", ")}.`,
    );
  }
  const inputGapCount = inv.evidence.filter((e) => e.id.startsWith("input-gap:")).length;
  if (inputGapCount > 0) {
    limitations.push(`${inputGapCount} capability(ies) were not asked because their required inputs were not supplied.`);
  }
  const declaredCount = inv.evidence.filter((e) => e.class === "declared").length;
  if (declaredCount > 0) {
    limitations.push(`${declaredCount} declared input(s) come from the guided form and were never verified by this workflow.`);
  }
  const drift = inv.evidence.filter((e) => e.viaRouterFallback).length;
  if (drift > 0) {
    limitations.push(`${drift} answer(s) were served by the router's fallback rather than the pinned provider.`);
  }
  limitations.push("This report is generated from recorded evidence only. It is not legal, sanctions, credit or investment advice.");

  const outstandingQuestions: string[] = [];
  for (const gap of inv.unsupported) {
    // Name the gap in the question itself: a reader scanning the outstanding
    // questions must be able to tell which one concerns beneficial ownership,
    // which one court records, without cross-referencing the limitations.
    outstandingQuestions.push(`"${gap.label}" is unsupported on the network — ${gap.resolution}`);
  }
  for (const gap of planDeskCapabilities(inv).inputGaps) {
    outstandingQuestions.push(`"${gap.label}" needs ${gap.required.join("; ")} — supply the inputs and re-run to ask it.`);
  }
  const missingFieldQuestions = new Set<string>();
  for (const e of inv.evidence) {
    for (const f of e.missingFields ?? []) missingFieldQuestions.add(`Confirm "${f.replace(/_/g, " ")}" with an independent source — the committed answer omitted it.`);
  }
  outstandingQuestions.push(...missingFieldQuestions);
  if (!paid && (opts.routableOffers ?? 0) > 0) {
    outstandingQuestions.push(`Approve a paid run to purchase the ${(opts.routableOffers ?? 0).toString()} routable answer(s) (planned cost $${(((opts.routableOffers ?? 0) * 1) / 100).toFixed(2)} at the probed price).`);
  }
  if (inv.runs.length === 0) {
    outstandingQuestions.push("No run has been executed yet — start with the free pre-flight.");
  }

  const verifiedAsked = paid ? counts.verified + inv.evidence.filter((e) => e.class === "paid_unverified").length : 0;
  const confidence = confidenceOf(inv, counts.verified, verifiedAsked);
  const spend = opts.spendUsdCents ?? 0;
  const headline =
    counts.verified > 0
      ? `${counts.verified} verified record(s), ${counts.missing} named missing, $${(spend / 100).toFixed(2)} spent — confidence ${confidence.replace("_", " ")}.`
      : paid
        ? `No verified answer in this run. ${counts.unverified} unverified, ${counts.missing} missing — nothing is presented as data.`
        : `Route-verified only: ${counts.unverified} route(s) priced and schema-checked; no answer purchased and none presented as data.`;

  const assessment = buildAssessment(inv, { findings, discrepancies, counts, mode: opts.mode, routableOffers: opts.routableOffers });

  const report: DeskReport = {
    preparedAt: new Date().toISOString(),
    type: inv.type,
    mode: opts.mode,
    headline,
    assessment,
    findings,
    discrepancies,
    sections,
    limitations,
    outstandingQuestions,
    counts,
    confidence,
  };

  // The desk's own synthesis is one labelled analysis record that cites the
  // ledger it used — never rendered beside verified facts as if it were one.
  report.counts.analysis = 1;
  return report;
}

/** Sync + report in one call, then persist. */
export async function reportDeskInvestigation(inv: DeskInvestigation, mode: "free" | "intel"): Promise<{ added: number; notes: string[]; report: DeskReport }> {
  const sync = await syncDeskInvestigation(inv);
  let spendUsdCents = 0;
  let routableOffers = 0;
  for (const run of inv.runs) {
    const task = await getTask(run.taskId);
    if (!task) continue;
    spendUsdCents += task.spend.spentUsdCents;
    const baselineCoverage = task.result?.capabilityReport;
    if (baselineCoverage) routableOffers += baselineCoverage.counts.routable_unverified;
  }
  const report = buildDeskReport(inv, { mode, spendUsdCents, routableOffers });

  inv.evidence.push({
    id: `analysis:${report.preparedAt}`,
    provenance: "analysis",
    class: "analysis",
    capability: "desk_synthesis",
    label: "Desk synthesis",
    title: `Deal Desk synthesis · ${inv.reference}`,
    detail: `${report.headline} ${report.assessment.summary}`,
    facts: {
      verdict: report.assessment.verdict,
      findings: report.findings.length,
      discrepancies: report.discrepancies.length,
      verified: report.counts.verified,
      unverified: report.counts.unverified,
      missing: report.counts.missing,
      confidence: report.confidence,
    },
    source: { kind: "none", ref: inv.reference, label: "desk report builder", observedAt: report.preparedAt },
  });

  inv.findings = report.findings;
  inv.report = report;
  inv.status = "reported";
  auditDesk(inv, "desk", "desk_report_built", report.headline);
  await saveDeskInvestigation(inv);
  return { added: sync.added, notes: sync.notes, report };
}
