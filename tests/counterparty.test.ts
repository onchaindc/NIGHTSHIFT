import { describe, expect, it } from "vitest";

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
    expect(spec.params).toEqual({ company: "Equinor ASA", jurisdiction: "Norway" });
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
