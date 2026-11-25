import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/engine/store", () => ({ saveTask: vi.fn(async () => undefined) }));

import type { TaskRecord } from "@/lib/engine/types";
import { CAPABILITIES } from "@/lib/minds/capabilities";
import { describeAskFailure, probeCapabilitySet, sampleParams, type CapabilityRunnerDeps } from "@/lib/minds/capability-runner";
import type { ApprovedOffer, ExecuteOutcome, ProbeOutcome, VerifyOutcome } from "@/lib/terminal/ask";
import { executeCapabilityAsk, resetCapabilityDeps, setCapabilityDeps } from "@/lib/mind/capability-execute";
import type { CapabilityRunConfig, CapabilityRunPlan } from "@/lib/minds/capability-plan";

const OFFER: ApprovedOffer = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e",
  amount: "10000",
};

const challenge = (amountCents: number): ProbeOutcome => ({
  kind: "challenge",
  challenge: { accepts: [] },
  approvedOffer: { ...OFFER, amount: String(amountCents * 10000) },
  pricedOffer: { network: OFFER.network, asset: OFFER.asset, payTo: OFFER.payTo, amountCents },
  referencedUrl: "https://node/engine/v1/ask/x",
});

const ANSWERED: ExecuteOutcome = {
  kind: "answered",
  urlPath: "/engine/v1/ask/alt",
  requestSent: {},
  offer: OFFER,
  result: { match_score: 0.94, matched: true },
  minerName: "alt-provider",
  signalHash: "0xsignal",
  receipt: { receipt_hash: "0xreceipt" },
} as ExecuteOutcome;

const RAW_FAILURE =
  'Party identity: No verified answer for Party identity: the payment failed after settlement may have begun: HTTP 500 {"error":"[SEARCH_TOO_BROAD]: GLEIF search is too broad; supply an identifier.","intent":"CORPORATE_REGISTRY_LOOKUP_GENERAL"} {"status":"not_credited","message":"Your payment settled but the provider could not be credited, and no answer was delivered"}';

function taskFor(limitUsdCents: number): TaskRecord {
  return {
    id: "task-failover",
    createdAt: 1,
    updatedAt: 1,
    state: "executing",
    goal: "capability failover",
    plan: [],
    events: [],
    spend: { limitUsdCents, spentUsdCents: 0, entries: [] },
    permissions: { allowedActions: ["telegraph.ask"], requiresApproval: false, maxRetries: 0 },
    criteria: {
      primaryVerifiedAgainstNodeSignal: true,
      answerSane: true,
      answerMaxAgeSeconds: 300,
      ownPaymentSettledOnChain: true,
      reconcileLedgerEntries: true,
    },
    result: null,
    error: null,
    origin: { source: "web" },
    jobType: "capability_run",
  };
}

function oneOfferBaseline(slug: string): {
  config: CapabilityRunConfig;
  baseline: {
    config: CapabilityRunConfig;
    plannedCostUsdCents: number;
    offers: Array<{
      dimension: (typeof CAPABILITIES)[string]["dimensions"][number];
      spec: { intent: string; params: Record<string, unknown>; minerId?: string };
      approvedOffer: ApprovedOffer;
      priceUsdCents: number;
    }>;
  };
} {
  const dim = CAPABILITIES[slug].dimensions.find((d) => d.status !== "gap")!;
  const config = { slug, mode: "intel" as const, inputs: {} };
  return {
    config,
    baseline: {
      config,
      plannedCostUsdCents: 1,
      offers: [{ dimension: dim, spec: { intent: dim.intent!, params: {} }, approvedOffer: OFFER, priceUsdCents: 1 }],
    },
  };
}

afterEach(() => resetCapabilityDeps());

describe("autonomous failover", () => {
  it("re-routes a failed paid ask through the router and attributes the answer to whoever served it", async () => {
    const { config, baseline } = oneOfferBaseline("caseledger");
    const task = taskFor(10);
    const deps: CapabilityRunnerDeps = {
      probe: vi.fn(async () => challenge(1)),
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "failed",
          status: 500,
          detail: RAW_FAILURE,
          paymentSettled: false,
        } as ExecuteOutcome)
        .mockResolvedValueOnce(ANSWERED),
      verify: vi.fn(async () => ({ kind: "verified", signalHash: "0xsignal", record: { payload: { response: { match_score: 0.94 } } }, note: "re-derived" }) as VerifyOutcome),
      now: () => 1_700_000_000_000,
    };
    setCapabilityDeps(deps);

    const outputs = { capabilityBaseline: baseline };
    await executeCapabilityAsk(task, JSON.stringify(config), outputs as never);
    const asks = (outputs as { capabilityAsks?: { answered: number; spendUsdCents: number; committed: Array<{ provider: string; costUsdCents: number }> } }).capabilityAsks!;

    expect(asks.answered).toBe(1);
    expect(asks.committed[0].provider).toBe("alt-provider");
    expect(asks.spendUsdCents).toBe(1);
    expect(task.spend.spentUsdCents).toBe(1);
    expect(task.spend.entries).toHaveLength(1);

    const messages = task.events.map((e) => e.message);
    expect(messages.some((m) => m.includes("the first route failed: the search was too broad"))).toBe(true);
    expect(messages.some((m) => m.includes("re-routing through the router"))).toBe(true);
    expect(messages.some((m) => m.includes("served by alt-provider"))).toBe(true);
    // No raw JSON ever reaches the reader.
    for (const m of messages) expect(m.includes('{"')).toBe(false);
    // The raw body is preserved for audit in event data, not on the page.
    const failed = task.events.find((e) => e.message.includes("first route failed"));
    expect((failed as { data?: { rawDetail?: string } }).data?.rawDetail).toContain("SEARCH_TOO_BROAD");
  });

  it("does not spend past the approved ceiling when the alternate route is pricier", async () => {
    const { config, baseline } = oneOfferBaseline("caseledger");
    const task = taskFor(1);
    task.spend.spentUsdCents = 1; // ceiling consumed by the first (failed) ask
    const deps: CapabilityRunnerDeps = {
      probe: vi.fn(async () => challenge(2)),
      execute: vi.fn(async () => ({ kind: "failed", status: 500, detail: "boom" }) as ExecuteOutcome),
      verify: vi.fn(async () => ({ kind: "unverified", detail: "x" }) as VerifyOutcome),
      now: () => 1_700_000_000_000,
    };
    setCapabilityDeps(deps);

    const outputs = { capabilityBaseline: baseline };
    await expect(executeCapabilityAsk(task, JSON.stringify(config), outputs as never)).rejects.toThrow(/failed/);
    expect(task.spend.spentUsdCents).toBe(1);
    expect(task.events.some((e) => e.message.includes("was not spent"))).toBe(true);
  });

  it("falls back to the router when the pinned provider refuses the free probe", async () => {
    const dims = CAPABILITIES["caseledger"].dimensions.filter((d) => d.status !== "gap");
    const firstDim = dims[0];
    let pinnedCalls = 0;
    const deps: CapabilityRunnerDeps = {
      probe: vi.fn(async (spec) => {
        if (spec.minerId) {
          pinnedCalls += 1;
          return { kind: "rejected", status: 500, text: RAW_FAILURE } as ProbeOutcome;
        }
        return challenge(1);
      }),
      execute: vi.fn(async () => ({ kind: "failed", status: 500, detail: "x" }) as ExecuteOutcome),
      verify: vi.fn(async () => ({ kind: "unverified", detail: "x" }) as VerifyOutcome),
      now: () => 1_700_000_000_000,
    };

    const inputs = Object.fromEntries(dims.map((d) => [d.id, sampleParams(d)]));
    const { coverage, offers } = await probeCapabilitySet("caseledger", inputs, { deps });
    expect(pinnedCalls).toBe(dims.length); // every pinned provider was tried first
    const routable = coverage.dimensions.find((d) => d.dimension === firstDim.id);
    expect(routable && "provider" in routable && routable.provider).toBe("router (fallback)");
    expect(offers).toHaveLength(dims.length);
    expect(offers.every((o) => o.spec.minerId === undefined)).toBe(true); // all executed unpinned
    expect(coverage.dimensions.some((d) => d.status === "rejected")).toBe(false);
  });
});

describe("describeAskFailure", () => {
  it("turns the raw GLEIF blob into one readable sentence with no JSON", () => {
    const text = describeAskFailure(RAW_FAILURE, { httpStatus: 500 });
    expect(text).toContain("the search was too broad");
    expect(text).toContain("not credited");
    expect(text.includes("{")).toBe(false);
  });

  it("stays readable when nothing parseable came back", () => {
    const text = describeAskFailure("<html>Bad Gateway</html>", { httpStatus: 502 });
    expect(text).toContain("HTTP 502");
    expect(text).toContain("could not be completed");
    expect(text.includes("{")).toBe(false);
  });
});
