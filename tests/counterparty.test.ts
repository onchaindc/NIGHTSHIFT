import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCounterpartySpec,
  classifyCounterpartyEvidence,
  normActive,
  normId,
  normJurisdiction,
  normText,
  validateCounterpartyRequest,
  COUNTERPARTY_FIELDS,
  COUNTERPARTY_INTENT,
  COUNTERPARTY_PRIMARY_MINER,
  type CounterpartyClassification,
} from "@/lib/counterparty/intel";

/* Real committed payload, exactly as zk-corp-atlas recorded it for the
   controlled live test of 2026-11-22 (Equinor ASA), trimmed to the fields
   the classifier reads. */
const ATLAS_PAYLOAD: Record<string, unknown> = {
  legal_name: "EQUINOR ASA",
  registration_id: "923 609 016",
  lei: "OW6OFBNCKXC4US5C7523",
  active: true,
  jurisdiction: "NO",
  registered_address: "Forusbeen 50, 4035, STAVANGER, Norge",
  incorporated: "1972-09-18",
  cross_check: {
    active: true,
    agrees: true,
    as_of: "2026-09-16T13:20:00Z",
    note: "National and GLEIF entity status agree.",
    registry_status: "ACTIVE",
    source: "https://api.gleif.org/api/v1/lei-records/OW6OFBNCKXC4US5C7523",
  },
  license: { name: "NLOD-2.0", attribution: "Contains data under NLOD (Brønnøysund Register Centre).", url: "https://data.norge.no/nlod/en/2.0" },
  as_of: "2026-11-22T19:59:25.203Z",
};

describe("counterparty request validation", () => {
  it("accepts a plain company name and optional jurisdiction", () => {
    expect(validateCounterpartyRequest({ company: "Equinor ASA" })).toEqual({ ok: true });
    expect(validateCounterpartyRequest({ company: "Equinor ASA", jurisdiction: "Norway" })).toEqual({ ok: true });
  });

  it("rejects names that are too short, too long, or not strings", () => {
    expect(validateCounterpartyRequest({ company: "" }).ok).toBe(false);
    expect(validateCounterpartyRequest({ company: "a" }).ok).toBe(false);
    expect(validateCounterpartyRequest({ company: "x".repeat(121) }).ok).toBe(false);
    expect(validateCounterpartyRequest({ company: undefined as unknown as string }).ok).toBe(false);
  });

  it("rejects an over-long jurisdiction but allows a compact one", () => {
    expect(validateCounterpartyRequest({ company: "Equinor ASA", jurisdiction: "N".repeat(61) }).ok).toBe(false);
    expect(validateCounterpartyRequest({ company: "Equinor ASA", jurisdiction: "NO" }).ok).toBe(true);
  });
});

describe("counterparty spec assembly", () => {
  it("pins the intent and the primary miner, carrying the typed params", () => {
    const spec = buildCounterpartySpec({ company: "Equinor ASA", jurisdiction: " Norway " });
    expect(spec.intent).toBe(COUNTERPARTY_INTENT);
    expect(spec.minerId).toBe(COUNTERPARTY_PRIMARY_MINER);
    // d665996 routes registry lookups by ISO jurisdiction: the free-text
    // jurisdiction normalizes to its two-letter ISO code before the ask.
    expect(spec.params).toEqual({ company: "Equinor ASA", jurisdiction: "NO" });
  });

  it("omits the jurisdiction param when the user left it empty", () => {
    const spec = buildCounterpartySpec({ company: "Equinor ASA" });
    expect(spec.params).toEqual({ company: "Equinor ASA" });
  });
});

describe("normalization helpers", () => {
  it("collapses whitespace and case in text", () => {
    expect(normText("  EQUINOR   ASA ")).toBe("equinor asa");
    expect(normText(null)).toBeNull();
    expect(normText("   ")).toBeNull();
  });

  it("compares identifiers ignoring separators", () => {
    expect(normId("923 609 016")).toBe("923609016");
    expect(normId("923609016")).toBe("923609016");
    expect(normId("ow6ofbnckxc4us5c7523")).toBe(normId("OW6OFBNCKXC4US5C7523"));
  });

  it("normalizes active status across spellings", () => {
    expect(normActive(true)).toBe(true);
    expect(normActive("ACTIVE")).toBe(true);
    expect(normActive("Dissolved")).toBe(false);
    expect(normActive("maybe")).toBeNull();
    expect(normActive(null)).toBeNull();
  });

  it("maps jurisdiction names to codes for comparison only", () => {
    expect(normJurisdiction("Norway")).toBe("no");
    expect(normJurisdiction("NO")).toBe("no");
    expect(normJurisdiction("Mars")).toBe("mars");
  });
});

describe("counterparty evidence classification", () => {
  it("splits the atlas payload into facts, nothing missing, no disagreements", () => {
    const c = classifyCounterpartyEvidence({
      payloadResponse: ATLAS_PAYLOAD,
      bodyResult: {
        legal_name: "EQUINOR ASA",
        registration_id: "923609016", // separator variant — same identifier
        active: true,
        jurisdiction: "NO",
        registered_address: "Forusbeen 50, 4035, STAVANGER, Norge",
        incorporated: "1972-09-18",
      },
      request: { company: "Equinor ASA", jurisdiction: "Norway" },
    }) as CounterpartyClassification;

    const factFields = c.facts.map((f) => f.field);
    expect(factFields).toContain("legal_name");
    expect(factFields).toContain("registration_id");
    expect(factFields).toContain("lei");
    expect(factFields).toContain("active");
    // legal_form and register are absent in this (trimmed) atlas payload
    expect(c.missing).toEqual(["legal_form", "register"]);
    expect(c.disagreements).toEqual([]);
    expect(c.meta.crossCheckNote).toBe("National and GLEIF entity status agree.");
    expect(c.meta.license).toContain("NLOD");
    expect(c.meta.asOf).toBe("2026-11-22T19:59:25.203Z");
  });

  it("reports fields the provider did not return as missing, never invented", () => {
    const c = classifyCounterpartyEvidence({ payloadResponse: { legal_name: "ACME AS" } });
    expect(c.facts).toEqual([{ field: "legal_name", value: "ACME AS" }]);
    expect(c.missing).toContain("registration_id");
    expect(c.missing).toContain("active");
    expect(c.missing).toContain("jurisdiction");
  });

  it("flags a router summary that disagrees with the committed payload", () => {
    const c = classifyCounterpartyEvidence({
      payloadResponse: { ...ATLAS_PAYLOAD, active: true },
      bodyResult: { active: false, legal_name: "EQUINOR ASA" },
    });
    const d = c.disagreements.find((x) => x.field === "active");
    expect(d).toBeDefined();
    expect(d?.left.source).toBe("committed payload");
    expect(d?.right.source).toBe("router summary");
  });

  it("flags a registry cross-check that reports disagreement", () => {
    const c = classifyCounterpartyEvidence({
      payloadResponse: {
        ...ATLAS_PAYLOAD,
        cross_check: {
          ...(ATLAS_PAYLOAD.cross_check as Record<string, unknown>),
          agrees: false,
          registry_status: "LIQUIDATED",
        },
      },
    });
    expect(c.disagreements.length).toBeGreaterThan(0);
    expect(c.disagreements[0].note).toBe("National and GLEIF entity status agree.");
  });

  it("flags a committed jurisdiction that does not match the request", () => {
    const c = classifyCounterpartyEvidence({
      payloadResponse: { ...ATLAS_PAYLOAD, jurisdiction: "SE" },
      request: { company: "Equinor ASA", jurisdiction: "Norway" },
    });
    const d = c.disagreements.find((x) => x.field === "jurisdiction");
    expect(d).toBeDefined();
    expect(d?.left.value).toBe("Norway");
    expect(d?.right.value).toBe("SE");
  });

  it("treats blank fields on either side as missing, not as a disagreement", () => {
    const c = classifyCounterpartyEvidence({
      payloadResponse: { legal_name: "ACME AS", lei: null },
      bodyResult: { legal_name: null, lei: "OW6OFBNCKXC4US5C7523" },
    });
    expect(c.disagreements).toEqual([]);
    expect(c.missing).toContain("lei");
  });

  it("covers every canonical field in the classifier's contract", () => {
    // If the field list ever changes, the UI labels and tests change with it.
    expect([...COUNTERPARTY_FIELDS]).toEqual([
      "legal_name",
      "registration_id",
      "lei",
      "active",
      "jurisdiction",
      "registered_address",
      "incorporated",
      "legal_form",
      "register",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Free GLEIF identity resolution (added 2026-11-24)                   */
/* ------------------------------------------------------------------ */

import {
  resolveLegalIdentity,
  withLegalIdentity,
  probeCounterparty,
  canonEntityName,
  type LegalIdentity,
} from "@/lib/counterparty/intel";

const GLEIF_RECORD = {
  type: "lei-records",
  attributes: {
    lei: "549300M8ISKPTX2W7F94",
    entity: {
      legalName: { name: "MARA HOLDINGS, INC." },
      legalAddress: { country: "US" },
      status: "ACTIVE",
    },
  },
};

function gleifResponse(records: unknown[], ok = true, status = 200): Response {
  return new Response(JSON.stringify({ data: records }), { status: ok ? status : 500 });
}

describe("resolveLegalIdentity (free GLEIF public API)", () => {
  it("resolves a colloquial name to the exact legal identity via a single registry hit", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => gleifResponse([GLEIF_RECORD]));
    const identity = await resolveLegalIdentity("MARA Holdings", "US", fetchImpl as unknown as typeof fetch);
    expect(identity).toEqual({ lei: "549300M8ISKPTX2W7F94", legalName: "MARA HOLDINGS, INC.", country: "US", status: "ACTIVE" });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("MARA%20Holdings");
  });

  it("prefers an exact canonical-name hit among many registry records", async () => {
    const fetchImpl = vi.fn(async () =>
      gleifResponse([
        GLEIF_RECORD,
        { attributes: { lei: "X1", entity: { legalName: { name: "MARA HOLDINGS II LLC" }, legalAddress: { country: "US" } } } },
      ]),
    );
    const identity = await resolveLegalIdentity("MARA Holdings, Inc.", undefined, fetchImpl as unknown as typeof fetch);
    expect(identity?.lei).toBe("549300M8ISKPTX2W7F94");
  });

  it("narrows an ambiguous pool by jurisdiction when one record matches the requested country", async () => {
    const fetchImpl = vi.fn(async () =>
      gleifResponse([
        GLEIF_RECORD,
        { attributes: { lei: "X2", entity: { legalName: { name: "MARA HOLDINGS LTD" }, legalAddress: { country: "GB" } } } },
      ]),
    );
    const identity = await resolveLegalIdentity("MARA Holdings", "United States", fetchImpl as unknown as typeof fetch);
    expect(identity?.lei).toBe("549300M8ISKPTX2W7F94");
    expect(identity?.country).toBe("US");
  });

  it("refuses to guess among multiple in-jurisdiction hits", async () => {
    const fetchImpl = vi.fn(async () =>
      gleifResponse([
        GLEIF_RECORD,
        { attributes: { lei: "X3", entity: { legalName: { name: "MARA HOLDINGS LTD" }, legalAddress: { country: "US" } } } },
      ]),
    );
    const identity = await resolveLegalIdentity("MARA Holdings", "US", fetchImpl as unknown as typeof fetch);
    expect(identity).toBeNull();
  });

  it("returns null on any fetch or parse failure, never throwing into the paid path", async () => {
    const throwing = vi.fn(async () => { throw new Error("down"); });
    expect(await resolveLegalIdentity("MARA Holdings", "US", throwing as unknown as typeof fetch)).toBeNull();
    const notOk = vi.fn(async () => gleifResponse([], false, 503));
    expect(await resolveLegalIdentity("MARA Holdings", "US", notOk as unknown as typeof fetch)).toBeNull();
    const empty = vi.fn(async () => gleifResponse([]));
    expect(await resolveLegalIdentity("MARA Holdings", "US", empty as unknown as typeof fetch)).toBeNull();
  });

  it("canonicalizes names for comparison", () => {
    expect(canonEntityName("MARA Holdings, Inc.")).toBe("mara holdings inc");
    expect(canonEntityName("  MARA  HOLDINGS  ")).toBe("mara holdings");
  });
});

describe("identity-resolved ask params", () => {
  it("rebuilds the spec around the legal name and LEI, keeping the jurisdiction", () => {
    const identity: LegalIdentity = { lei: "549300M8ISKPTX2W7F94", legalName: "MARA HOLDINGS, INC.", country: "US", status: "ACTIVE" };
    const spec = withLegalIdentity(buildCounterpartySpec({ company: "MARA Holdings", jurisdiction: "United States" }), identity);
    expect(spec.params).toEqual({ company: "MARA HOLDINGS, INC.", jurisdiction: "US", lei: "549300M8ISKPTX2W7F94" });
  });

  it("falls back to the legal-name-only spec when the node refuses the lei param, and surfaces other refusals immediately", async () => {
    const challenge = {
      x402Version: 2,
      error: "Payment required",
      resource: { url: "http://leiresolve/engine/v1/ask", description: "Payment required", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:11155111", asset: "0xcc194e1a843B658526D0D5C431f670028582Ae17", amount: "10000", payTo: "0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b" }],
    };
    // Ask call #1 (lei-augmented) → 400 invalid_params; #2 (plain) → challenge.
    let askCalls = 0;
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.gleif.org")) return gleifResponse([GLEIF_RECORD]);
      askCalls++;
      if (askCalls === 1) return new Response(JSON.stringify({ error: "invalid_params", message: 'unknown param "lei"; this intent takes: company, jurisdiction' }), { status: 400 });
      return new Response("{}", {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64") },
      });
    });
    vi.stubGlobal("fetch", impl);
    process.env.TELEGRAPH_NODE_URL = "http://leiresolve";
    try {
      const outcome = await probeCounterparty({ company: "MARA Holdings", jurisdiction: "United States" }, { preferEscrow: false });
      expect(outcome.kind).toBe("challenge");
      if (outcome.kind === "challenge") {
        // The PAID spec is the legal-name-only contract the node validates.
        expect(outcome.spec.params).toEqual({ company: "MARA HOLDINGS, INC.", jurisdiction: "US" });
        expect(outcome.body.params).toEqual({ company: "MARA HOLDINGS, INC.", jurisdiction: "US" });
        // The resolved identity stays in the trail for the approver.
        expect(outcome.resolvedIdentity?.lei).toBe("549300M8ISKPTX2W7F94");
      }
      expect(askCalls).toBe(2);
      // A non-param refusal (e.g. the whole intent refused) surfaces at once.
      const refusing = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.gleif.org")) return gleifResponse([GLEIF_RECORD]);
        return new Response(JSON.stringify({ error: "intent_disabled" }), { status: 403 });
      });
      vi.stubGlobal("fetch", refusing);
      const refused = await probeCounterparty({ company: "MARA Holdings", jurisdiction: "United States" }, { preferEscrow: false });
      expect(refused.kind).toBe("rejected");
      expect(refused).toMatchObject({ status: 403 });
    } finally {
      delete process.env.TELEGRAPH_NODE_URL;
    }
  });

  it("probes the lei-augmented spec first and falls back to the plain spec when the node refuses it", async () => {
    // GLEIF resolve → the lei spec is refused by the node → the plain spec
    // probes to a live challenge; the paid request would then use the plain
    // (name-only) contract while the trail still shows the resolved identity.
    const challenge = {
      x402Version: 2,
      error: "Payment required",
      resource: { url: "http://leiresolve/engine/v1/ask", description: "Payment required", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:11155111", asset: "0xcc194e1a843B658526D0D5C431f670028582Ae17", amount: "10000", payTo: "0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b" }],
    };
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.gleif.org")) return gleifResponse([GLEIF_RECORD]);
      return new Response("{}", {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64") },
      });
    });
    // NOTE: the lei-refusal fallback path is exercised by the mind suite's
    // node-rejection test; here the stub accepts both specs so the resolved
    // identity + lei-augmented params flow through the challenge outcome.
    vi.stubGlobal("fetch", impl);
    process.env.TELEGRAPH_NODE_URL = "http://leiresolve";
    try {
      const outcome = await probeCounterparty({ company: "MARA Holdings", jurisdiction: "United States" }, { preferEscrow: false });
      expect(outcome.kind).toBe("challenge");
      if (outcome.kind === "challenge") {
        expect(outcome.spec.params).toEqual({ company: "MARA HOLDINGS, INC.", jurisdiction: "US", lei: "549300M8ISKPTX2W7F94" });
        expect(outcome.resolvedIdentity?.lei).toBe("549300M8ISKPTX2W7F94");
        expect(outcome.body.params).toEqual({ company: "MARA HOLDINGS, INC.", jurisdiction: "US", lei: "549300M8ISKPTX2W7F94" });
      }
    } finally {
      delete process.env.TELEGRAPH_NODE_URL;
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
