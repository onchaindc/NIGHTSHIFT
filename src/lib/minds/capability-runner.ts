/**
 * Reusable capability adapter for every Mind.
 *
 * Discovery and payment are NOT re-implemented here:
 *  - free coverage runs use `probeAsk` (unpaid, returns the live 402 offer),
 *  - approved asks use `executeAsk` (requires the exact approved offer and
 *    drift-checks it against a fresh challenge before signing),
 *  - evidence uses `verifySignal` (keccak re-derivation over the committed
 *    payload).
 *
 * This module only supplies the Mind-specific part: turning a capability
 * dimension into a canonical Telegraph spec, extracting the committed fields
 * that dimension promised, and reporting what is verified, recorded or
 * missing. A gap never becomes an ask.
 */

import {
  executeAsk,
  probeAsk,
  verifySignal,
  type ApprovedOffer,
  type AskRequestSpec,
  type ExecuteInput,
  type ExecuteOutcome,
  type ProbeOutcome,
  type VerifyOutcome,
} from "@/lib/terminal/ask";
import {
  CAPABILITIES,
  DEFAULT_ASK_PRICE_USD_CENTS,
  type CapabilityDimension,
} from "./capabilities";
import { notifyMindReport } from "@/lib/mind/builder";

export interface CapabilityRunnerDeps {
  probe: (spec: AskRequestSpec, opts?: { preferEscrow?: boolean }) => Promise<ProbeOutcome>;
  execute: (input: ExecuteInput) => Promise<ExecuteOutcome>;
  verify: (signalHash: string) => Promise<VerifyOutcome>;
  /** Optional report delivery to a Minds account; config-gated and best-effort. */
  notify?: typeof notifyMindReport;
  now: () => number;
}

export function defaultCapabilityDeps(): CapabilityRunnerDeps {
  return {
    probe: probeAsk,
    execute: executeAsk,
    verify: verifySignal,
    notify: (input, fetchImpl) => notifyMindReport(input, fetchImpl),
    now: () => Date.now(),
  };
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export class CapabilityBudgetError extends CapabilityError {
  constructor(
    readonly priceUsdCents: number,
    readonly remainingUsdCents: number,
  ) {
    super(
      `This ask costs $${(priceUsdCents / 100).toFixed(2)} but only $${(remainingUsdCents / 100).toFixed(2)} remains in the approved budget. Nothing was signed.`,
    );
    this.name = "CapabilityBudgetError";
  }
}

/* ------------------------------------------------------------------ */
/* Spec construction                                                   */
/* ------------------------------------------------------------------ */

export function sampleParams(dim: CapabilityDimension): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(dim.params ?? {})) {
    if (spec.sample !== undefined) params[name] = spec.sample;
  }
  return params;
}

/** Throws for a gap or a missing intent instead of inventing a route. */
export function buildCapabilitySpec(dim: CapabilityDimension, params: Record<string, unknown>): AskRequestSpec {
  if (dim.status === "gap" || !dim.intent) {
    throw new CapabilityError(`${dim.label} is unsupported: ${dim.missingReason ?? "no verified intent"}`);
  }
  for (const [name, spec] of Object.entries(dim.params ?? {})) {
    if (!spec.required) continue;
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw new CapabilityError(`${dim.label} requires ${name} (${spec.description})`);
    }
  }
  return {
    intent: dim.intent,
    params,
    ...(dim.provider && dim.provider !== "router" ? { minerId: dim.provider } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Free coverage probes                                                */
/* ------------------------------------------------------------------ */

export type DimensionProbe =
  | {
      dimension: string;
      label: string;
      status: "routable";
      intent: string;
      provider: string;
      priceUsdCents: number;
      network: string;
      detail: string;
    }
  | { dimension: string; label: string; status: "gap"; detail: string }
  | { dimension: string; label: string; status: "rejected"; detail: string; httpStatus: number }
  | { dimension: string; label: string; status: "unavailable"; detail: string };

export interface MindCoverageProbe {
  slug: string;
  probedAt: string;
  dimensions: DimensionProbe[];
  routable: number;
  gaps: number;
  plannedCostUsdCents: number;
  /** Total dimensions considered (including gaps). */
  considered: number;
}

export interface CapabilityOffer {
  dimension: CapabilityDimension;
  spec: AskRequestSpec;
  approvedOffer: ApprovedOffer;
  priceUsdCents: number;
}

/**
 * Probes a Mind's supported dimensions with caller-supplied parameters and
 * returns both the coverage verdict and the live offers the paid step would
 * need. Gaps are recorded without any network call.
 */
export async function probeCapabilitySet(
  slug: string,
  paramsById: Record<string, Record<string, unknown>>,
  opts: { deps?: CapabilityRunnerDeps } = {},
): Promise<{ coverage: MindCoverageProbe; offers: CapabilityOffer[] }> {
  const profile = CAPABILITIES[slug];
  if (!profile) throw new CapabilityError(`unknown Mind: ${slug}`);
  const deps = opts.deps ?? defaultCapabilityDeps();
  const dimensions: DimensionProbe[] = [];
  const offers: CapabilityOffer[] = [];
  let plannedCostUsdCents = 0;

  for (const dim of profile.dimensions) {
    if (dim.status === "gap") {
      dimensions.push({
        dimension: dim.id,
        label: dim.label,
        status: "gap",
        detail: dim.missingReason ?? "unsupported dimension",
      });
      continue;
    }
    let spec: AskRequestSpec;
    try {
      spec = buildCapabilitySpec(dim, paramsById[dim.id] ?? {});
    } catch (err) {
      dimensions.push({
        dimension: dim.id,
        label: dim.label,
        status: "rejected",
        httpStatus: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const outcome = await deps.probe(spec);
    if (outcome.kind === "challenge") {
      const cents = Math.round(outcome.pricedOffer.amountCents);
      plannedCostUsdCents += cents;
      offers.push({ dimension: dim, spec, approvedOffer: outcome.approvedOffer, priceUsdCents: cents });
      dimensions.push({
        dimension: dim.id,
        label: dim.label,
        status: "routable",
        intent: dim.intent as string,
        provider: dim.provider ?? "router",
        priceUsdCents: cents,
        network: outcome.approvedOffer.network,
        detail: `routable at $${(cents / 100).toFixed(2)} on ${outcome.approvedOffer.network} (unpaid probe; nothing signed)`,
      });
    } else if (outcome.kind === "rejected") {
      dimensions.push({
        dimension: dim.id,
        label: dim.label,
        status: "rejected",
        httpStatus: outcome.status,
        detail: outcome.text || `the node refused the ask (HTTP ${outcome.status})`,
      });
    } else {
      dimensions.push({ dimension: dim.id, label: dim.label, status: "unavailable", detail: outcome.detail });
    }
  }

  return {
    coverage: {
      slug,
      probedAt: new Date(deps.now()).toISOString(),
      dimensions,
      routable: dimensions.filter((d) => d.status === "routable").length,
      gaps: dimensions.filter((d) => d.status === "gap").length,
      plannedCostUsdCents,
      considered: dimensions.length,
    },
    offers,
  };
}

/**
 * Probes every supported dimension of one Mind for free. Nothing is signed;
 * a valid canonical body returns the node's live 402 challenge, which is the
 * routing/price evidence. Real investigation parameters can be supplied for
 * dimensions whose sample value is not meaningful.
 */
export async function probeMindCoverage(
  slug: string,
  opts: {
    deps?: CapabilityRunnerDeps;
    params?: Record<string, Record<string, unknown>>;
  } = {},
): Promise<MindCoverageProbe> {
  const profile = CAPABILITIES[slug];
  if (!profile) throw new CapabilityError(`unknown Mind: ${slug}`);
  const paramsById: Record<string, Record<string, unknown>> = {};
  for (const dim of profile.dimensions) {
    if (dim.status !== "gap") paramsById[dim.id] = opts.params?.[dim.id] ?? sampleParams(dim);
  }
  const { coverage } = await probeCapabilitySet(slug, paramsById, { deps: opts.deps });
  return coverage;
}

/* ------------------------------------------------------------------ */
/* Approved paid execution                                             */
/* ------------------------------------------------------------------ */

export interface CommittedDimension {
  dimension: string;
  label: string;
  intent: string;
  provider: string;
  signalHash: string;
  receiptHash: string;
  /** When the node recorded the committed signal, when it exposes one. */
  verifiedAt?: string;
  costUsdCents: number;
  verification: "verified" | "recorded" | "unverified";
  verificationNote: string;
  /** Fields the committed answer carried among the dimension's expected fields. */
  values: Record<string, unknown>;
  missingFields: string[];
  /** Full committed response, retained for the report and never summarized away. */
  committed: Record<string, unknown> | null;
}

export interface ApprovedDimensionInput {
  slug: string;
  dimension: CapabilityDimension;
  params: Record<string, unknown>;
  approvedOffer: ApprovedOffer;
  remainingBudgetUsdCents: number;
  deps?: CapabilityRunnerDeps;
}

export async function executeApprovedDimension(input: ApprovedDimensionInput): Promise<CommittedDimension> {
  const { dimension: dim, params, approvedOffer, remainingBudgetUsdCents } = input;
  if (dim.status === "gap" || !dim.intent) {
    throw new CapabilityError(`${dim.label} is unsupported and will not be asked`);
  }
  const deps = input.deps ?? defaultCapabilityDeps();
  const priceUsdCents = Math.round(Number(approvedOffer.amount) / 10000);
  if (!Number.isFinite(priceUsdCents) || priceUsdCents <= 0) {
    throw new CapabilityError("the approved offer carries no usable price, so it cannot be budgeted");
  }
  if (priceUsdCents > remainingBudgetUsdCents) {
    throw new CapabilityBudgetError(priceUsdCents, remainingBudgetUsdCents);
  }

  const spec = buildCapabilitySpec(dim, params);
  const outcome = await deps.execute({ spec, approved: true, approvedOffer });
  if (outcome.kind !== "answered") {
    const detail =
      outcome.kind === "refused"
        ? outcome.reason
        : outcome.kind === "unpaid_rejected"
          ? `the node rejected the request before payment (HTTP ${outcome.status})`
          : outcome.kind === "payment_rejected"
            ? `the signed payment was rejected: ${outcome.detail}`
            : outcome.kind === "integrity"
              ? `the paid delivery could not be reconciled: ${outcome.detail}`
              : `the paid request failed: ${outcome.detail}`;
    throw new CapabilityError(`No verified answer for ${dim.label}: ${detail}`);
  }

  const verification = await deps.verify(outcome.signalHash);
  const committed = committedResponseOf(verification.kind === "unverified" ? null : verification.record);
  const expected = dim.responseFields ?? [];
  const values: Record<string, unknown> = {};
  if (committed) {
    for (const field of expected) {
      const value = valueAtPath(committed, dim.valuePaths?.[field] ?? field);
      // null is not an answer: keep it out of findings and report the field missing.
      if (value !== undefined && value !== null) values[field] = value;
    }
  }
  const missingFields = expected.filter((f) => {
    const value = committed ? valueAtPath(committed, dim.valuePaths?.[f] ?? f) : undefined;
    return value === undefined || value === null;
  });
  const signalRecord = verification.kind === "unverified" ? null : (verification.record as Record<string, unknown> | null);
  const signalPayload = signalRecord?.payload as Record<string, unknown> | undefined;
  const verifiedAt =
    (typeof signalRecord?.timestamp === "string" && signalRecord.timestamp) ||
    (typeof signalPayload?.timestamp === "string" && signalPayload.timestamp) ||
    undefined;

  return {
    dimension: dim.id,
    label: dim.label,
    intent: dim.intent,
    provider: dim.provider ?? "router",
    signalHash: outcome.signalHash,
    receiptHash: outcome.receipt.receipt_hash,
    verifiedAt,
    costUsdCents: priceUsdCents,
    verification:
      verification.kind === "verified" ? "verified" : verification.kind === "recorded" ? "recorded" : "unverified",
    verificationNote: verification.kind === "unverified" ? verification.detail : verification.note,
    values,
    missingFields,
    committed,
  };
}

/* ------------------------------------------------------------------ */
/* Evidence + reporting                                                */
/* ------------------------------------------------------------------ */

/** Read one field, including a nested path such as `data.amount`. */
export function valueAtPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The hash-committed answer, always read from `payload.response`. */
export function committedResponseOf(record: unknown): Record<string, unknown> | null {
  if (typeof record !== "object" || record === null) return null;
  const payload = (record as Record<string, unknown>).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const response = (payload as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) return null;
  return response as Record<string, unknown>;
}

export type ReportDimensionStatus = "verified" | "recorded" | "unverified" | "routable_unverified" | "gap";

export interface CapabilityReport {
  slug: string;
  preparedAt: string;
  dimensions: Array<{
    dimension: string;
    label: string;
    status: ReportDimensionStatus;
    detail: string;
    intent?: string;
    provider?: string;
    priceUsdCents?: number;
    signalHash?: string;
    receiptHash?: string;
    verifiedAt?: string;
    values?: Record<string, unknown>;
    missingFields?: string[];
  }>;
  missing: Array<{ dimension: string; reason: string }>;
  spendUsdCents: number;
  counts: Record<ReportDimensionStatus, number>;
  note: string;
}

export function buildCapabilityReport(input: {
  coverage: MindCoverageProbe;
  committed?: CommittedDimension[];
  spendUsdCents?: number;
}): CapabilityReport {
  const committedByDimension = new Map((input.committed ?? []).map((c) => [c.dimension, c]));
  const dimensions: CapabilityReport["dimensions"] = input.coverage.dimensions.map((probe) => {
    const done = committedByDimension.get(probe.dimension);
    if (probe.status === "gap") {
      return { dimension: probe.dimension, label: probe.label, status: "gap" as const, detail: probe.detail };
    }
    if (!done) {
      return {
        dimension: probe.dimension,
        label: probe.label,
        status: "routable_unverified" as const,
        detail:
          probe.status === "routable"
            ? `route and price verified by a free probe (${probe.provider} at $${(probe.priceUsdCents / 100).toFixed(2)}); no paid answer was purchased`
            : probe.detail,
        intent: probe.status === "routable" ? probe.intent : undefined,
        provider: probe.status === "routable" ? probe.provider : undefined,
        priceUsdCents: probe.status === "routable" ? probe.priceUsdCents : undefined,
      };
    }
    return {
      dimension: done.dimension,
      label: done.label,
      status: done.verification,
      detail:
        done.verification === "verified"
          ? `verified against the node signal; ${done.verificationNote}`
          : `paid answer is ${done.verification}; ${done.verificationNote}`,
      intent: done.intent,
      provider: done.provider,
      priceUsdCents: done.costUsdCents,
      signalHash: done.signalHash,
      receiptHash: done.receiptHash,
      verifiedAt: done.verifiedAt,
      values: done.values,
      missingFields: done.missingFields,
    };
  });

  const counts = dimensions.reduce(
    (acc, d) => {
      acc[d.status] += 1;
      return acc;
    },
    { verified: 0, recorded: 0, unverified: 0, routable_unverified: 0, gap: 0 } as Record<ReportDimensionStatus, number>,
  );

  return {
    slug: input.coverage.slug,
    preparedAt: input.coverage.probedAt,
    dimensions,
    missing: input.coverage.dimensions
      .filter((d) => d.status === "gap")
      .map((d) => ({ dimension: d.dimension, reason: d.detail })),
    spendUsdCents: input.spendUsdCents ?? 0,
    counts,
    note:
      counts.verified > 0
        ? "Verified dimensions rest on a paid, hash-committed answer that re-derived against its signal. Everything else is explicitly labelled."
        : "No paid answer was purchased. Routable dimensions have verified schema, provider routing and price only; they are not findings.",
  };
}

/** Total live ask price of a Mind's supported dimensions (probe prices). */
export function plannedCeilingUsdCents(slug: string): number {
  const profile = CAPABILITIES[slug];
  if (!profile) return 0;
  return profile.dimensions
    .filter((d) => d.status !== "gap")
    .reduce((sum, d) => sum + (d.priceUsdCents ?? DEFAULT_ASK_PRICE_USD_CENTS), 0);
}
