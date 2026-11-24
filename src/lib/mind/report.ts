import { COUNTERPARTY_FIELDS, type CounterpartyClassification } from "@/lib/counterparty/intel";

/**
 * Mind investigation report — the reasoned deliverable of an autonomous
 * investigation.
 *
 * Honesty invariants (mirroring the engine's and Counterparty's):
 *  - Every fact in the report is traceable to recorded evidence (the unpaid
 *    probe, the hash-committed paid payload, or the keccak-verified signal).
 *  - A field the specialist intelligence did not return is reported MISSING,
 *    never guessed; a disagreement is reported as a disagreement.
 *  - The comparison section states plainly what the investigation knew
 *    WITHOUT Telegraph intelligence (routing knowledge only — no registry
 *    facts) and what the purchased intelligence added, at what verified cost.
 */

export interface MindEntity {
  company: string;
  jurisdiction?: string;
}

/** What the unpaid, human-approval-free phase established (no registry facts). */
export interface MindBaseline {
  entity: MindEntity;
  /** The unpaid probe verdict for the pinned specialist ask. */
  probe: {
    status: "challenge" | "rejected" | "unavailable";
    /** Live price when the node challenged; the offer the human would approve. */
    priceUsd?: number;
    offer?: { scheme: string; network: string; asset: string; payTo: string; amount: string };
    /**
     * The rails the approval covers: the union of the signable exact-scheme
     * EVM rails the pre-flight's probes drew from the provider's alternating
     * pool. Empty for non-challenge outcomes and single-offer callers.
     */
    rails?: Array<{ network: string; asset: string; payTo: string; amount: string; amountCents: number }>;
    intent: string;
    miner: string;
    detail: string;
  };
  /** Canonical registry fields the Mind could NOT answer without intelligence. */
  unknownFields: string[];
}

/** What one paid specialist ask added (verified before it counts). */
export interface MindIntelResult {
  purchased: boolean;
  signalHash?: string;
  /** Keccak re-derivation over the recorded payload — only "verified" counts. */
  verificationStatus: "verified" | "recorded" | "unverified" | "none";
  miner?: string;
  costUsdCents?: number;
  receiptHash?: string;
  committed: boolean;
  facts: Array<{ field: string; value: unknown }>;
  missing: string[];
  disagreements: Array<{ field: string; left: string; right: string; note?: string }>;
  meta: {
    confidence?: number;
    asOf?: string;
    register?: string;
    sources: string[];
  };
}

/** Per-field comparison: what intelligence added over the baseline. */
export interface MindComparison {
  /** Canonical fields the baseline could not answer but intelligence did. */
  gained: Array<{ field: string; value: unknown }>;
  /** Canonical fields still unanswered after the paid ask. */
  remainingGaps: string[];
  /** Conflicts found inside the purchased evidence (never silently resolved). */
  conflicts: Array<{ field: string; left: string; right: string; note?: string }>;
  fieldsKnownBefore: number;
  fieldsKnownAfter: number;
  fieldsTotal: number;
  costUsdCents?: number;
  verified: boolean;
}

export interface MindInvestigationReport {
  objective: string;
  entity: MindEntity | null;
  /** "used" = a paid Telegraph ask ran; "not_used" = free-only investigation. */
  intelUsed: boolean;
  baseline: MindBaseline | null;
  intel?: MindIntelResult;
  comparison?: MindComparison;
  /** Ordered reasoning chain; every step cites the evidence behind it. */
  reasoning: string[];
  /** Overall confidence, derived from verification — never self-reported. */
  confidence: "signal-verified" | "unverified" | "routing-only" | "none";
  generatedAt: number;
}

const FIELD_LABELS: Record<string, string> = {
  legal_name: "Legal name",
  registration_id: "Registration ID",
  lei: "LEI",
  active: "Active",
  jurisdiction: "Jurisdiction",
  registered_address: "Registered address",
  incorporated: "Incorporated",
  legal_form: "Legal form",
  register: "Register",
};

export function mindFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ */
/* Builders (pure; unit-tested)                                        */
/* ------------------------------------------------------------------ */

export function buildBaseline(
  objective: string,
  entity: MindEntity,
  probe: MindBaseline["probe"],
): MindBaseline {
  return {
    entity,
    probe,
    // Honest by construction: the baseline holds routing knowledge only — the
    // unpaid probe never returns registry data, so every canonical field is
    // unknown before any purchase.
    unknownFields: [...COUNTERPARTY_FIELDS],
  };
}

export function buildIntelResult(args: {
  purchased: boolean;
  signalHash?: string;
  verificationStatus: MindIntelResult["verificationStatus"];
  miner?: string;
  costUsdCents?: number;
  receiptHash?: string;
  classification: CounterpartyClassification | null;
}): MindIntelResult {
  const c = args.classification;
  return {
    purchased: args.purchased,
    signalHash: args.signalHash,
    verificationStatus: args.verificationStatus,
    miner: args.miner,
    costUsdCents: args.costUsdCents,
    receiptHash: args.receiptHash,
    committed: !!c,
    facts: c ? c.facts.map((f) => ({ field: f.field, value: f.value })) : [],
    missing: c ? [...c.missing] : [...COUNTERPARTY_FIELDS],
    disagreements: c
      ? c.disagreements.map((d) => ({
          field: d.field,
          left: `${d.left.source}: ${JSON.stringify(d.left.value)}`,
          right: `${d.right.source}: ${JSON.stringify(d.right.value)}`,
          ...(d.note ? { note: d.note } : {}),
        }))
      : [],
    meta: {
      ...(c?.meta.confidence !== undefined ? { confidence: c.meta.confidence } : {}),
      ...(c?.meta.asOf ? { asOf: c.meta.asOf } : {}),
      ...(c?.meta.register ? { register: c.meta.register } : {}),
      sources: c ? [...c.meta.sources] : [],
    },
  };
}

export function buildComparison(
  baseline: MindBaseline,
  intel: MindIntelResult,
): MindComparison {
  // Only VERIFIED intelligence counts toward the comparison; an unverified
  // purchase is reported, never merged into the fact set.
  const verified = intel.verificationStatus === "verified";
  const facts = verified ? intel.facts : [];
  const gained = facts.filter((f) => baseline.unknownFields.includes(f.field));
  const remainingGaps = verified
    ? intel.missing.filter((m) => baseline.unknownFields.includes(m))
    : [...baseline.unknownFields];
  return {
    gained,
    remainingGaps,
    conflicts: verified ? intel.disagreements : [],
    fieldsKnownBefore: 0,
    fieldsKnownAfter: gained.length,
    fieldsTotal: COUNTERPARTY_FIELDS.length,
    ...(intel.costUsdCents !== undefined ? { costUsdCents: intel.costUsdCents } : {}),
    verified,
  };
}

export function buildReasoning(args: {
  objective: string;
  entity: MindEntity | null;
  baseline: MindBaseline | null;
  intel?: MindIntelResult;
  comparison?: MindComparison;
  approvedByHuman?: boolean;
}): string[] {
  const r: string[] = [];
  if (args.entity) {
    const j = args.entity.jurisdiction ? ` (jurisdiction ${args.entity.jurisdiction})` : "";
    r.push(`Objective parsed: investigate ${args.entity.company}${j}.`);
  } else {
    r.push(`Objective could not be resolved to a company entity; no specialist ask was planned.`);
    return r;
  }
  const p = args.baseline?.probe;
  if (p) {
    if (p.status === "challenge") {
      r.push(
        `Unpaid pre-flight: the network validates and prices the ${p.intent} ask at ${p.miner} — $${(p.priceUsd ?? 0).toFixed(2)} per answer. Nothing was signed at this stage.`,
      );
    } else if (p.status === "rejected") {
      r.push(`Unpaid pre-flight: the node refused the ask (${p.detail}). No purchase was planned from this state.`);
    } else {
      r.push(`Unpaid pre-flight: the node was unavailable (${p.detail}). No purchase was attempted.`);
    }
  }
  const intel = args.intel;
  if (intel?.purchased) {
    if (args.approvedByHuman) {
      r.push("Human approval was given for this exact plan (engine approval gate) before anything was signed.");
    }
    r.push(
      `Paid ask executed as one attempt, no retry: signal ${intel.signalHash}, receipt ${intel.receiptHash ?? "n/a"}, cost ${(intel.costUsdCents ?? 0) / 100 >= 0 ? `$${((intel.costUsdCents ?? 0) / 100).toFixed(2)}` : "n/a"}.`,
    );
    if (intel.verificationStatus === "verified") {
      r.push("Verification: the signal hash re-derives (keccak) from the node's recorded payload — the purchase is verified against the registry, not just received.");
      r.push(
        `Read the HASH-COMMITTED payload: ${intel.facts.length} fact(s), ${intel.missing.length} canonical field(s) missing, ${intel.disagreements.length} disagreement(s).${intel.meta.asOf ? ` Data as-of ${intel.meta.asOf}.` : ""}`,
      );
    } else {
      r.push(`Verification: the purchase could NOT be verified (${intel.verificationStatus}); its content is reported but excluded from the comparison.`);
    }
  } else {
    r.push("No specialist intelligence was purchased; the report rests on routing knowledge alone.");
  }
  const c = args.comparison;
  if (c) {
    r.push(
      `Comparison: without Telegraph intelligence the Mind knew ${c.fieldsKnownBefore}/${c.fieldsTotal} registry fields; with it ${c.fieldsKnownAfter}/${c.fieldsTotal}${c.verified ? `, at $${((c.costUsdCents ?? 0) / 100).toFixed(2)} verified spend` : " (purchase unverified, so excluded)"}.`,
    );
    if (c.remainingGaps.length > 0) {
      r.push(`Still unknown after intelligence: ${c.remainingGaps.map(mindFieldLabel).join(", ")}.`);
    }
    if (c.conflicts.length > 0) {
      r.push(`Conflicts are reported as conflicts and left unresolved: ${c.conflicts.map((x) => x.field).join(", ")}.`);
    }
  }
  return r;
}
