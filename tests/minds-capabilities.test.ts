import { describe, expect, it, vi } from "vitest";

import { MINDS } from "@/lib/minds/registry";
import {
  CAPABILITIES,
  CAPABILITY_CATALOGUE,
  gapDimensions,
  readinessFor,
  sharedCapabilities,
} from "@/lib/minds/capabilities";
import {
  CapabilityBudgetError,
  CapabilityError,
  buildCapabilityReport,
  buildCapabilitySpec,
  committedResponseOf,
  executeApprovedDimension,
  plannedCeilingUsdCents,
  probeMindCoverage,
  type CapabilityRunnerDeps,
} from "@/lib/minds/capability-runner";
import type { ApprovedOffer, ExecuteOutcome, ProbeOutcome, VerifyOutcome } from "@/lib/terminal/ask";

const OFFER: ApprovedOffer = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e",
  amount: "10000",
};

const CHALLENGE: ProbeOutcome = {
  kind: "challenge",
  challenge: { accepts: [] },
  approvedOffer: OFFER,
  pricedOffer: { network: OFFER.network, asset: OFFER.asset, payTo: OFFER.payTo, amountCents: 1 },
  referencedUrl: "https://node/engine/v1/ask/zk-hashprice",
};

function deps(overrides: Partial<CapabilityRunnerDeps> = {}): CapabilityRunnerDeps {
  return {
    probe: vi.fn(async () => CHALLENGE),
    execute: vi.fn(async () => {
      throw new Error("execute must not be called in this test");
    }),
    verify: vi.fn(async () => ({ kind: "unverified", detail: "not configured" }) as VerifyOutcome),
    now: () => Date.parse("2026-11-24T12:00:00Z"),
    ...overrides,
  };
}

function answeredWith(verify: VerifyOutcome): ExecuteOutcome {
  return {
    kind: "answered",
    urlPath: "/engine/v1/ask/zk-hashprice",
    requestSent: {},
    offer: OFFER,
    result: { price_usd: 64000 },
    signalHash: "0xsignal",
    receipt: { receipt_hash: "0xreceipt", amount_uusdc: "10000" },
  } as ExecuteOutcome;
}

describe("capability matrix", () => {
  it("covers every registered Mind with a real Telegraph catalogue snapshot", () => {
    expect(CAPABILITY_CATALOGUE.intents).toBeGreaterThanOrEqual(100);
    for (const mind of MINDS) {
      const caps = CAPABILITIES[mind.slug];
      expect(caps, mind.slug).toBeDefined();
      expect(caps.dimensions.length).toBeGreaterThan(0);
      expect(new Set(caps.dimensions.map((d) => d.id)).size).toBe(caps.dimensions.length);
    }
  });

  it("never gives a gap an intent or provider, and requires a reason", () => {
    for (const caps of Object.values(CAPABILITIES)) {
      for (const gap of caps.dimensions.filter((d) => d.status === "gap")) {
        expect(gap.intent, `${caps.slug}/${gap.id}`).toBeUndefined();
        expect(gap.provider, `${caps.slug}/${gap.id}`).toBeUndefined();
        expect(gap.missingReason?.length, `${caps.slug}/${gap.id}`).toBeGreaterThan(40);
      }
    }
  });

  it("requires a verified dimension to carry intent, provider, params, output, evidence and price", () => {
    for (const caps of Object.values(CAPABILITIES)) {
      for (const dim of caps.dimensions.filter((d) => d.status !== "gap")) {
        expect(dim.intent, `${caps.slug}/${dim.id}`).toMatch(/^[A-Z0-9_]+$/);
        expect(dim.provider, `${caps.slug}/${dim.id}`).toMatch(/^[a-z0-9-]+$|^router$/);
        expect(Object.keys(dim.params ?? {}).length, `${caps.slug}/${dim.id}`).toBeGreaterThan(0);
        expect(dim.responseFields?.length, `${caps.slug}/${dim.id}`).toBeGreaterThan(0);
        expect(dim.output?.length, `${caps.slug}/${dim.id}`).toBeGreaterThan(20);
        expect(dim.evidence?.length, `${caps.slug}/${dim.id}`).toBeGreaterThan(60);
        expect(dim.priceUsdCents).toBe(1);
        expect(["probe_verified", "integration_verified"]).toContain(dim.verification);
      }
    }
  });

  it("states its verification scope without claiming paid output", () => {
    const probed = Object.values(CAPABILITIES).flatMap((c) =>
      c.dimensions.filter((d) => d.verification === "probe_verified"),
    );
    expect(probed.length).toBeGreaterThan(20);
    for (const dim of probed) {
      expect(dim.evidence).toContain("output quality is not claimed");
    }
    for (const dim of Object.values(CAPABILITIES).flatMap((c) =>
      c.dimensions.filter((d) => d.verification === "integration_verified"),
    )) {
      expect(dim.evidence).toContain("live product path");
    }
  });

  it("builds a plan whose order covers exactly the supported dimensions", () => {
    for (const [slug, caps] of Object.entries(CAPABILITIES)) {
      const supported = caps.dimensions.filter((d) => d.status !== "gap").map((d) => d.id);
      expect(new Set(caps.plan.order), slug).toEqual(new Set(supported));
      expect(new Set(caps.plan.order).size, slug).toBe(caps.plan.order.length);
      expect(caps.plan.budgetCeilingUsdCents, slug).toBe(plannedCeilingUsdCents(slug));
      expect(caps.plan.approvalGate).toContain("approves");
      expect(caps.plan.verification).toContain("re-deriving");
      expect(caps.plan.evidenceRequirements.length).toBeGreaterThan(1);
      expect(caps.plan.reporting.length).toBeGreaterThan(1);
      expect(caps.plan.exclusions.length, slug).toBeGreaterThan(0);
    }
  });

  it("keeps readiness tied to a real executor, not to verified routes", () => {
    expect(readinessFor("index-reconstitution-desk", "available")).toBe("operational");
    expect(readinessFor("counterparty-intelligence", "available")).toBe("operational");
    expect(readinessFor("bitcoin-mining-intelligence", "in_development")).toBe("partial_coverage");
    for (const mind of MINDS.filter((m) => m.status !== "available")) {
      expect(readinessFor(mind.slug, mind.status)).not.toBe("operational");
    }
  });

  it("reuses shared intents instead of duplicating integrations", () => {
    const shared = sharedCapabilities();
    const registryReuse = shared.find((s) => s.intent === "CORPORATE_REGISTRY_LOOKUP_GENERAL");
    expect(registryReuse?.minds.length).toBeGreaterThanOrEqual(4);
    expect(shared.find((s) => s.intent === "GRID_POWER_PRICE_GENERAL")?.minds).toEqual([
      "bitcoin-mining-intelligence",
      "energywatch",
    ]);
  });

  it("names the core unsupported dimensions honestly", () => {
    expect(gapDimensions("ownershipgraph").map((d) => d.id)).toContain("beneficial_ownership");
    expect(gapDimensions("sanctionsdesk").map((d) => d.id)).toContain("related_parties");
    expect(gapDimensions("caseledger").map((d) => d.id)).toContain("docket_retrieval");
    expect(gapDimensions("portsentinel").map((d) => d.id)).toContain("terminal_schedule");
    expect(gapDimensions("chainforensics").map((d) => d.id)).toContain("fund_flow_tracing");
  });
});

describe("capability adapter", () => {
  it("pins a provider and omits the pin for router-routed dimensions", () => {
    const btc = CAPABILITIES["bitcoin-mining-intelligence"].dimensions.find((d) => d.id === "btc_price");
    expect(buildCapabilitySpec(btc!, { symbol: "BTC" })).toEqual({
      intent: "CRYPTO_PRICE_USD",
      params: { symbol: "BTC" },
      minerId: "cp-coinbase",
    });
    const holders = CAPABILITIES["index-reconstitution-desk"].dimensions.find((d) => d.id === "holders");
    expect(buildCapabilitySpec(holders!, { token: "USDC", chain: "ethereum" })).toEqual({
      intent: "TOKEN_HOLDER_COUNT_GENERAL",
      params: { token: "USDC", chain: "ethereum" },
    });
  });

  it("refuses to build a spec for a gap or a missing required parameter", () => {
    const gap = CAPABILITIES["chainforensics"].dimensions.find((d) => d.id === "clustering_labels");
    expect(() => buildCapabilitySpec(gap!, {})).toThrow(CapabilityError);
    const hashprice = CAPABILITIES["bitcoin-mining-intelligence"].dimensions.find((d) => d.id === "hashprice_network");
    expect(() => buildCapabilitySpec(hashprice!, {})).toThrow(/block_height/);
  });

  it("probes only supported dimensions and labels gaps without a network call", async () => {
    const d = deps();
    const result = await probeMindCoverage("bitcoin-mining-intelligence", { deps: d });
    expect(result.routable).toBe(3);
    expect(result.gaps).toBe(2);
    expect(result.plannedCostUsdCents).toBe(3);
    expect(d.probe).toHaveBeenCalledTimes(3);
    expect(result.dimensions.filter((x) => x.status === "gap")).toHaveLength(2);
    expect(result.dimensions.find((x) => x.dimension === "hashprice_network")).toMatchObject({
      status: "routable",
      provider: "zk-hashprice",
      priceUsdCents: 1,
    });
  });

  it("surfaces a node rejection as rejected, never routable", async () => {
    const d = deps({
      probe: vi.fn(async () => ({ kind: "rejected", status: 400, body: {}, text: "invalid_params" }) as ProbeOutcome),
    });
    const result = await probeMindCoverage("counterparty-intelligence", { deps: d });
    expect(result.dimensions[0]).toMatchObject({ status: "rejected", httpStatus: 400 });
    expect(result.routable).toBe(0);
  });

  it("enforces the approved budget before calling the payment rail", async () => {
    const execute = vi.fn(async () => answeredWith({ kind: "unverified", detail: "x" }));
    const d = deps({ execute });
    const btc = CAPABILITIES["bitcoin-mining-intelligence"].dimensions.find((d) => d.id === "btc_price");
    await expect(
      executeApprovedDimension({
        slug: "bitcoin-mining-intelligence",
        dimension: btc!,
        params: { symbol: "BTC" },
        approvedOffer: { ...OFFER, amount: "1000000" }, // $100
        remainingBudgetUsdCents: 50,
        deps: d,
      }),
    ).rejects.toBeInstanceOf(CapabilityBudgetError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes the exact approved offer to the shared executor and verifies the signal", async () => {
    const execute = vi.fn(async () => answeredWith({ kind: "verified", signalHash: "0xsignal", record: {}, note: "ok" }));
    const verify = vi.fn(
      async () =>
        ({
          kind: "verified",
          signalHash: "0xsignal",
          record: { payload: { response: { data: { amount: 64000, base: "BTC", currency: "USD" }, extra: "kept" } } },
          note: "re-derived",
        }) as VerifyOutcome,
    );
    const d = deps({ execute, verify });
    const btc = CAPABILITIES["bitcoin-mining-intelligence"].dimensions.find((x) => x.id === "btc_price");
    const result = await executeApprovedDimension({
      slug: "bitcoin-mining-intelligence",
      dimension: btc!,
      params: { symbol: "BTC" },
      approvedOffer: OFFER,
      remainingBudgetUsdCents: 10,
      deps: d,
    });
    expect(execute).toHaveBeenCalledWith({
      spec: { intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, minerId: "cp-coinbase" },
      approved: true,
      approvedOffer: OFFER,
    });
    expect(verify).toHaveBeenCalledWith("0xsignal");
    expect(result.verification).toBe("verified");
    expect(result.values).toEqual({ price_usd: 64000 });
    expect(result.missingFields).toEqual([]);
    expect(result.costUsdCents).toBe(1);
  });

  it("labels a recorded-but-not-re-derived signal as recorded", async () => {
    const d = deps({
      execute: vi.fn(async () => answeredWith({ kind: "recorded", signalHash: "0xsignal", record: {}, note: "hash mismatch" })),
      verify: vi.fn(
        async () =>
          ({
            kind: "recorded",
            signalHash: "0xsignal",
            record: { payload: { response: { price_usd: 1 } } },
            note: "hash mismatch",
          }) as VerifyOutcome,
      ),
    });
    const btc = CAPABILITIES["bitcoin-mining-intelligence"].dimensions.find((x) => x.id === "btc_price");
    const result = await executeApprovedDimension({
      slug: "bitcoin-mining-intelligence",
      dimension: btc!,
      params: { symbol: "BTC" },
      approvedOffer: OFFER,
      remainingBudgetUsdCents: 10,
      deps: d,
    });
    expect(result.verification).toBe("recorded");
    expect(result.verificationNote).toContain("mismatch");
  });

  it("turns a refused paid request into an error without verifying anything", async () => {
    const verify = vi.fn(async () => ({ kind: "unverified", detail: "x" }) as VerifyOutcome);
    const d = deps({
      execute: vi.fn(async () => ({ kind: "refused", reason: "approval drifted" }) as ExecuteOutcome),
      verify,
    });
    const btc = CAPABILITIES["bitcoin-mining-intelligence"].dimensions.find((x) => x.id === "btc_price");
    await expect(
      executeApprovedDimension({
        slug: "bitcoin-mining-intelligence",
        dimension: btc!,
        params: { symbol: "BTC" },
        approvedOffer: OFFER,
        remainingBudgetUsdCents: 10,
        deps: d,
      }),
    ).rejects.toThrow(/approval drifted/);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("capability reporting", () => {
  it("reads only the hash-committed payload response", () => {
    expect(committedResponseOf({ payload: { response: { a: 1 } } })).toEqual({ a: 1 });
    expect(committedResponseOf({ result: { a: 1 } })).toBeNull();
    expect(committedResponseOf(null)).toBeNull();
    expect(committedResponseOf({ payload: { response: [] } })).toBeNull();
  });

  it("reports routable-but-unverified dimensions as such, with zero findings", async () => {
    const probe = await probeMindCoverage("portsentinel", { deps: deps() });
    const report = buildCapabilityReport({ coverage: probe });
    expect(report.counts.routable_unverified).toBe(7);
    expect(report.counts.verified).toBe(0);
    expect(report.spendUsdCents).toBe(0);
    expect(report.note).toContain("No paid answer was purchased");
    expect(report.missing.map((m) => m.dimension)).toContain("terminal_schedule");
    expect(report.dimensions.find((d) => d.dimension === "port_congestion")?.values).toBeUndefined();
  });

  it("uses committed values only for a verified paid dimension", async () => {
    const probe = await probeMindCoverage("bitcoin-mining-intelligence", { deps: deps() });
    const btc = CAPABILITIES["bitcoin-mining-intelligence"].dimensions.find((d) => d.id === "btc_price")!;
    const report = buildCapabilityReport({
      coverage: probe,
      spendUsdCents: 1,
      committed: [
        {
          dimension: btc.id,
          label: btc.label,
          intent: btc.intent!,
          provider: btc.provider!,
          signalHash: "0xsignal",
          receiptHash: "0xreceipt",
          costUsdCents: 1,
          verification: "verified",
          verificationNote: "re-derived",
          values: { price_usd: 64000 },
          missingFields: [],
          committed: { price_usd: 64000 },
        },
      ],
    });
    expect(report.counts.verified).toBe(1);
    expect(report.counts.routable_unverified).toBe(2);
    expect(report.dimensions.find((d) => d.dimension === "btc_price")?.values).toEqual({ price_usd: 64000 });
    expect(report.spendUsdCents).toBe(1);
    expect(report.note).toContain("hash-committed");
  });
});
