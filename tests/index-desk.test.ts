import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { defaultDeps, approveTask, createTask, runTask } from "@/lib/engine/engine";
import {
  INDEX_FILINGS_INTENT,
  INDEX_HOLDERS_INTENT,
  INDEX_LIQUIDITY_INTENT,
  INDEX_PRICE_INTENT,
  INDEX_REGISTRY_INTENT,
  INDEX_SUPPLY_INTENT,
  buildDimensionSpec,
  extractDimensionValue,
  validateIndexDefinition,
  type IndexAssetDefinition,
  type IndexDefinition,
} from "@/lib/indexdesk/intel";
import { buildIndexProposal, type CollectedAsset, type CollectedDimension } from "@/lib/indexdesk/method";
import { planIndexDesk } from "@/lib/indexdesk/plan";
import { resetIndexDeskDeps, setIndexDeskDeps } from "@/lib/mind/indexdesk-execute";
import type { ExecuteInput, ProbeOutcome } from "@/lib/terminal/ask";
import { POST as indexDeskPOST, GET as indexDeskGET } from "@/app/api/mind/index-desk/route";

/**
 * Index Reconstitution Desk tests. All network effects are injected through
 * setIndexDeskDeps (probe, execute, analyze); nothing touches the real node,
 * so the suite is hermetic and spends nothing.
 */

const SIGNAL = `0x${"cd".repeat(32)}`;
const RECEIPT_HASH = "0xreceipt-index";
const OFFER = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e05dcDD6A19E4e6aDd352",
  payTo: "0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e",
  amount: "10000", // 1¢ in 6-decimal USDC units
};

const definition: IndexDefinition = {
  name: "Test Digital Large Cap",
  methodology: { scheme: "equal" },
  assets: [
    { symbol: "WBTC", issuer: { company: "Wrapped Bitcoin DAO", jurisdiction: "US" }, declared: { circulatingSupply: 1000, priceUsd: 50000 } },
    { symbol: "ETH", issuer: { company: "Ethereum Foundation", jurisdiction: "CH" }, declared: { circulatingSupply: 1000, priceUsd: 3000 } },
  ],
};

function receipt() {
  return {
    receipt_hash: RECEIPT_HASH,
    rail: "x402",
    payer: "0x1234567890abcdef1234567890abcdef12345678",
    miner: "unit-miner",
    intent: INDEX_PRICE_INTENT,
    amount_uusdc: "10000",
    epoch_id: 1,
    settlement: "settled",
    chain: "base-sepolia",
    timestamp: Date.now(),
  };
}

/** A challenge outcome for any (asset, dimension) probe — the live price is 1¢. */
const probeChallenge = (): ProbeOutcome => ({
  kind: "challenge" as const,
  challenge: { x402Version: 2, accepts: [] },
  approvedOffer: OFFER,
  pricedOffer: { network: OFFER.network, asset: OFFER.asset, payTo: OFFER.payTo, amountCents: 1 },
  referencedUrl: "/engine/v1/ask/unit-miner",
});

/** The committed payload each dimension returns, keyed by the intent field. */
function committedFor(dimension: string): Record<string, unknown> {
  switch (dimension) {
    case "price":
      return { price_usd: 50000 };
    case "supply":
      return { total_supply: 21000000 };
    case "liquidity":
      return { liquidity_usd: 120000000 };
    case "holders":
      return { holders_count: 8000000, token_symbol: "WBTC", chain: "ethereum" };
    case "filings":
      return { filing_count: 3, filings: ["Filing A", "Filing B", "Filing C"], urls: ["https://a", "https://b", "https://c"] };
    case "registry":
      return {
        legal_name: "Wrapped Bitcoin DAO",
        registration_id: "12345678",
        active: true,
        jurisdiction: "US",
        registered_address: "1 Test Way",
        incorporated: "2021-01-01",
        legal_form: "DAO LLC",
        register: "Wyoming LLC",
      };
    default:
      return {};
  }
}

/** Field on the committed payload per numeric dimension. */
const FIELD_BY_DIMENSION: Record<string, string> = {
  price: "price_usd",
  supply: "total_supply",
  liquidity: "liquidity_usd",
  holders: "holders_count",
  filings: "filing_count",
};

function collectedFor(definition_: IndexDefinition, dims: Array<[string, Partial<CollectedDimension>]>): CollectedAsset[] {
  return definition_.assets.map((definition_) => ({
    definition: definition_,
    dimensions: dims
      .filter(([symbol]) => symbol === definition_.symbol)
      .map(([, d]) => ({ dimension: d.dimension, status: d.status ?? "verified", detail: d.detail ?? "unit evidence", ...d }) as CollectedDimension),
  }));
}

beforeEach(() => {
  resetIndexDeskDeps();
});
afterEach(() => {
  resetIndexDeskDeps();
  vi.restoreAllMocks();
});

describe("definition validation", () => {
  it("accepts a valid definition and normalizes symbols/jurisdiction casing", () => {
    const r = validateIndexDefinition({
      name: "Test",
      methodology: { scheme: "equal" },
      assets: [
        { symbol: "wbtc", issuer: { company: "Wrapped Bitcoin DAO", jurisdiction: "us" } },
        { symbol: "ETH", issuer: { company: "Ethereum Foundation", jurisdiction: "CH" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.definition.assets[0].symbol).toBe("WBTC");
      expect(r.definition.assets[0].issuer.jurisdiction).toBe("us");
    }
  });

  it("rejects fewer than two assets, a missing jurisdiction, and duplicate symbols", () => {
    const one = validateIndexDefinition({ name: "Test", methodology: { scheme: "equal" }, assets: [definition.assets[0]] });
    expect(one.ok).toBe(false);
    const noJ = validateIndexDefinition({
      name: "Test",
      methodology: { scheme: "equal" },
      assets: [
        { symbol: "A", issuer: { company: "Alpha Inc" } },
        { symbol: "B", issuer: { company: "Beta Inc", jurisdiction: "US" } },
      ],
    });
    expect(noJ.ok).toBe(false);
    if (!noJ.ok) expect(noJ.error).toContain("jurisdiction is required");
    const dup = validateIndexDefinition({
      name: "Test",
      methodology: { scheme: "equal" },
      assets: [
        { symbol: "A", issuer: { company: "Alpha Inc", jurisdiction: "US" } },
        { symbol: "A", issuer: { company: "Alpha Inc", jurisdiction: "US" } },
      ],
    });
    expect(dup.ok).toBe(false);
  });

  it("rejects custom weights that omit an asset or sum to nothing", () => {
    const noWeight = validateIndexDefinition({ name: "T", methodology: { scheme: "custom", customWeights: {} }, assets: definition.assets });
    expect(noWeight.ok).toBe(false);
    const missing = validateIndexDefinition({
      name: "T",
      methodology: { scheme: "custom", customWeights: { WBTC: 50, ETH: 50, SOL: 10 } },
      assets: definition.assets,
    });
    expect(missing.ok).toBe(false);
  });

  it("rejects non-numeric declared inputs", () => {
    const bad = validateIndexDefinition({
      name: "T",
      methodology: { scheme: "equal" },
      assets: [
        { symbol: "A", issuer: { company: "Alpha Inc", jurisdiction: "US" }, declared: { circulatingSupply: -5 } },
        { symbol: "B", issuer: { company: "Beta Inc", jurisdiction: "US" } },
      ],
    });
    expect(bad.ok).toBe(false);
  });
});

describe("dimension specs (verified network coverage)", () => {
  const asset: IndexAssetDefinition = definition.assets[0];

  it("builds the registry ask with the pinned miner and normalized jurisdiction", () => {
    const spec = buildDimensionSpec(asset, "registry");
    expect(spec?.intent).toBe(INDEX_REGISTRY_INTENT);
    expect(spec?.minerId).toBe("zk-corp-atlas");
    expect(spec?.params).toEqual({ company: asset.issuer.company, jurisdiction: "US" });
  });

  it("builds price/supply/holders asks with the verified pins", () => {
    expect(buildDimensionSpec(asset, "price")?.minerId).toBe("cp-coinbase");
    expect(buildDimensionSpec(asset, "price")?.params).toEqual({ symbol: "WBTC" });
    expect(buildDimensionSpec(asset, "supply")?.minerId).toBe("verifywire-token-total-supply");
    expect(buildDimensionSpec(asset, "holders")?.intent).toBe(INDEX_HOLDERS_INTENT);
    expect(buildDimensionSpec(asset, "holders")?.minerId).toBeUndefined(); // routed, never pinned
    expect(buildDimensionSpec(asset, "filings")?.minerId).toBe("verireceipt");
    expect(buildDimensionSpec(asset, "filings")?.params).toEqual({ entity: asset.issuer.company, period: "last 12 months" });
    expect(buildDimensionSpec(asset, "liquidity")).toBeNull(); // no pool declared
  });

  it("makes liquidity askable only with a declared pool", () => {
    const withPool: IndexAssetDefinition = { ...asset, pool: "0xpool" };
    const spec = buildDimensionSpec(withPool, "liquidity");
    expect(spec?.intent).toBe(INDEX_LIQUIDITY_INTENT);
    expect(spec?.params).toEqual({ pool: "0xpool", chain: "ethereum" });
  });

  it("reads committed numbers with honest bounds (never clamps)", () => {
    expect(extractDimensionValue("price", { price_usd: 12.5 })).toEqual({ present: true, value: 12.5 });
    expect(extractDimensionValue("price", { price_usd: "50000" }).present).toBe(false);
    expect(extractDimensionValue("price", {}).present).toBe(false);
    expect(extractDimensionValue("supply", { total_supply: -1 }).present).toBe(false);
    expect(extractDimensionValue("price", { price_usd: 1e12 }).present).toBe(false);
  });
});

describe("deterministic methodology", () => {
  it("equal scheme weights kept assets 1/N and reports concentration", () => {
    const collected: CollectedAsset[] = definition.assets.map((d) => ({
      definition: d,
      dimensions: [
        { dimension: "registry", status: "verified", detail: "verified", registryActive: true, registryFacts: [{ field: "active", value: true }], registryMissing: [] },
      ],
    }));
    const out = buildIndexProposal(definition, collected);
    expect(out.proposal?.weights.map((w) => w.weightPct)).toEqual([50, 50]);
    expect(out.proposal?.concentration.hhi).toBeCloseTo(0.5, 4);
    expect(out.proposal?.concentration.effectiveN).toBeCloseTo(2, 4);
    expect(out.proposal?.concentration.top1Pct).toBe(50);
    // Verified-active issuers make both assets full constituents.
    expect(out.weightedAssets.every((a) => a.status === "included")).toBe(true);
  });

  it("market_cap uses verified or declared inputs and labels mixed provenance as declared", () => {
    const def: IndexDefinition = { ...definition, methodology: { scheme: "market_cap" } };
    const collected: CollectedAsset[] = def.assets.map((d) => ({
      definition: d,
      dimensions: [
        { dimension: "registry", status: "verified", detail: "verified", registryActive: true, registryFacts: [{ field: "active", value: true }], registryMissing: [] },
        { dimension: "supply", status: "verified", value: d.symbol === "WBTC" ? 1000 : 1000, detail: "verified total supply" },
        { dimension: "price", status: "verified", value: d.symbol === "WBTC" ? 50000 : 3000, detail: "verified price" },
      ],
    }));
    const out = buildIndexProposal(def, collected);
    // 1000 × 50000 = 50M vs 1000 × 3000 = 3M → 94.34% / 5.66%.
    expect(out.proposal?.weights[0]).toEqual({ symbol: "WBTC", weightPct: 94.3396 });
    expect(out.proposal?.weights[1]).toEqual({ symbol: "ETH", weightPct: 5.6604 });
    const wbtc = out.weightedAssets.find((a) => a.symbol === "WBTC");
    expect(wbtc?.inputs.marketCap?.provenance).toBe("telegraph-verified");
    expect(wbtc?.inputs.marketCap?.value).toBe(50_000_000);

    // Mixed provenance: verified supply × declared price is labelled declared.
    const mixed: CollectedAsset[] = def.assets.map((d) => ({
      definition: d,
      dimensions: [
        { dimension: "registry", status: "verified", detail: "verified", registryActive: true, registryFacts: [{ field: "active", value: true }], registryMissing: [] },
        { dimension: "supply", status: "verified", value: 1000, detail: "verified" },
      ],
    }));
    const out2 = buildIndexProposal({ ...def, assets: def.assets.map((d) => ({ ...d, declared: { priceUsd: 10 } })) }, mixed);
    expect(out2.weightedAssets.every((a) => a.inputs.marketCap?.provenance === "declared")).toBe(true);
  });

  it("excludes an asset missing required market_cap inputs, and one with a zero custom weight", () => {
    // Strip the declared inputs: without supply/price and without a verified
    // ask, market_cap has nothing to weight with.
    const bare: IndexDefinition = {
      ...definition,
      methodology: { scheme: "market_cap" },
      assets: definition.assets.map(({ symbol, issuer }) => ({ symbol, issuer })),
    };
    const noInputs: CollectedAsset[] = bare.assets.map((d) => ({
      definition: d,
      dimensions: [{ dimension: "registry", status: "verified", detail: "verified", registryActive: true, registryFacts: [{ field: "active", value: true }], registryMissing: [] }],
    }));
    const out = buildIndexProposal(bare, noInputs);
    expect(out.proposal).toBeNull();
    expect(out.proposalBlocker).toContain("fewer than two assets survived");
    expect(out.weightedAssets.every((a) => a.status === "excluded")).toBe(true);

    const customDef: IndexDefinition = {
      ...definition,
      methodology: { scheme: "custom", customWeights: { WBTC: 60, ETH: 40 } },
    };
    const withZero = buildIndexProposal(
      { ...customDef, methodology: { scheme: "custom", customWeights: { WBTC: 60, ETH: 0 } } },
      collectedFor(definition, [
        ["WBTC", { dimension: "registry", status: "verified", registryActive: true, registryFacts: [{ field: "active", value: true }], registryMissing: [] }],
        ["ETH", { dimension: "registry", status: "verified", registryActive: true, registryFacts: [{ field: "active", value: true }], registryMissing: [] }],
      ]),
    );
    const eth = withZero.weightedAssets.find((a) => a.symbol === "ETH");
    expect(eth?.status).toBe("excluded");
    expect(eth?.exclusionReason).toContain("weight is 0");
    // Only one asset survives the rules, so no index weighting is proposed.
    expect(withZero.proposal).toBeNull();
    expect(withZero.proposalBlocker).toContain("1 kept");
  });

  it("excludes issuers verifiably inactive and keeps unverified ones provisional", async () => {
    const threeAssets: IndexDefinition = {
      name: "Three Asset Test",
      methodology: { scheme: "equal" },
      assets: [
        ...definition.assets,
        { symbol: "SOL", issuer: { company: "Solana Labs", jurisdiction: "US" } },
      ],
    };
    const collected: CollectedAsset[] = [
      {
        definition: threeAssets.assets[0],
        dimensions: [{ dimension: "registry", status: "verified", detail: "verified", registryActive: false, registryFacts: [{ field: "active", value: false }], registryMissing: [] }],
      },
      {
        definition: threeAssets.assets[1],
        dimensions: [{ dimension: "registry", status: "verified", detail: "verified", registryActive: true, registryFacts: [{ field: "active", value: true }], registryMissing: [] }],
      },
      {
        definition: threeAssets.assets[2],
        dimensions: [{ dimension: "registry", status: "recorded", detail: "recorded but not re-derived: hash mismatch" }],
      },
    ];
    const out = buildIndexProposal(threeAssets, collected);
    const wbtc = out.weightedAssets.find((a) => a.symbol === "WBTC");
    const eth = out.weightedAssets.find((a) => a.symbol === "ETH");
    const sol = out.weightedAssets.find((a) => a.symbol === "SOL");
    expect(wbtc?.status).toBe("excluded");
    expect(wbtc?.exclusionReason).toContain("not active");
    expect(eth?.status).toBe("included");
    expect(sol?.status).toBe("provisional");
    expect(sol?.provisionalReason).toContain("not verified");
    expect(out.proposal?.weights).toEqual([
      { symbol: "ETH", weightPct: 50 },
      { symbol: "SOL", weightPct: 50 },
    ]);
  });

  it("always ledgers the dimensions the network cannot answer, plus per-asset gaps", () => {
    const collected: CollectedAsset[] = definition.assets.map((d) => ({ definition: d, dimensions: [] }));
    const out = buildIndexProposal(definition, collected);
    const portfolio = out.missingDimensions.filter((m) => m.scope === "portfolio");
    expect(portfolio.map((m) => m.dimension)).toEqual(["Circulating float", "Trading volumes / trading quality"]);
    const liquidity = out.missingDimensions.filter((m) => m.dimension.includes("liquidity"));
    expect(liquidity.length).toBeGreaterThan(0);
    expect(liquidity[0].reason).toContain("no DEX pool was declared");
  });

  it("counts disagreements from explicit data, not prose", () => {
    const collected = collectedFor(definition, [
      ["WBTC", { dimension: "price", status: "verified", value: 50000, disagreements: 2, detail: "verified" }],
    ]);
    const out = buildIndexProposal(definition, collected);
    expect(out.weightedAssets.find((a) => a.symbol === "WBTC")?.dataQuality.disagreements).toBe(2);
  });
});

describe("planning", () => {
  it("intel mode plans baseline → paid asks → report with a cost ceiling", () => {
    const plan = planIndexDesk(definition, "intel");
    expect(plan.steps.map((s) => s.kind)).toEqual(["index_baseline", "index_data_ask", "index_report"]);
    expect(plan.steps[1].maxCostUsdCents).toBe(12); // 2 assets × 6 dims × 1¢
    expect(plan.criteria.primarySource).toBe("telegraph");
    expect(plan.criteria.reconcileLedgerEntries).toBe(true);
  });

  it("free mode never plans a purchase", () => {
    const plan = planIndexDesk(definition, "free");
    expect(plan.steps.map((s) => s.kind)).toEqual(["index_baseline", "index_report"]);
    expect(plan.criteria.primarySource).toBe("free");
  });
});

describe("free-mode desk (no purchase path)", () => {
  it("completes with $0 spend and a declared-only provisional proposal", async () => {
    setIndexDeskDeps({ probe: async () => probeChallenge() });
    const plan = planIndexDesk(definition, "free");
    const task = await createTask({
      goal: "Reconstitute index (free)",
      origin: { source: "web" },
      jobType: "index_desk",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: [],
      requiresApproval: false,
    });
    expect(task.state).toBe("executing");
    const done = await runTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    expect(done.spend.spentUsdCents).toBe(0);
    const report = done.result?.indexDeskReport;
    expect(report?.mode).toBe("free");
    expect(report?.confidence).toBe("unverified");
    expect(report?.intelUsed).toBe(false);
    expect(report?.methodology.proposal?.weights.map((w) => w.weightPct)).toEqual([50, 50]);
    expect(report?.assets.every((a) => a.status === "provisional")).toBe(true);
    expect(report?.reasoning.join(" ")).toContain("Free mode: no purchase path ran");
    expect(done.result?.summary).toContain("free mode");
    const finding = done.result?.evidence.find((e) => e.kind === "index_asset_finding");
    expect(finding && finding.kind === "index_asset_finding" ? finding.totalCostUsdCents : null).toBe(0);
    expect(done.events.map((e) => e.type)).toContain("index_baseline_ready");
  });
});

describe("intel-mode desk (approval-gated paid asks)", () => {
  const fullDefinition: IndexDefinition = {
    name: "Test Desk",
    methodology: { scheme: "market_cap" },
    assets: [
      { symbol: "WBTC", issuer: { company: "Wrapped Bitcoin DAO", jurisdiction: "US" } },
      { symbol: "ETH", issuer: { company: "Ethereum Foundation", jurisdiction: "CH" } },
    ],
  };

  function intelTask(spendLimitUsdCents = 100, def: IndexDefinition = fullDefinition) {
    const plan = planIndexDesk(def, "intel");
    return createTask({
      goal: "Reconstitute index (intel)",
      origin: { source: "web" },
      jobType: "index_desk",
      plan: plan.steps,
      criteria: plan.criteria,
      assumptions: [],
      requiresApproval: true,
      spendLimitUsdCents,
    });
  }

  const equalDefinition: IndexDefinition = {
    name: "Test Desk Equal",
    methodology: { scheme: "equal" },
    assets: fullDefinition.assets,
  };

  it("stops at awaiting_approval with zero spend before approval", async () => {
    const execute = vi.fn(async (_input: ExecuteInput) => ({ kind: "refused" as const, reason: "never" }));
    setIndexDeskDeps({ probe: async () => probeChallenge(), execute });
    const task = await intelTask();
    expect(task.state).toBe("awaiting_approval");
    expect(task.spend.spentUsdCents).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("approval pays one drift-checked ask per dimension, accounts each receipt, and proposes verified weights", async () => {
    const execute = vi.fn(async (input: ExecuteInput) => ({
      kind: "answered" as const,
      urlPath: "/engine/v1/ask/unit",
      requestSent: input.spec,
      offer: OFFER,
      // The router summary is only used to detect disagreements; the real
      // values come from the committed payload in analyze below.
      result: {},
      signalHash: SIGNAL,
      receipt: receipt(),
    }));
    setIndexDeskDeps({
      probe: async () => probeChallenge(),
      execute,
      analyze: async ({ dimension }) => ({
        dimension,
        verification: { kind: "verified" as const, signalHash: SIGNAL, record: {}, note: "keccak match" },
        committed: committedFor(dimension),
        registry:
          dimension === "registry"
            ? {
                facts: [
                  { field: "legal_name", value: committedFor("registry").legal_name },
                  { field: "registration_id", value: committedFor("registry").registration_id },
                  { field: "active", value: true },
                  { field: "jurisdiction", value: "US" },
                ],
                missing: ["lei", "registered_address", "incorporated", "legal_form", "register"],
                disagreements: [],
                extras: {},
                meta: { sources: [] },
              }
            : null,
        value:
          dimension === "registry"
            ? { present: false as const, reason: "structural" }
            : extractDimensionValue(dimension as "price" | "supply" | "liquidity" | "holders" | "filings", committedFor(dimension)),
        disagreements: [],
      }),
    });
    const task = await intelTask(100);
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");

    // 2 assets × 5 askable dimensions (no pools declared → liquidity is not
    // askable), each exactly once.
    expect(execute).toHaveBeenCalledTimes(10);
    const intents = execute.mock.calls.map((c) => c[0].spec.intent);
    expect(intents.filter((i) => i === INDEX_PRICE_INTENT)).toHaveLength(2);
    expect(intents.filter((i) => i === INDEX_SUPPLY_INTENT)).toHaveLength(2);
    expect(intents.filter((i) => i === INDEX_REGISTRY_INTENT)).toHaveLength(2);
    expect(intents.filter((i) => i === INDEX_FILINGS_INTENT)).toHaveLength(2);
    expect(intents.filter((i) => i === INDEX_HOLDERS_INTENT)).toHaveLength(2);
    expect(intents.filter((i) => i === INDEX_LIQUIDITY_INTENT)).toHaveLength(0);

    expect(done.spend.spentUsdCents).toBe(10); // 10 × 1¢
    expect(done.spend.entries).toHaveLength(10);
    expect(done.spend.entries.every((e) => e.receiptHash === RECEIPT_HASH && e.signalHash === SIGNAL)).toBe(true);

    const report = done.result?.indexDeskReport;
    expect(report?.confidence).toBe("signal-verified");
    expect(report?.intelUsed).toBe(true);
    // market_cap weights from VERIFIED supply × VERIFIED price; the fake
    // commits identical supply and price for both assets, so weights tie.
    const wbtc = report?.assets.find((a) => a.symbol === "WBTC");
    const eth = report?.assets.find((a) => a.symbol === "ETH");
    expect(wbtc?.status).toBe("included");
    expect(eth?.status).toBe("included");
    expect(wbtc?.inputs.supply?.provenance).toBe("telegraph-verified");
    expect(wbtc?.inputs.marketCap?.provenance).toBe("telegraph-verified");
    expect(report?.methodology.proposal?.weights[0].symbol).toBe("WBTC");
    expect(report?.methodology.proposal?.weights[0].weightPct).toBe(50);
    expect(report?.methodology.proposal?.weights[1].weightPct).toBe(50);

    const types = done.events.map((e) => e.type);
    expect(types).toContain("index_baseline_ready");
    expect(types).toContain("index_proposal_ready");
    expect(types).toContain("task_completed");
    const spendEvents = done.events.filter((e) => e.type === "spend_recorded");
    expect(spendEvents).toHaveLength(10);

    const finding = done.result?.evidence.find((e) => e.kind === "index_asset_finding");
    if (finding && finding.kind === "index_asset_finding") {
      expect(finding.dimensions.filter((d) => d.status === "verified").every((d) => d.signalHash === SIGNAL)).toBe(true);
    } else {
      throw new Error("index_asset_finding evidence missing");
    }
  });

  it("records an unverified purchase as recorded, keeps the asset provisional, and reports partially-verified confidence", async () => {
    setIndexDeskDeps({
      probe: async () => probeChallenge(),
      execute: async () => ({
        kind: "answered" as const,
        urlPath: "/engine/v1/ask/unit",
        requestSent: {},
        offer: OFFER,
        result: {},
        signalHash: SIGNAL,
        receipt: receipt(),
      }),
      analyze: async ({ dimension }) => ({
        dimension,
        verification: { kind: "recorded" as const, signalHash: SIGNAL, record: {}, note: "hash mismatch" },
        committed: null,
        registry: null,
        value: { present: false as const, reason: "no committed payload" },
        disagreements: [],
      }),
    });
    // Equal scheme: no weighting inputs are required, so the unverified
    // issuer record keeps every asset provisional (kept and flagged).
    const task = await intelTask(100, equalDefinition);
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    const report = done.result?.indexDeskReport;
    expect(report?.confidence).toBe("partially-verified");
    expect(report?.assets.every((a) => a.status === "provisional")).toBe(true);
    expect(report?.assets.every((a) => a.provisionalReason?.includes("not verified"))).toBe(true);
    const dim = done.result?.evidence.find((e) => e.kind === "index_asset_finding");
    if (dim && dim.kind === "index_asset_finding") {
      expect(dim.dimensions.every((d) => d.status !== "verified")).toBe(true);
      expect(dim.dimensions.every((d) => d.signalHash === SIGNAL)).toBe(true);
    } else {
      throw new Error("index_asset_finding evidence missing");
    }
  });

  it("skips asks the remaining budget cannot cover, without signing them", async () => {
    let calls = 0;
    setIndexDeskDeps({
      probe: async () => probeChallenge(),
      execute: vi.fn(async () => {
        calls += 1;
        return {
          kind: "answered" as const,
          urlPath: "/engine/v1/ask/unit",
          requestSent: {},
          offer: OFFER,
          result: { price_usd: 50000 },
          signalHash: SIGNAL,
          receipt: receipt(),
        };
      }),
      analyze: async ({ dimension }) => ({
        dimension,
        verification: { kind: "verified" as const, signalHash: SIGNAL, record: {}, note: "keccak match" },
        committed: committedFor(dimension),
        registry:
          dimension === "registry"
            ? {
                facts: [
                  { field: "legal_name", value: "X" },
                  { field: "registration_id", value: "Y" },
                  { field: "active", value: true },
                  { field: "jurisdiction", value: "US" },
                ],
                missing: [],
                disagreements: [],
                extras: {},
                meta: { sources: [] },
              }
            : null,
        value:
          dimension === "registry"
            ? { present: false as const, reason: "structural" }
            : extractDimensionValue(dimension as "price" | "supply" | "liquidity" | "holders" | "filings", committedFor(dimension)),
        disagreements: [],
      }),
    });
    // 10 planned asks × 1¢ each; a 5¢ limit buys 5, then refuses the rest.
    const task = await intelTask(5);
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("completed");
    expect(calls).toBe(5);
    expect(done.spend.spentUsdCents).toBe(5);
    expect(done.events.filter((e) => e.type === "spend_denied").length).toBe(5);
    const report = done.result?.indexDeskReport;
    expect(report?.missingDimensions.some((m) => m.reason.includes("remaining budget"))).toBe(true);
  });

  it("fails the task honestly when every paid ask fails, and never retries", async () => {
    const execute = vi.fn(async () => ({ kind: "refused" as const, reason: "the live challenge drifted" }));
    setIndexDeskDeps({ probe: async () => probeChallenge(), execute });
    const task = await intelTask(100);
    const done = await approveTask(task.id, defaultDeps());
    expect(done.state).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(10); // one attempt each, no retries
    expect(done.error).toContain("every one of the 10 paid ask(s) failed");
  });
});

describe("index-desk tool endpoint", () => {
  const originalToken = process.env.NIGHTSHIFT_API_TOKEN;
  const req = (init: { body?: string; auth?: string }) =>
    new NextRequest("http://localhost/api/mind/index-desk", {
      method: "POST",
      headers: init.auth ? { Authorization: init.auth } : {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    });

  beforeEach(() => {
    process.env.NIGHTSHIFT_API_TOKEN = "unit-test-operator-token";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = originalToken;
  });

  const validBody = JSON.stringify({ index: definition, mode: "intel" });

  it("rejects unauthenticated intel desks with 401", async () => {
    const res = await indexDeskPOST(req({ body: validBody }));
    expect(res.status).toBe(401);
  });

  it("validates the definition after authentication", async () => {
    const res = await indexDeskPOST(req({ body: "not json", auth: "Bearer unit-test-operator-token" }));
    expect(res.status).toBe(400);
    const res2 = await indexDeskPOST(
      req({ body: JSON.stringify({ index: { name: "T", methodology: { scheme: "wat" }, assets: [] } }), auth: "Bearer unit-test-operator-token" }),
    );
    expect(res2.status).toBe(400);
    const res3 = await indexDeskPOST(
      req({ body: JSON.stringify({ index: definition, mode: "sneaky" }), auth: "Bearer unit-test-operator-token" }),
    );
    expect(res3.status).toBe(400);
  });

  it("creates an intel desk that waits at the approval gate (no spend, no network)", async () => {
    const res = await indexDeskPOST(req({ body: validBody, auth: "Bearer unit-test-operator-token" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task?: { id?: string; state?: string; jobType?: string; spend?: { spentUsdCents?: number } }; note?: string };
    expect(body.task?.state).toBe("awaiting_approval");
    expect(body.task?.jobType).toBe("index_desk");
    expect(body.task?.spend?.spentUsdCents).toBe(0);
    expect(body.note).toContain("awaiting_approval");
  });

  it("describes the tool and its verified coverage on GET", async () => {
    const res = await indexDeskGET(new NextRequest("http://localhost/api/mind/index-desk"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tool: string; modes: string[]; verifiedCoverage?: { dimensions?: Record<string, unknown>; notCovered?: string[] } };
    expect(body.tool).toBe("nightshift.index-desk");
    expect(body.modes).toEqual(["free", "intel"]);
    expect(Object.keys(body.verifiedCoverage?.dimensions ?? {})).toHaveLength(6);
    expect(body.verifiedCoverage?.notCovered?.join(" ")).toContain("float");
  });
});
