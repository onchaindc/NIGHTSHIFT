/**
 * B2B Counterparty Intelligence — the first product flow on top of Telegraph.
 *
 * Pipeline (every payment property of the Terminal is inherited, not re-built):
 *
 *   1. The user enters a company name and (optionally) a jurisdiction.
 *   2. `probeCounterparty` assembles the canonical body for the intent
 *      CORPORATE_REGISTRY_LOOKUP_GENERAL pinned to the primary provider
 *      zk-corp-atlas (`/engine/v1/ask/zk-corp-atlas`) and runs the UNPAID
 *      pre-flight via `probeAsk` (`@/lib/terminal/ask`). The node validates
 *      input and routing before any payment exists; a valid request answers
 *      with the live x402 challenge.
 *   3. Paying reuses the Terminal's client-signed rail unchanged:
 *      `/api/terminal/challenge` → wallet signature → `/api/terminal/proxy`
 *      with the PAYMENT-SIGNATURE header. Nothing here signs, retries, or
 *      invents an offer: payment happens only after the user approves the
 *      exact challenged offer, and a bare 402 to a signed payload is a
 *      terminal refusal, never a retry.
 *   4. `analyzeCounterparty` verifies the purchase with the Terminal's
 *      `verifySignal` (keccak re-derivation over the recorded payload) and
 *      then reads THE HASH-COMMITTED ANSWER (`record.payload.response`) —
 *      deliberately not the router's summary `result` fields, which drop
 *      data on some providers.
 *   5. `classifyCounterpartyEvidence` splits that committed answer into
 *      verified facts, missing fields, and disagreements (committed payload
 *      vs the paid body's summary fields, the payload's own cross-check,
 *      and the requested jurisdiction). Nothing is fabricated: a field the
 *      provider did not return is reported missing, and a conflict is
 *      reported as a conflict — never silently resolved.
 */

import {
  probeAsk,
  railsOfChallenge,
  verifySignal,
  type ApprovedOffer,
  type ApprovedRail,
  type AskRequestSpec,
  type ProbeOutcome,
  type VerifyOutcome,
} from "@/lib/terminal/ask";

/** The intent this product flow is built on. */
export const COUNTERPARTY_INTENT = "CORPORATE_REGISTRY_LOOKUP_GENERAL";

/** The primary provider: the pinned miner the paid request is routed to. */
export const COUNTERPARTY_PRIMARY_MINER = "zk-corp-atlas";

/**
 * The canonical counterparty fields, as the network's committed payloads for
 * this intent actually carry them (zk-corp-atlas and the LiveCert route both
 * use these names). Anything outside this list a provider returns is shown
 * as extra evidence, never mapped away.
 */
export const COUNTERPARTY_FIELDS = [
  "legal_name",
  "registration_id",
  "lei",
  "active",
  "jurisdiction",
  "registered_address",
  "incorporated",
  "legal_form",
  "register",
] as const;

export type CounterpartyField = (typeof COUNTERPARTY_FIELDS)[number];

/* ------------------------------------------------------------------ */
/* Request validation and spec assembly                                */
/* ------------------------------------------------------------------ */

export interface CounterpartyRequest {
  company: string;
  jurisdiction?: string;
}

export function validateCounterpartyRequest(req: CounterpartyRequest): { ok: true } | { ok: false; error: string } {
  const company = typeof req.company === "string" ? req.company.trim() : "";
  if (company.length < 2 || company.length > 120) {
    return { ok: false, error: "Enter a company name of 2–120 characters." };
  }
  if (req.jurisdiction !== undefined) {
    const j = typeof req.jurisdiction === "string" ? req.jurisdiction.trim() : "";
    if (j.length > 60) {
      return { ok: false, error: "Keep the jurisdiction under 60 characters." };
    }
  }
  return { ok: true };
}

/**
 * Country names and common spellings → ISO 3166-1 alpha-2. The specialist
 * routes lookups by jurisdiction code; "USA" or "United Kingdom" is not the
 * same input as "US" / "GB", and a name it cannot route is charged and then
 * answered with "no match". Codes are passed through uppercased and an
 * unknown name is sent verbatim (the node may still understand it).
 */
const JURISDICTION_CODES: Record<string, string> = {
  norway: "NO",
  norge: "NO",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  ireland: "IE",
  germany: "DE",
  deutschland: "DE",
  france: "FR",
  netherlands: "NL",
  "the netherlands": "NL",
  belgium: "BE",
  switzerland: "CH",
  austria: "AT",
  spain: "ES",
  italy: "IT",
  portugal: "PT",
  poland: "PL",
  sweden: "SE",
  denmark: "DK",
  finland: "FI",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  canada: "CA",
  australia: "AU",
  singapore: "SG",
  japan: "JP",
  "hong kong": "HK",
  india: "IN",
  brazil: "BR",
  "south africa": "ZA",
};

export function normalizeJurisdiction(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  // Aliases win over the two-letter shortcut: "UK" is two letters but its
  // registry code is GB, so it must go through the map first.
  const key = raw.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const mapped = JURISDICTION_CODES[key];
  if (mapped) return mapped;
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return raw;
}

/**
 * The canonical paid body: the intent plus typed params, pinned to the
 * primary provider. This is exactly the shape the node's input schema v3
 * echoes back, so the user sees what the miner was paid to answer.
 */
export function buildCounterpartySpec(req: CounterpartyRequest): AskRequestSpec {
  const params: Record<string, unknown> = { company: req.company.trim() };
  const jurisdiction = typeof req.jurisdiction === "string" ? normalizeJurisdiction(req.jurisdiction) : "";
  if (jurisdiction) params.jurisdiction = jurisdiction;
  return { intent: COUNTERPARTY_INTENT, params, minerId: COUNTERPARTY_PRIMARY_MINER };
}

/* ------------------------------------------------------------------ */
/* Free legal-identity resolution (GLEIF public API)                   */
/* ------------------------------------------------------------------ */

/** The exact legal identity, resolved on GLEIF's free public registry. */
export interface LegalIdentity {
  lei: string;
  legalName: string;
  country: string;
  status: string;
}

/**
 * Resolve the colloquial company name the user typed into the EXACT legal
 * identity the paid miner's matcher requires ("MARA Holdings" → "MARA
 * HOLDINGS, INC.", LEI 549300M8ISKPTX2W7F94). Observed live 2026-11-24: the
 * miner 404s ("no exact GLEIF legal-identity match in the requested
 * jurisdiction; absence is not an inactive verdict") when sent a colloquial
 * name, and the request still settles — so the identity is resolved for FREE
 * before anything is paid. Deterministic: an exact canonical-name hit wins;
 * otherwise a single in-jurisdiction hit is accepted; anything ambiguous or
 * empty returns null and the ask is sent as the user wrote it (the miner's
 * own verdict is then about the registry, not about our guesswork). Never
 * throws: any failure returns null and the paid path proceeds unchanged.
 */
export async function resolveLegalIdentity(
  company: string,
  jurisdiction: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<LegalIdentity | null> {
  const name = company.trim();
  if (!name) return null;
  try {
    const url = `https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=${encodeURIComponent(name)}&page%5Bsize%5D=10`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!res.ok) return null;
    const parsed = (await res.json().catch(() => null)) as {
      data?: Array<{
        attributes?: {
          lei?: string;
          entity?: { legalName?: { name?: string }; legalAddress?: { country?: string }; status?: string };
        };
      }>;
    } | null;
    const records: Array<{ lei: string; legalName: string; country: string; status: string }> = [];
    for (const r of parsed?.data ?? []) {
      const a = r.attributes;
      if (!a?.lei || !a.entity?.legalName?.name || !a.entity?.legalAddress?.country) continue;
      records.push({ lei: a.lei, legalName: a.entity.legalName.name, country: a.entity.legalAddress.country, status: a.entity.status ?? "" });
    }
    if (!records.length) return null;
    const target = canonEntityName(name);
    const wanted = jurisdiction ? normalizeJurisdiction(jurisdiction).toUpperCase() : "";
    const inJurisdiction = (r: (typeof records)[number]) => !wanted || r.country.toUpperCase() === wanted;
    const exact = records.filter((r) => inJurisdiction(r) && canonEntityName(r.legalName) === target);
    const pool = exact.length ? exact : records.filter(inJurisdiction);
    if (pool.length !== 1) return null;
    const hit = pool[0];
    return {
      lei: hit.lei,
      legalName: hit.legalName,
      country: hit.country,
      status: hit.status,
    };
  } catch {
    return null;
  }
}

/** Loose canonical form for identity-name comparison. */
export function canonEntityName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Which ladder candidate the node's unpaid validation accepted. */
export type SpecVariant = "identifier" | "legal-name" | "as-typed";

export type CounterpartyProbeOutcome =
  | {
      kind: "challenge";
      /** The exact spec the user is approving; paying resends it verbatim. */
      spec: AskRequestSpec;
      /** Which ladder candidate won (identifier-first per the miner's contract). */
      specVariant?: SpecVariant;
      urlPath: string;
      body: { intent: string; params: Record<string, unknown> };
      approvedOffer: ApprovedOffer;
      /** Every signable exact-scheme EVM rail the challenge offered. */
      rails?: ApprovedRail[];
      /** The free GLEIF identity the ask was pinned to, when resolution succeeded. */
      resolvedIdentity?: LegalIdentity | null;
      priceUsd: number;
    }
  | { kind: "rejected"; status: number; body: Record<string, unknown> | null; text: string }
  | { kind: "unavailable"; detail: string };

/**
 * The UNPAID pre-flight for the counterparty flow. Reuses `probeAsk`
 * directly — the same validation, the same challenge decoding, and the same
 * guarantee that nothing is ever signed here.
 */
export async function probeCounterparty(
  req: CounterpartyRequest,
  opts: { preferEscrow?: boolean } = {},
): Promise<CounterpartyProbeOutcome> {
  const valid = validateCounterpartyRequest(req);
  if (!valid.ok) {
    return { kind: "rejected", status: 0, body: { error: valid.error }, text: valid.error };
  }
  // Free identity resolution BEFORE anything is paid: name-only searches are
  // rejected by the pinned miner (observed live 2026-11-24: a colloquial name
  // 404s NOT_FOUND and the exact legal name 422s SEARCH_TOO_BROAD — "supply a
  // LEI or exact registry identifier"), and the payment settles before that
  // verdict. GLEIF's free public registry resolves the identifier first.
  const base = buildCounterpartySpec(req);
  const identity = await resolveLegalIdentity(
    req.company,
    typeof base.params?.jurisdiction === "string" ? (base.params.jurisdiction as string) : undefined,
  );
  // Spec ladder, identifier FIRST (the miner's stated contract): (1) the LEI
  // as the registry identifier, (2) the resolved legal name alone, (3) the
  // raw input unchanged when nothing resolved. The intent's param allowlist
  // is {company, jurisdiction}, so the identifier rides in `company`. The
  // paid request is whichever candidate the node's unpaid validation accepted.
  const withLei = identity ? { ...base, params: { ...base.params, company: identity.lei } } : null;
  const resolvedNameOnly = identity ? { ...base, params: { ...base.params, company: identity.legalName } } : null;
  const preferEscrow = opts.preferEscrow !== false;
  const specs: Array<{ spec: AskRequestSpec; identity: LegalIdentity | null; variant: SpecVariant }> = [
    ...(withLei ? [{ spec: withLei, identity, variant: "identifier" as const }] : []),
    ...(resolvedNameOnly ? [{ spec: resolvedNameOnly, identity, variant: "legal-name" as const }] : []),
    { spec: base, identity: null, variant: "as-typed" as const },
  ];
  let lastRejected: { kind: "rejected"; status: number; body: Record<string, unknown> | null; text: string } | null = null;
  for (const candidate of specs) {
    const outcome = await probeAsk(candidate.spec, { preferEscrow });
    if (outcome.kind === "rejected") {
      lastRejected = outcome;
      // Retry only when the node refused the PARAMS (observed live: extra
      // params outside {company, jurisdiction} are refused). Any other
      // refusal is about the ask itself and must surface immediately.
      const rejection = JSON.stringify(outcome.body ?? {}).toLowerCase() + outcome.text.toLowerCase();
      if (!rejection.includes("unknown param") && !rejection.includes("invalid_params")) return outcome;
      continue;
    }
    if (outcome.kind !== "challenge") return outcome;
    return {
      kind: "challenge",
      spec: candidate.spec,
      specVariant: candidate.variant,
      urlPath: outcome.referencedUrl.replace(/^https?:\/\/[^/]+/, ""),
      body: { intent: COUNTERPARTY_INTENT, params: candidate.spec.params as Record<string, unknown> },
      approvedOffer: outcome.approvedOffer,
      rails: outcome.rails ?? railsOfChallenge(outcome.challenge),
      resolvedIdentity: candidate.identity,
      priceUsd: outcome.pricedOffer.amountCents / 100,
    };
  }
  return lastRejected as NonNullable<typeof lastRejected>;
}

/* ------------------------------------------------------------------ */
/* Normalization (shared by classification; exported for tests)        */
/* ------------------------------------------------------------------ */

/** Loose text comparison: trim, collapse whitespace, lowercase. */
export function normText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, " ").toLowerCase();
  return s.length ? s : null;
}

/** Identifier comparison: ignore separators/casing ("923 609 016" ≡ "923609016"). */
export function normId(v: unknown): string | null {
  const s = normText(v);
  return s ? s.replace(/[^a-z0-9]/g, "") : null;
}

/** Booleans stay booleans; strings "true"/"active" normalize to true. */
export function normActive(v: unknown): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = normText(v);
  if (!s) return null;
  if (["true", "active", "yes", "1"].includes(s)) return true;
  if (["false", "inactive", "no", "0", "dissolved", "liquidated", "deleted"].includes(s)) return false;
  return null;
}

/** Small, honest jurisdiction alias map for comparison only (never displayed). */
const JURISDICTION_ALIASES: Record<string, string> = {
  norway: "no",
  "united states": "us",
  usa: "us",
  "united kingdom": "gb",
  germany: "de",
  deutschland: "de",
  france: "fr",
  netherlands: "nl",
  sweden: "se",
  denmark: "dk",
  finland: "fi",
};

export function normJurisdiction(v: unknown): string | null {
  const s = normText(v);
  if (!s) return null;
  return JURISDICTION_ALIASES[s] ?? s;
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

export interface CounterpartyFact {
  field: CounterpartyField;
  value: unknown;
}

export interface CounterpartyDisagreement {
  field: string;
  left: { source: string; value: unknown };
  right: { source: string; value: unknown };
  note?: string;
}

export interface CounterpartyClassification {
  /** Fields the committed payload actually carries. */
  facts: CounterpartyFact[];
  /** Canonical fields the provider did not return (or returned null). */
  missing: CounterpartyField[];
  /** Conflicts, shown as conflicts — never silently resolved. */
  disagreements: CounterpartyDisagreement[];
  /** Extra committed evidence beyond the canonical fields (e.g. cross_check). */
  extras: Record<string, unknown>;
  meta: {
    confidence?: number;
    asOf?: string;
    register?: string;
    license?: string;
    crossCheckSource?: string;
    crossCheckNote?: string;
    sources: string[];
  };
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim().length === 0);
}

function pushDisagreement(
  out: CounterpartyDisagreement[],
  field: string,
  left: { source: string; value: unknown },
  right: { source: string; value: unknown },
  note?: string,
): void {
  out.push({ field, left, right, note });
}

/**
 * Compare the committed payload with the paid body's summary `result` and the
 * request itself. Comparisons normalize spacing/casing; a field that is blank
 * on either side is missing evidence, not a disagreement.
 */
export function classifyCounterpartyEvidence(args: {
  payloadResponse: Record<string, unknown>;
  bodyResult?: Record<string, unknown> | null;
  request?: CounterpartyRequest | null;
}): CounterpartyClassification {
  const { payloadResponse, bodyResult, request } = args;
  const facts: CounterpartyFact[] = [];
  const missing: CounterpartyField[] = [];
  const disagreements: CounterpartyDisagreement[] = [];

  for (const field of COUNTERPARTY_FIELDS) {
    const v = payloadResponse[field];
    if (isBlank(v)) {
      missing.push(field);
    } else {
      facts.push({ field, value: v });
    }
  }

  // The payload's own cross-check: the provider compares the registry status
  // with a second source (e.g. GLEIF) and reports whether they agree.
  const cross = payloadResponse.cross_check;
  if (cross && typeof cross === "object" && !Array.isArray(cross)) {
    const cc = cross as Record<string, unknown>;
    if (cc.agrees === false) {
      pushDisagreement(
        disagreements,
        typeof cc.registry_status === "string" ? "active" : "cross_check",
        { source: "committed payload", value: cc.registry_status ?? payloadResponse.active ?? null },
        { source: typeof cc.source === "string" ? cc.source : "provider cross-check", value: "reported as not agreeing" },
        typeof cc.note === "string" ? cc.note : undefined,
      );
    }
  }

  // Router summary vs committed payload: same field, both present, normalized
  // values differ. Identifier-style fields compare separator-insensitive.
  if (bodyResult && typeof bodyResult === "object" && !Array.isArray(bodyResult)) {
    for (const field of COUNTERPARTY_FIELDS) {
      const a = payloadResponse[field];
      const b = (bodyResult as Record<string, unknown>)[field];
      if (isBlank(a) || isBlank(b)) continue;
      const same = field === "active"
        ? normActive(a) === normActive(b)
        : field === "registration_id" || field === "lei" || field === "jurisdiction"
          ? normId(a) === normId(b) || normJurisdiction(a) === normJurisdiction(b)
          : normText(a) === normText(b);
      if (!same) {
        pushDisagreement(
          disagreements,
          field,
          { source: "committed payload", value: a },
          { source: "router summary", value: b },
        );
      }
    }
  }

  // What was asked vs what was committed: a jurisdiction the user named that
  // the committed answer does not match is a disagreement, not silently accepted.
  if (request?.jurisdiction) {
    const asked = normJurisdiction(request.jurisdiction);
    const answered = normJurisdiction(payloadResponse.jurisdiction);
    if (asked && answered && asked !== answered) {
      pushDisagreement(
        disagreements,
        "jurisdiction",
        { source: "request", value: request.jurisdiction },
        { source: "committed payload", value: payloadResponse.jurisdiction },
      );
    }
  }

  // Extra committed evidence, passed through untouched.
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payloadResponse)) {
    if (!(COUNTERPARTY_FIELDS as readonly string[]).includes(k) && !isBlank(v)) {
      extras[k] = v;
    }
  }

  const meta: CounterpartyClassification["meta"] = { sources: [] };
  if (typeof payloadResponse.confidence === "number") meta.confidence = payloadResponse.confidence;
  for (const key of ["as_of", "fetched_at", "checked_at"] as const) {
    if (typeof payloadResponse[key] === "string") { meta.asOf = payloadResponse[key]; break; }
  }
  if (typeof payloadResponse.register === "string") meta.register = payloadResponse.register;
  const license = payloadResponse.license;
  if (license && typeof license === "object" && typeof (license as Record<string, unknown>).attribution === "string") {
    meta.license = (license as Record<string, unknown>).attribution as string;
  }
  if (cross && typeof cross === "object") {
    const cc = cross as Record<string, unknown>;
    if (typeof cc.source === "string") meta.crossCheckSource = cc.source;
    if (typeof cc.note === "string") meta.crossCheckNote = cc.note;
  }
  const sources = payloadResponse.sources;
  if (Array.isArray(sources)) {
    meta.sources = sources.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 10);
  }

  return { facts, missing, disagreements, extras, meta };
}

/* ------------------------------------------------------------------ */
/* Analysis: verify the purchase, then read the committed answer       */
/* ------------------------------------------------------------------ */

export type CounterpartyAnalysis =
  | {
      kind: "analyzed";
      signalHash: string;
      verification: VerifyOutcome;
      /** The hash-committed answer (record.payload.response), or null if the record carries none. */
      committed: Record<string, unknown> | null;
      classification: CounterpartyClassification | null;
    }
  | { kind: "unverified"; signalHash: string; verification: VerifyOutcome };

function committedResponseOf(record: unknown): Record<string, unknown> | null {
  if (typeof record !== "object" || record === null) return null;
  const payload = (record as Record<string, unknown>).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const response = (payload as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) return null;
  return response as Record<string, unknown>;
}

/**
 * Post-purchase analysis for one signal: the Terminal's `verifySignal` (keccak
 * re-derivation) decides whether the purchase is confirmed; the hash-committed
 * `payload.response` — never the router's summary fields — is what gets
 * classified. `bodyResult` is the paid body's `result`, used only to detect
 * disagreements against the committed answer.
 */
export async function analyzeCounterparty(
  signalHash: string,
  bodyResult?: Record<string, unknown> | null,
  request?: CounterpartyRequest | null,
): Promise<CounterpartyAnalysis> {
  const verification = await verifySignal(signalHash);
  if (verification.kind === "unverified") {
    return { kind: "unverified", signalHash, verification };
  }
  const committed = committedResponseOf(verification.record);
  const classification = committed
    ? classifyCounterpartyEvidence({ payloadResponse: committed, bodyResult, request })
    : null;
  return { kind: "analyzed", signalHash, verification, committed, classification };
}
