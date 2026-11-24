import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { CAPABILITIES } from "@/lib/minds/capabilities";
import {
  executeApprovedDimension,
  type CapabilityRunnerDeps,
  type CommittedDimension,
} from "@/lib/minds/capability-runner";
import {
  BitcoinInputError,
  BITCOIN_MINING_SLUG,
  buildBitcoinInputs,
  planBitcoinMining,
  validateBitcoinObjective,
} from "@/lib/bitcoinmining/intel";
import { breakEvenEfficiencyJPerTh, buildBitcoinMiningReport } from "@/lib/bitcoinmining/report";
import type { ExecuteOutcome, ProbeOutcome } from "@/lib/terminal/ask";
import { POST as bitcoinPOST } from "@/app/api/mind/bitcoin-mining/route";

const BLOCK_870000 = "2024-11-12T13:55:46.000Z";
const BLOCK_RECENT = "2026-11-24T00:00:00.000Z";
const PREPARED = "2026-11-24T01:00:00.000Z";

function committed(values: Record<string, unknown>, id: string): CommittedDimension {
  const dim = CAPABILITIES[BITCOIN_MINING_SLUG].dimensions.find((d) => d.id === id)!;
  return {
    dimension: id,
    label: dim.label,
    intent: dim.intent!,
    provider: dim.provider!,
    signalHash: `0x${id}`,
    receiptHash: `0xreceipt-${id}`,
    verifiedAt: "2026-11-24T00:55:02.341Z",
    costUsdCents: 1,
    verification: "verified",
    verificationNote: "re-derived",
    values,
    missingFields: [],
    committed: values,
  };
}

function realAnswers(blockTime = BLOCK_RECENT): CommittedDimension[] {
  return [
    committed(
      {
        hashprice_sats_per_ph_day: 62507.622702,
        hashprice_usd_per_ph_day: null,
        hashrate_eh_s: 727.616449,
        block_height: 977000,
        block_time: blockTime,
        usd_unavailable_reason: "No historical BTC/USD rate is fetched; USD hashprice is unavailable.",
      },
      "hashprice_network",
    ),
    committed({ price_usd: 61113.215 }, "btc_price"),
    committed(
      {
        lmp_usd_per_mwh: 16.64,
        node_or_zone: "HB_WEST",
        market: "real-time",
        interval_start: "2026-11-23T06:00:00.000Z",
        currency: "USD",
      },
      "energy_price",
    ),
  ];
}

const inputs = buildBitcoinInputs({
  blockHeight: 977000,
  zone: "HB_WEST",
  intervalStart: "2026-11-23T00:00:00-06:00",
});

describe("Bitcoin Mining Intelligence objective", () => {
  it("validates a block, zone and timezone-bearing interval", () => {
    const o = validateBitcoinObjective({
      blockHeight: "977299",
      zone: " hb_west ",
      intervalStart: "2026-11-23T00:00:00-06:00",
    });
    expect(o).toEqual({ blockHeight: 977299, zone: "HB_WEST", intervalStart: "2026-11-23T00:00:00-06:00" });
    expect(buildBitcoinInputs(o)).toEqual({
      hashprice_network: { block_height: 977299 },
      btc_price: { symbol: "BTC" },
      energy_price: { node_or_zone: "HB_WEST", interval_start: "2026-11-23T00:00:00-06:00" },
    });
  });

  it("rejects a missing block, bad zone and interval without a timezone", () => {
    expect(() => validateBitcoinObjective({ blockHeight: "", zone: "HB_WEST", intervalStart: "2026-11-23T00:00:00-06:00" })).toThrow(BitcoinInputError);
    expect(() => validateBitcoinObjective({ blockHeight: 1, zone: "not a zone", intervalStart: "2026-11-23T00:00:00-06:00" })).toThrow(/zone/);
    expect(() => validateBitcoinObjective({ blockHeight: 1, zone: "HB_WEST", intervalStart: "2026-11-23 00:00" })).toThrow(/RFC 3339/);
  });

  it("plans two free steps and three approved paid steps under three cents", () => {
    const free = planBitcoinMining({ blockHeight: 1, zone: "HB_WEST", intervalStart: "2026-11-23T00:00:00-06:00" }, "free");
    const intel = planBitcoinMining({ blockHeight: 1, zone: "HB_WEST", intervalStart: "2026-11-23T00:00:00-06:00" }, "intel");
    expect(free.steps.map((s) => s.kind)).toEqual(["capability_baseline", "capability_report"]);
    expect(intel.steps.map((s) => s.kind)).toEqual(["capability_baseline", "capability_ask", "capability_report"]);
    expect(intel.budgetCeilingUsdCents).toBe(3);
    expect(intel.criteria.reconcileLedgerEntries).toBe(true);
  });
});

describe("Bitcoin Mining Intelligence report", () => {
  it("derives USD hashprice from committed sats × committed BTC and computes break-even efficiency", () => {
    const report = buildBitcoinMiningReport({
      mode: "intel",
      inputs,
      committed: realAnswers(),
      preparedAt: PREPARED,
      spendUsdCents: 3,
    });
    expect(report.findings.hashpriceUsdPerPhDay).toBeCloseTo((62507.622702 / 1e8) * 61113.215, 6);
    expect(report.findings.hashpriceUsdBasis).toBe("derived_from_btc");
    expect(report.findings.blockHeight).toBe(977000);
    expect(report.findings.btcPriceUsd).toBe(61113.215);
    expect(report.findings.lmpUsdPerMwh).toBe(16.64);
    expect(report.breakEven?.efficiencyJPerTh).toBeCloseTo(
      (1000 * ((62507.622702 / 1e8) * 61113.215)) / (24 * 16.64),
      6,
    );
    expect(report.alignment.aligned).toBe(true);
    expect(report.confidence).toBe("signal-verified");
    expect(report.spendUsdCents).toBe(3);
  });

  it("flags a historical hashprice block instead of calling it a current operating picture", () => {
    const report = buildBitcoinMiningReport({
      mode: "intel",
      inputs,
      committed: realAnswers(BLOCK_870000),
      preparedAt: PREPARED,
      spendUsdCents: 3,
    });
    expect(report.alignment.aligned).toBe(false);
    expect(report.alignment.notes.join(" ")).toContain("historical");
    expect(report.alignment.notes.join(" ")).toContain("derived");
  });

  it("keeps both unsupported dimensions and gives each a concrete resolution route", () => {
    const report = buildBitcoinMiningReport({
      mode: "intel",
      inputs,
      committed: realAnswers(),
      preparedAt: PREPARED,
      spendUsdCents: 3,
    });
    expect(report.gaps.map((g) => g.dimension)).toEqual(["pool_concentration", "fleet_uptime"]);
    for (const gap of report.gaps) expect(gap.resolution.length).toBeGreaterThan(80);
  });

  it("reports no findings in free mode and no spend", () => {
    const report = buildBitcoinMiningReport({
      mode: "free",
      inputs,
      committed: [],
      preparedAt: PREPARED,
      spendUsdCents: 3,
    });
    expect(report.mode).toBe("free");
    expect(report.spendUsdCents).toBe(0);
    expect(report.findings.hashpriceUsdPerPhDay).toBeNull();
    expect(report.confidence).toBe("unverified");
    expect(report.caveats.join(" ")).toContain("no paid answer");
  });

  it("does not divide by a missing or zero LMP", () => {
    expect(breakEvenEfficiencyJPerTh(38, 0)).toBeNull();
    expect(breakEvenEfficiencyJPerTh(0, 20)).toBeNull();
    expect(breakEvenEfficiencyJPerTh(38, 20)).toBeCloseTo(79.1667, 3);
  });
});

describe("Bitcoin Mining Intelligence API boundary", () => {
  const originalToken = process.env.NIGHTSHIFT_API_TOKEN;
  afterEach(() => {
    if (originalToken === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = originalToken;
  });

  const req = (body: unknown) =>
    new NextRequest("http://localhost/api/mind/bitcoin-mining", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("refuses a paid run without operator auth before touching storage", async () => {
    delete process.env.NIGHTSHIFT_API_TOKEN;
    const res = await bitcoinPOST(
      req({ mode: "intel", blockHeight: 977000, zone: "HB_WEST", intervalStart: "2026-11-23T00:00:00-06:00" }),
    );
    expect(res.status).toBe(401);
  });

  it("validates a free objective before creating a task", async () => {
    const res = await bitcoinPOST(
      req({ mode: "free", blockHeight: 977000, zone: "BAD ZONE", intervalStart: "2026-11-23T00:00:00-06:00" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/zone/);
  });
});

describe("real committed payload shapes", () => {
  const btcDim = CAPABILITIES[BITCOIN_MINING_SLUG].dimensions.find((d) => d.id === "btc_price")!;
  const hashDim = CAPABILITIES[BITCOIN_MINING_SLUG].dimensions.find((d) => d.id === "hashprice_network")!;
  const offer = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD531e46eE0A60F9E5BA78E9a8efCFBD2d35",
    payTo: "0x1234567890abcdef1234567890abcdef12345678",
    amount: "10000",
  };
  const deps = (response: Record<string, unknown>): CapabilityRunnerDeps => ({
    probe: vi.fn(async () => ({ kind: "unavailable", detail: "not used" }) as ProbeOutcome),
    execute: vi.fn(
      async () =>
        ({
          kind: "answered",
          urlPath: "/engine/v1/ask/cp-coinbase",
          requestSent: {},
          offer,
          result: {},
          resultShape: "CRYPTO_PRICE_USD",
          signalHash: "0xsignal",
          receipt: { receipt_hash: "0xreceipt", amount_uusdc: "10000" },
        }) as unknown as ExecuteOutcome,
    ),
    verify: vi.fn(async () => ({
      kind: "verified" as const,
      signalHash: "0xsignal",
      record: { payload: { response, timestamp: "2026-11-24T00:55:02.341Z" } },
      note: "re-derived",
    })),
    now: () => Date.parse(PREPARED),
  });

  it("maps the coinbase answer nested at data.amount without rewriting it", async () => {
    const result = await executeApprovedDimension({
      slug: BITCOIN_MINING_SLUG,
      dimension: btcDim,
      params: { symbol: "BTC" },
      approvedOffer: offer,
      remainingBudgetUsdCents: 3,
      deps: deps({ data: { amount: "61113.215", base: "BTC", currency: "USD" } }),
    });
    expect(result.values).toEqual({ price_usd: "61113.215" });
    expect(result.missingFields).toEqual([]);
    expect(result.verifiedAt).toBe("2026-11-24T00:55:02.341Z");
  });

  it("treats a null provider field as missing evidence, not a finding", async () => {
    const result = await executeApprovedDimension({
      slug: BITCOIN_MINING_SLUG,
      dimension: hashDim,
      params: { block_height: 977000 },
      approvedOffer: offer,
      remainingBudgetUsdCents: 3,
      deps: deps({
        hashprice_sats_per_ph_day: 62507.622702,
        hashprice_usd_per_ph_day: null,
        hashrate_eh_s: 727.616449,
        block_height: 977000,
        block_time: BLOCK_RECENT,
        usd_unavailable_reason: "No historical BTC/USD rate is fetched; USD hashprice is unavailable.",
      }),
    });
    expect(result.values.hashprice_sats_per_ph_day).toBe(62507.622702);
    expect(result.values.hashprice_usd_per_ph_day).toBeUndefined();
    expect(result.missingFields).toContain("hashprice_usd_per_ph_day");
    expect(result.values.usd_unavailable_reason).toContain("No historical BTC/USD rate");
  });
});
