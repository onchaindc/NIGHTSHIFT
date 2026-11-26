import { describe, expect, it } from "vitest";

import { assessInvestigation, nameAgreement } from "@/lib/assurance/assess";
import { createDemoInvestigation } from "@/lib/assurance/demo";
import { base58Decode, buildTransferBundle, isValidSolanaAddress } from "@/lib/assurance/solana";
import { toBaseUnits } from "@/lib/assurance/settlement";
import type { AssuranceEvidence, Investigation } from "@/lib/assurance/types";
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT_MAINNET } from "@/lib/assurance/types";

function ev(
  id: string,
  capability: string,
  facts: Record<string, string | number | boolean | null>,
  cls: AssuranceEvidence["class"] = "source_verified",
): AssuranceEvidence {
  return {
    id,
    class: cls,
    capability,
    title: capability,
    detail: `${capability} record`,
    facts,
    source: { kind: cls === "node_verified" ? "telegraph" : "solana_rpc", ref: "test", label: "test", observedAt: new Date().toISOString() },
    ...(cls === "node_verified" ? { signalHash: `sig-${id}`, receiptHash: `rcpt-${id}`, minerId: "test-miner" } : {}),
  };
}

function liveInvestigation(): Investigation {
  const demo = createDemoInvestigation("test");
  return {
    ...demo,
    dataMode: "live",
    transaction: {
      ...demo.transaction,
      approvedBeneficiary: "Acme Holdings Limited",
      documents: [],
      ownershipRequired: false,
      amountUsdc: 2_400_000,
    },
    counterparty: { legalName: "Acme Holdings Limited", registrationNumber: "UK-12345678" },
    evidence: [
      ev("payer", "solana_wallet_payer", {
        address: demo.transaction.payerWallet,
        valid: true,
        exists: true,
        mintAccountExists: true,
        mintUiAmount: 5_000_000,
        lamports: 1_000_000_000,
        signatureCount: 4,
      }),
      ev("recipient", "solana_wallet_recipient", {
        address: demo.transaction.recipientWallet,
        valid: true,
        exists: true,
        mintAccountExists: true,
        mintUiAmount: 0,
        lamports: 2_000_000,
        signatureCount: 2,
      }),
      ev("mint", "solana_mint", {
        address: USDC_MINT_MAINNET,
        decimals: 6,
        supply: "1000000000000",
        freezeAuthority: null,
        isInitialized: true,
      }),
      ev(
        "registry",
        "counterparty_registry",
        {
          legal_name: "Acme Holdings Limited",
          registration_id: "UK-12345678",
          active: true,
          jurisdiction: "GB",
        },
        "node_verified",
      ),
      ev("sanctions", "sanctions_screening", { name: "Acme Holdings Limited", matched: false, match_score: 0.02 }, "node_verified"),
    ],
    findings: [],
    decision: null,
    limitations: [],
  };
}

describe("assurance name reconciliation", () => {
  it("treats an exact legal name as agreement", () => {
    expect(nameAgreement("Acme Holdings Limited", "Acme Holdings Limited").exact).toBe(true);
  });

  it("does not collapse a different legal form or jurisdiction qualifier", () => {
    const result = nameAgreement("Northstar Capital Holdings Ltd", "Northstar Capital Holdings (BVI) Limited");
    expect(result.exact).toBe(false);
    expect(result.jaccard).toBeLessThan(0.75);
    expect(result.differing).toContain("bvi");
  });
});

describe("assurance decision", () => {
  it("clears a live file whose required checks all passed", () => {
    const inv = liveInvestigation();
    const result = assessInvestigation(inv);
    expect(result.decision.outcome).toBe("CLEARED");
    expect(result.decision.settlementAuthorized).toBe(true);
    expect(result.findings.filter((f) => f.severity === "critical" || f.severity === "material")).toHaveLength(0);
  });

  it("escalates on a sanctions match", () => {
    const inv = liveInvestigation();
    inv.evidence = inv.evidence.map((e) =>
      e.capability === "sanctions_screening" ? { ...e, facts: { ...e.facts, matched: true, match_score: 0.93 } } : e,
    );
    const result = assessInvestigation(inv);
    expect(result.decision.outcome).toBe("ESCALATE");
    expect(result.decision.settlementAuthorized).toBe(false);
    expect(result.findings.some((f) => f.code === "SANCTIONS_MATCH")).toBe(true);
  });

  it("holds when sanctions screening is missing", () => {
    const inv = liveInvestigation();
    inv.evidence = inv.evidence.filter((e) => e.capability !== "sanctions_screening");
    const result = assessInvestigation(inv);
    expect(result.decision.outcome).toBe("HOLD");
    expect(result.findings.some((f) => f.code === "MISSING_SANCTIONS_SCREENING")).toBe(true);
  });

  it("holds when the payer cannot cover the transfer", () => {
    const inv = liveInvestigation();
    inv.evidence = inv.evidence.map((e) =>
      e.capability === "solana_wallet_payer" ? { ...e, facts: { ...e.facts, mintUiAmount: 10 } } : e,
    );
    const result = assessInvestigation(inv);
    expect(result.decision.outcome).toBe("ESCALATE");
    expect(result.findings.some((f) => f.code === "INSUFFICIENT_SETTLED_BALANCE")).toBe(true);
  });

  it("never clears demonstration data", () => {
    const demo = createDemoInvestigation("test");
    const result = assessInvestigation(demo);
    expect(result.decision.outcome).toBe("HOLD");
    expect(result.decision.settlementAuthorized).toBe(false);
    expect(result.findings.some((f) => f.code === "BENEFICIARY_NAME_MISMATCH")).toBe(true);
    expect(result.findings.some((f) => f.code === "REGISTRATION_ID_MISMATCH")).toBe(true);
    expect(result.findings.some((f) => f.code === "BENEFICIAL_OWNERSHIP_UNVERIFIED")).toBe(true);
  });

  it("requires beneficial ownership when the transfer declares it material", () => {
    const inv = { ...liveInvestigation(), transaction: { ...liveInvestigation().transaction, ownershipRequired: true } };
    const result = assessInvestigation(inv);
    expect(result.decision.outcome).toBe("HOLD");
    expect(result.findings.some((f) => f.code === "BENEFICIAL_OWNERSHIP_UNVERIFIED")).toBe(true);
  });
});

describe("Solana primitives", () => {
  it("round-trips demo addresses through base58", () => {
    const demo = createDemoInvestigation("test");
    expect(isValidSolanaAddress(demo.transaction.payerWallet)).toBe(true);
    expect(isValidSolanaAddress(demo.transaction.recipientWallet)).toBe(true);
    expect(base58Decode(demo.transaction.payerWallet)?.length).toBe(32);
  });

  it("converts USDC decimals exactly", () => {
    expect(toBaseUnits(2_400_000, 6)).toBe(2_400_000_000_000n);
    expect(toBaseUnits(0.01, 6)).toBe(10_000n);
  });

  it("builds real SPL transfer bytes and a memo instruction", () => {
    const bundle = buildTransferBundle({
      sourceTokenAccount: "11111111111111111111111111111111",
      destinationTokenAccount: "11111111111111111111111111111111",
      owner: "11111111111111111111111111111111",
      mint: USDC_MINT_MAINNET,
      amountBaseUnits: 2_400_000_000_000n,
      memo: "NS-TX-TEST",
      recentBlockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
      rpcUrl: "https://example.invalid",
    });
    expect(bundle.instructions[0].programId).toBe(MEMO_PROGRAM_ID);
    expect(bundle.instructions[1].programId).toBe(TOKEN_PROGRAM_ID);
    const transfer = Buffer.from(bundle.instructions[1].data, "base64");
    expect(transfer[0]).toBe(3); // SPL Token Transfer
    expect(transfer.readBigUInt64LE(1)).toBe(2_400_000_000_000n);
    expect(bundle.decimals).toBe(6);
  });
});
