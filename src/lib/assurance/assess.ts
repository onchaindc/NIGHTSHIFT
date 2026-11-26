/**
 * Deterministic assessment and authorization decision.
 *
 * Every finding cites evidence records that actually exist on the
 * investigation. Nothing here reasons from a model's opinion: a name
 * comparison, a registry status, a sanctions flag or a balance is read from a
 * recorded fact, and a check with no evidence is reported MISSING rather than
 * assumed to pass.
 *
 * Decision semantics:
 *   ESCALATE — at least one critical finding (sanctions hit, inactive entity,
 *              wrong asset, invalid wallet, insufficient funds, forged document).
 *   HOLD     — a material discrepancy, or a required check with no evidence.
 *   CLEARED  — every required check passed on live, source- or node-verified
 *              evidence. Demonstration data can never be CLEARED.
 */

import type {
  AssuranceEvidence,
  Decision,
  DecisionOutcome,
  Finding,
  Investigation,
} from "./types";
import { USDC_MINT_MAINNET } from "./types";

export interface AssessmentResult {
  findings: Finding[];
  decision: Decision;
  limitations: string[];
}

const SUFFIXES = new Set(["ltd", "limited", "llc", "inc", "incorporated", "plc", "gmbh", "ag", "sa", "bv", "nv", "as", "oy", "ab"]);

/** Comparison form: case/punctuation-insensitive, every word retained. */
export function comparisonTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Legal-form suffixes are kept for identity comparison: "Northstar Capital
 * Holdings Ltd" and "Northstar Capital Holdings (BVI) Limited" are NOT the same
 * registered entity just because they share a trading name.
 */
export function nameAgreement(a: string, b: string): { exact: boolean; jaccard: number; differing: string[] } {
  const ta = comparisonTokens(a);
  const tb = comparisonTokens(b);
  if (ta.length === 0 || tb.length === 0) return { exact: false, jaccard: 0, differing: [] };
  if (ta.join(" ") === tb.join(" ")) return { exact: true, jaccard: 1, differing: [] };
  const setA = new Set(ta);
  const setB = new Set(tb);
  const intersection = [...setA].filter((t) => setB.has(t));
  const union = new Set([...setA, ...setB]);
  return {
    exact: false,
    jaccard: intersection.length / union.size,
    differing: [...union].filter((t) => !setA.has(t) || !setB.has(t)),
  };
}

function money(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

function factsFor(inv: Investigation, capability: string): AssuranceEvidence[] {
  return inv.evidence.filter((e) => e.capability === capability);
}

function mergedFacts(records: AssuranceEvidence[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const record of records) {
    for (const [k, v] of Object.entries(record.facts)) {
      if (out[k] === undefined && v !== null && v !== "") out[k] = v;
    }
  }
  return out;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "active", "matched", "match", "clear", "authentic", "genuine", "valid"].includes(s)) return true;
    if (["false", "no", "inactive", "dissolved", "struck off", "not matched", "no match", "forged", "fake", "invalid"].includes(s)) return false;
  }
  return null;
}

function text(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

let counter = 0;
function finding(input: Omit<Finding, "id">): Finding {
  counter += 1;
  return { id: `f-${counter}-${input.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, ...input };
}

/** Map the observed Solana reads into the facts the rules need. */
function solanaFacts(inv: Investigation): {
  payer: Record<string, unknown> | null;
  recipient: Record<string, unknown> | null;
  mint: Record<string, unknown> | null;
  evidenceIds: Record<string, string[]>;
} {
  const payerRecords = [...factsFor(inv, "solana_wallet_payer"), ...factsFor(inv, "solana_wallet")];
  const recipientRecords = [...factsFor(inv, "solana_wallet_recipient"), ...factsFor(inv, "solana_wallet")];
  const uniqueRecipient = recipientRecords.filter((r) => {
    const address = text(r.facts.address);
    return address ? address === inv.transaction.recipientWallet : false;
  });
  const uniquePayer = payerRecords.filter((r) => {
    const address = text(r.facts.address);
    return address ? address === inv.transaction.payerWallet : false;
  });
  const mintRecords = factsFor(inv, "solana_mint");
  const mint = mintRecords.length ? mergedFacts(mintRecords) : null;
  const payer = uniquePayer.length ? mergedFacts(uniquePayer) : null;
  const recipient = uniqueRecipient.length ? mergedFacts(uniqueRecipient) : null;
  return {
    payer,
    recipient,
    mint,
    evidenceIds: {
      payer: uniquePayer.map((e) => e.id),
      recipient: uniqueRecipient.map((e) => e.id),
      mint: mintRecords.map((e) => e.id),
    },
  };
}

export function assessInvestigation(inv: Investigation): AssessmentResult {
  const findings: Finding[] = [];
  const limitations: string[] = [];
  const criteria: Decision["criteria"] = [];
  const amount = inv.transaction.amountUsdc;
  const registry = mergedFacts(factsFor(inv, "counterparty_registry"));
  const sanctions = mergedFacts(factsFor(inv, "sanctions_screening"));
  const enrichment = mergedFacts(factsFor(inv, "firmographic_enrichment"));
  const documents = mergedFacts(factsFor(inv, "document_authenticity"));
  const solana = solanaFacts(inv);

  /* ---------------------------------------------------------------- */
  /* 1. Solana wallet state                                            */
  /* ---------------------------------------------------------------- */

  const payerValid = bool(solana.payer?.valid);
  const recipientValid = bool(solana.recipient?.valid);
  criteria.push({
    id: "payer_wallet",
    label: "Payer wallet is a valid Solana address",
    status: payerValid === null ? "missing" : payerValid ? "pass" : "fail",
    detail:
      payerValid === null
        ? "No live Solana read of the payer wallet is recorded."
        : payerValid
          ? `Valid 32-byte address; ${String(solana.payer?.lamports ?? "?")} lamports read on ${String(solana.payer?.cluster ?? "the cluster")}.`
          : "The payer wallet is not a valid Solana address.",
  });
  if (payerValid === false) {
    findings.push(
      finding({
        code: "PAYER_WALLET_INVALID",
        severity: "critical",
        title: "Payer wallet is not a valid Solana address",
        explanation: "The address entered for the payer cannot hold or send SPL tokens.",
        significance: "A settlement cannot be authorized from an unusable source wallet.",
        evidenceIds: solana.evidenceIds.payer,
        requiresHuman: true,
      }),
    );
  }

  criteria.push({
    id: "recipient_wallet",
    label: "Recipient wallet has on-chain presence",
    status: recipientValid === null ? "missing" : recipientValid ? "pass" : "fail",
    detail:
      recipientValid === null
        ? "No live Solana read of the recipient wallet is recorded."
        : recipientValid
          ? `${String(solana.recipient?.signatureCount ?? 0)} recent signature(s); token account ${bool(solana.recipient?.mintAccountExists) ? "exists" : "not found"} for the settlement mint.`
          : "The recipient wallet is not a valid Solana address.",
  });
  if (recipientValid === false) {
    findings.push(
      finding({
        code: "RECIPIENT_WALLET_INVALID",
        severity: "critical",
        title: "Recipient wallet is not a valid Solana address",
        explanation: "Funds sent to this address would be unrecoverable.",
        significance: "The beneficiary cannot be paid until a valid destination is supplied and re-inspected.",
        evidenceIds: solana.evidenceIds.recipient,
        requiresHuman: true,
      }),
    );
  } else if (bool(solana.recipient?.mintAccountExists) === false || bool(solana.recipient?.exists) === false) {
    findings.push(
      finding({
        code: "RECIPIENT_WALLET_UNVERIFIED",
        severity: "material",
        title: "Recipient wallet has no verified on-chain presence",
        explanation:
          "The live read found no token account for the settlement mint and no recent signatures for the recipient wallet.",
        significance: "A new or empty destination is a legitimate pattern, but it cannot be confirmed as the counterparty's operating wallet without independent evidence.",
        evidenceIds: solana.evidenceIds.recipient,
        requiresHuman: true,
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 2. Funding and asset restrictions                                 */
  /* ---------------------------------------------------------------- */

  const payerUi = num(solana.payer?.mintUiAmount);
  criteria.push({
    id: "funding",
    label: "Payer holds the full transfer amount",
    status: payerUi === null ? "missing" : payerUi + 1e-9 >= amount ? "pass" : "fail",
    detail:
      payerUi === null
        ? "No live token balance for the settlement mint is recorded."
        : `Live token balance ${payerUi.toLocaleString("en-US")} against a transfer of ${amount.toLocaleString("en-US")}.`,
  });
  if (payerUi !== null && payerUi + 1e-9 < amount) {
    findings.push(
      finding({
        code: "INSUFFICIENT_SETTLED_BALANCE",
        severity: "critical",
        title: "Payer cannot cover the transfer",
        explanation: `The payer's live token balance is ${payerUi.toLocaleString("en-US")} against ${money(amount)}.`,
        significance: "The transaction would fail or be partially funded; no authorization should be issued on it.",
        evidenceIds: solana.evidenceIds.payer,
        requiresHuman: true,
      }),
    );
  }

  const mintAddress = text(solana.mint?.address) ?? inv.transaction.tokenMint;
  const freezeAuthority = text(solana.mint?.freezeAuthority);
  const mintInitialized = bool(solana.mint?.isInitialized);
  criteria.push({
    id: "asset",
    label: "Settlement asset reviewed",
    status: solana.mint ? "pass" : "missing",
    detail: solana.mint
      ? `Mint ${mintAddress}, ${String(solana.mint.decimals ?? "?")} decimals, freeze authority ${freezeAuthority ?? "none"}, initialized ${String(mintInitialized)}.`
      : "No live SPL mint read is recorded.",
  });
  if (inv.transaction.tokenMint !== USDC_MINT_MAINNET) {
    findings.push(
      finding({
        code: "ASSET_NOT_USDC",
        severity: "minor",
        title: "Settlement asset is not the canonical USDC mint",
        explanation: `The transfer mints ${inv.transaction.tokenMint}, not ${USDC_MINT_MAINNET}.`,
        significance: "Confirm the asset is the intended settlement token before authorizing.",
        evidenceIds: solana.evidenceIds.mint,
        requiresHuman: false,
      }),
    );
  }
  if (freezeAuthority) {
    findings.push(
      finding({
        code: "ASSET_FREEZE_AUTHORITY",
        severity: "minor",
        title: "The token mint retains a freeze authority",
        explanation: `An issuer key (${freezeAuthority}) can freeze token accounts for this mint.`,
        significance: "Settlement is reversible at the issuer's discretion; this belongs in the counterparty's risk file.",
        evidenceIds: solana.evidenceIds.mint,
        requiresHuman: false,
      }),
    );
  }
  if (mintInitialized === false) {
    findings.push(
      finding({
        code: "MINT_NOT_INITIALIZED",
        severity: "critical",
        title: "Settlement mint is not initialized",
        explanation: "The mint account exists but reports as uninitialized.",
        significance: "Transfers of this asset cannot settle.",
        evidenceIds: solana.evidenceIds.mint,
        requiresHuman: true,
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 3. Counterparty identity vs the approved beneficiary              */
  /* ---------------------------------------------------------------- */

  const registeredName = text(registry.legal_name);
  const registryEvidence = factsFor(inv, "counterparty_registry").map((e) => e.id);
  const approved = inv.transaction.approvedBeneficiary;
  const comparedName = registeredName ?? text(enrichment.company);
  const comparedEvidence = registeredName
    ? registryEvidence
    : factsFor(inv, "firmographic_enrichment").map((e) => e.id);

  let identityStatus: "pass" | "fail" | "missing" = "missing";
  let identityDetail = "No registry or enrichment record of the counterparty is evidenced.";
  if (comparedName) {
    const agreement = nameAgreement(approved, comparedName);
    identityStatus = agreement.exact ? "pass" : "fail";
    identityDetail = agreement.exact
      ? `The approved beneficiary and the evidenced legal name agree exactly ("${comparedName}").`
      : `Approved "${approved}" vs evidenced "${comparedName}" (${Math.round(agreement.jaccard * 100)}% name-token overlap; differing tokens: ${agreement.differing.join(", ") || "none"}).`;
    if (!agreement.exact) {
      findings.push(
        finding({
          code: "BENEFICIARY_NAME_MISMATCH",
          severity: agreement.jaccard >= 0.75 ? "minor" : "material",
          title: "Approved beneficiary differs from the evidenced legal name",
          explanation: identityDetail,
          significance:
            "Payment approval names a specific legal entity. A different registered name means the funds could reach an entity the approver did not authorize.",
          evidenceIds: comparedEvidence,
          requiresHuman: true,
        }),
      );
    }
  } else {
    findings.push(
      finding({
        code: "MISSING_REGISTRY_EVIDENCE",
        severity: "material",
        title: "No independent registry identity for the counterparty",
        explanation: "Neither a paid registry record nor an enrichment record is evidenced on this file.",
        significance: "The approved beneficiary cannot be matched to a registered entity, so ownership of the payee is unproven.",
        evidenceIds: [],
        requiresHuman: true,
      }),
    );
  }
  criteria.push({ id: "identity", label: "Registry identity matches the approved beneficiary", status: identityStatus, detail: identityDetail });

  const requestedRegistration = inv.counterparty.registrationNumber?.trim() ?? "";
  const evidencedRegistration = text(registry.registration_id) ?? text(registry.lei) ?? "";
  if (requestedRegistration && evidencedRegistration) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm(requestedRegistration) !== norm(evidencedRegistration)) {
      findings.push(
        finding({
          code: "REGISTRATION_ID_MISMATCH",
          severity: "material",
          title: "Registration identifier does not match the register",
          explanation: `The file records ${requestedRegistration}; the evidenced registry identifier is ${evidencedRegistration}.`,
          significance:
            "A different registration identifier is a different legal person, even where the trading name is similar. Ownership of the payee is not established.",
          evidenceIds: registryEvidence,
          requiresHuman: true,
        }),
      );
    }
  }

  const active = bool(registry.active);
  criteria.push({
    id: "registry_status",
    label: "Counterparty is active in the register",
    status: active === null ? (registeredName ? "missing" : "missing") : active ? "pass" : "fail",
    detail:
      active === null
        ? registeredName
          ? "The registry record does not state an active status."
          : "No registry status is evidenced."
        : active
          ? "The register reports the entity as active."
          : "The register reports the entity as inactive or struck off.",
  });
  if (active === false) {
    findings.push(
      finding({
        code: "COUNTERPARTY_INACTIVE",
        severity: "critical",
        title: "Counterparty is not active in the register",
        explanation: text(registry.registration_id)
          ? `Registry ${String(registry.registration_id)} reports the entity as inactive.`
          : "The evidenced registry record reports the entity as inactive.",
        significance: "Paying an inactive entity may transfer value to a party without capacity to receive or account for it.",
        evidenceIds: registryEvidence,
        requiresHuman: true,
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 4. Sanctions                                                      */
  /* ---------------------------------------------------------------- */

  const sanctionRecords = factsFor(inv, "sanctions_screening");
  const matched = bool(sanctions.matched);
  criteria.push({
    id: "sanctions",
    label: "Sanctions screening is clear",
    status: sanctionRecords.length === 0 ? "missing" : matched === false ? "pass" : "fail",
    detail:
      sanctionRecords.length === 0
        ? "No sanctions screen is evidenced on this file."
        : matched === false
          ? `No match reported${text(sanctions.match_score) ? ` (best score ${String(sanctions.match_score)})` : ""}; lists checked: ${String(sanctions.lists ?? "not stated")}.`
          : `A match is reported${text(sanctions.match_score) ? ` (score ${String(sanctions.match_score)})` : ""}.`,
  });
  if (sanctionRecords.length === 0) {
    findings.push(
      finding({
        code: "MISSING_SANCTIONS_SCREENING",
        severity: "material",
        title: "No sanctions screen on file",
        explanation: "A transfer of this size cannot be cleared without a recorded sanctions screen of the counterparty name.",
        significance: "Sanctions exposure is a legal gate, not a preference; the absence of a screen is an open control failure.",
        evidenceIds: [],
        requiresHuman: true,
      }),
    );
  } else if (matched === true) {
    findings.push(
      finding({
        code: "SANCTIONS_MATCH",
        severity: "critical",
        title: "Sanctions screening returned a match",
        explanation: `The screen reports a match${text(sanctions.match_score) ? ` at score ${String(sanctions.match_score)}` : ""}${Array.isArray(sanctions.matches) && sanctions.matches.length ? `: ${(sanctions.matches as unknown[]).slice(0, 3).map(String).join("; ")}` : "."}`,
        significance: "Settlement must stop until compliance resolves the hit; no payment workflow may proceed on a matched name.",
        evidenceIds: sanctionRecords.map((e) => e.id),
        requiresHuman: true,
      }),
    );
  } else if (matched === null) {
    findings.push(
      finding({
        code: "SANCTIONS_VERDICT_UNREADABLE",
        severity: "material",
        title: "Sanctions answer carries no readable verdict",
        explanation: "The recorded answer does not state a clear match/no-match result.",
        significance: "An unreadable screen is not a clear screen.",
        evidenceIds: sanctionRecords.map((e) => e.id),
        requiresHuman: true,
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 5. Documents and obligations                                      */
  /* ---------------------------------------------------------------- */

  const documentRecords = factsFor(inv, "document_authenticity");
  if (inv.transaction.documents.length > 0) {
    const authentic = bool(documents.authentic);
    const verdict = text(documents.verdict);
    const forged = verdict ? /forged|fake|counterfeit|invalid/i.test(verdict) : false;
    criteria.push({
      id: "documents",
      label: "Supporting documents are authentic",
      status: documentRecords.length === 0 ? "missing" : authentic === false || forged ? "fail" : "pass",
      detail:
        documentRecords.length === 0
          ? `${inv.transaction.documents.length} document(s) are attached but no integrity check is evidenced.`
          : `Verdict: ${verdict ?? (authentic ? "authentic" : "not authentic")}.`,
    });
    if (documentRecords.length === 0) {
      findings.push(
        finding({
          code: "MISSING_DOCUMENT_AUTHENTICITY",
          severity: "material",
          title: "Attached documents have not been checked for integrity",
          explanation: `${inv.transaction.documents.length} document(s) support this transaction, but no authenticity result is recorded.`,
          significance: "Contract terms and payment instructions are being relied on without an integrity check.",
          evidenceIds: [],
          requiresHuman: true,
        }),
      );
    } else if (authentic === false || forged) {
      findings.push(
        finding({
          code: "DOCUMENT_INTEGRITY_FAILED",
          severity: "critical",
          title: "A supporting document failed its integrity check",
          explanation: `The authenticity provider returned "${verdict ?? "not authentic"}".`,
          significance: "Payment conditions rest on a document that may have been altered; settlement must stop.",
          evidenceIds: documentRecords.map((e) => e.id),
          requiresHuman: true,
        }),
      );
    }
  } else {
    criteria.push({
      id: "documents",
      label: "Supporting documents",
      status: "pass",
      detail: "No contractual document is attached to this file, so no document check is required.",
    });
  }

  if (inv.transaction.contractRef && factsFor(inv, "contract_obligations").length === 0) {
    limitations.push(
      "A contract reference is recorded but no obligation audit was purchased; the payment conditions have not been compared with the contract's terms.",
    );
  }

  /* ---------------------------------------------------------------- */
  /* 6. Beneficial ownership (an explicit capability gap)              */
  /* ---------------------------------------------------------------- */

  if (inv.transaction.ownershipRequired) {
    const ownership = factsFor(inv, "beneficial_ownership");
    criteria.push({
      id: "ownership",
      label: "Beneficial ownership verified",
      status: ownership.length > 0 ? "pass" : "missing",
      detail:
        ownership.length > 0
          ? "An ownership record is recorded on this file."
          : "No verified beneficial-ownership source exists for this counterparty. The network has no ownership-traversal intent and none was attached by the operator.",
    });
    if (ownership.length === 0) {
      findings.push(
        finding({
          code: "BENEFICIAL_OWNERSHIP_UNVERIFIED",
          severity: "material",
          title: "Beneficial ownership is not verified",
          explanation:
            "The final controllers of the counterparty are not established by any evidence on this file. Registry identity resolves the entity, not who owns it.",
          significance:
            "A payment can be authorized to the wrong controller behind a correctly named entity; without ownership evidence this file cannot be cleared.",
          evidenceIds: registryEvidence,
          requiresHuman: true,
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* 7. Provenance                                                     */
  /* ---------------------------------------------------------------- */

  const liveEvidence = inv.evidence.filter((e) => e.class === "source_verified" || e.class === "node_verified");
  const demoEvidence = inv.evidence.filter((e) => e.class === "demonstration");
  const provenanceOk = inv.dataMode === "live" && liveEvidence.length > 0;
  criteria.push({
    id: "provenance",
    label: "Decision rests on live evidence",
    status: provenanceOk ? "pass" : "fail",
    detail:
      inv.dataMode === "demonstration"
        ? `${demoEvidence.length} demonstration record(s) describe the scenario; no live counterparty evidence exists.`
        : liveEvidence.length > 0
          ? `${liveEvidence.length} live evidence record(s): ${liveEvidence.filter((e) => e.class === "source_verified").length} Solana read(s), ${liveEvidence.filter((e) => e.class === "node_verified").length} node-verified answer(s).`
          : "No live evidence is recorded yet.",
  });
  if (inv.dataMode === "demonstration") {
    limitations.push(
      "This is a demonstration file. Its counterparty records are labelled demonstration data, not live registry or sanctions results, and it can never be cleared.",
    );
  }
  if (demoEvidence.length === 0 && inv.dataMode === "live") {
    limitations.push("All evidence on this file is live: Solana reads and node-verified Telegraph answers only.");
  }

  /* ---------------------------------------------------------------- */
  /* Decision                                                          */
  /* ---------------------------------------------------------------- */

  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasMaterial = findings.some((f) => f.severity === "material");
  const missing = criteria.filter((c) => c.status === "missing");
  const failed = criteria.filter((c) => c.status === "fail");

  let outcome: DecisionOutcome;
  if (hasCritical) outcome = "ESCALATE";
  else if (hasMaterial || missing.length > 0 || failed.length > 0) outcome = "HOLD";
  else if (!provenanceOk) outcome = "HOLD";
  else outcome = "CLEARED";

  const evidenceLine =
    outcome === "CLEARED"
      ? "Every required check passed on live source- or node-verified evidence."
      : outcome === "ESCALATE"
        ? "At least one critical finding requires escalation before any funds move."
        : "The file cannot be cleared while material discrepancies or required evidence remain open.";

  const rationaleParts = [
    evidenceLine,
    `Approved beneficiary: ${approved}.`,
    comparedName ? `Evidenced legal name: ${comparedName}.` : "No independent legal name is evidenced.",
    `${findings.filter((f) => f.requiresHuman).length} issue(s) require a human decision.`,
    missing.length ? `Missing checks: ${missing.map((c) => c.label).join(", ")}.` : "",
    inv.dataMode === "demonstration" ? "Demonstration data: clearance is not available." : "",
  ].filter(Boolean);

  const decision: Decision = {
    outcome,
    rationale: rationaleParts.join(" "),
    decidedAt: new Date().toISOString(),
    criteria,
    openIssues: findings.filter((f) => f.severity === "critical" || f.severity === "material").length,
    settlementAuthorized: outcome === "CLEARED" && inv.dataMode === "live",
  };

  return { findings, decision, limitations };
}
