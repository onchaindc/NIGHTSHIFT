import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, defineChain, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

/**
 * LIVE paid end-to-end test for the Counterparty Intel flow.
 *
 * Opt-in only: it spends real testnet USDC ($0.01) and runs only when BOTH
 *   COUNTERPARTY_LIVE_TEST=1  AND  NIGHTSHIFT_LIVE_PAYER_KEY
 * are set (the key's address must hold the challenge asset on the challenged
 * chain — the funded paid-research wallet). `npm test` never runs this: the
 * shared setup deletes TELEGRAPH_EVM_PRIVATE_KEY precisely so unit suites
 * stay hermetic, so the payer key travels under its own variable and is
 * re-armed here, only for this file.
 *
 * The flow under test is exactly the product's: probeCounterparty (unpaid) →
 * executeAsk with the approved offer (one paid attempt, no retry) →
 * analyzeCounterparty (keccak verification + the hash-committed payload).
 */
const gated = process.env.COUNTERPARTY_LIVE_TEST === "1" && !!process.env.NIGHTSHIFT_LIVE_PAYER_KEY;
if (gated) {
  process.env.TELEGRAPH_EVM_PRIVATE_KEY = process.env.NIGHTSHIFT_LIVE_PAYER_KEY;
}

const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

function clientFor(chainId: number) {
  // viem bundles the well-known testnets; for any other chain the challenge
  // names, fall back to the public Base Sepolia RPC shape (the network under
  // test in this deployment).
  const chain = chainId === baseSepolia.id
    ? baseSepolia
    : defineChain({
        id: chainId,
        name: `chain-${chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
      });
  return createPublicClient({ chain, transport: http() });
}

async function balanceOf(asset: string, payer: string, chainId: number): Promise<bigint> {
  const client = clientFor(chainId);
  return (await client.readContract({
    address: asset as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [payer as `0x${string}`],
  })) as bigint;
}

describe.skipIf(!gated)("counterparty live flow (paid)", () => {
  const REQUEST = { company: "Equinor ASA", jurisdiction: "Norway" };
  let before: { balance: bigint; asset: string; chainId: number; payer: string } | null = null;

  beforeAll(async () => {
    // Read the payer's balance of the challenge asset BEFORE paying, so the
    // test can prove exactly one settlement happened afterwards.
    const { probeCounterparty } = await import("@/lib/counterparty/intel");
    const probe = await probeCounterparty(REQUEST);
    if (probe.kind !== "challenge") {
      throw new Error(`pre-flight did not produce a challenge: ${JSON.stringify(probe).slice(0, 300)}`);
    }
    const account = privateKeyToAccount(process.env.TELEGRAPH_EVM_PRIVATE_KEY as `0x${string}`);
    const asset = probe.approvedOffer.asset;
    const chainId = Number(probe.approvedOffer.network.replace(/^eip155:/, ""));
    before = { balance: await balanceOf(asset, account.address, chainId), asset, chainId, payer: account.address };
  }, 60_000);

  it("probes unpaid, pays exactly once, verifies, and classifies the committed answer", async () => {
    const { probeCounterparty, analyzeCounterparty } = await import("@/lib/counterparty/intel");
    const { executeAsk } = await import("@/lib/terminal/ask");

    // 1. Unpaid pre-flight.
    const probe = await probeCounterparty(REQUEST);
    expect(probe.kind).toBe("challenge");
    if (probe.kind !== "challenge") return;

    // 2. ONE paid attempt with the approved offer. Any refusal here must be
    //    terminal: the test must not re-send a refused payment.
    const executed = await executeAsk({ spec: probe.spec, approved: true, approvedOffer: probe.approvedOffer });

    if (executed.kind !== "answered") {
      const noSettleKinds = ["refused", "unpaid_rejected", "payment_rejected"];
      const settledUnknown = !noSettleKinds.includes(executed.kind);
      throw new Error(
        settledUnknown
          ? `paid attempt failed after possible settlement: ${JSON.stringify(executed).slice(0, 400)}`
          : `paid attempt refused before settlement: ${JSON.stringify(executed).slice(0, 400)}`,
      );
    }

    expect(executed.receipt.receipt_hash).toBeTruthy();
    expect(executed.signalHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // 3. Exactly one settlement on chain: balance dropped by the challenged
    //    amount (10000 atomic = $0.01), never more.
    if (before) {
      const after = await balanceOf(before.asset, before.payer, before.chainId);
      const delta = before.balance - after;
      expect(delta).toBeGreaterThan(0n);
      expect(delta).toBeLessThanOrEqual(10000n);
    }

    // 4. Analysis: keccak-verified signal + the hash-committed answer.
    const analysis = await analyzeCounterparty(
      executed.signalHash,
      (executed.result ?? null) as Record<string, unknown> | null,
      REQUEST,
    );
    expect(analysis.kind).toBe("analyzed");
    if (analysis.kind !== "analyzed") return;
    expect(analysis.verification.kind).toBe("verified");
    expect(analysis.committed).not.toBeNull();
    expect(analysis.classification).not.toBeNull();
    if (!analysis.classification) return;

    const c = analysis.classification;
    const factFields = c.facts.map((f) => f.field);
    expect(factFields).toContain("legal_name");
    expect(factFields).toContain("registration_id");
    expect(c.facts.find((f) => f.field === "active")?.value).toBe(true);
    // The registry's own cross-check agrees, and the router summary (which for
    // the pinned miner mirrors the committed answer) must not disagree.
    expect(c.disagreements).toEqual([]);
  }, 240_000);
});
