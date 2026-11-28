import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST as postRoute, GET as getRoute } from "@/app/api/hunyuan/decision-assurance/route";
import { runDecisionAssurance, buildDecisionContext } from "@/lib/hunyuan/assurance";
import { HunyuanCredentialsError, setHunyuanTransportForTests } from "@/lib/hunyuan/client";
import { getInvestigation, saveInvestigation } from "@/lib/assurance/store";
import { getDeskInvestigation, saveDeskInvestigation } from "@/lib/desk/store";
import type { Investigation } from "@/lib/assurance/types";
import type { DeskInvestigation } from "@/lib/desk/types";

/**
 * Mission #01 — Enterprise Decision Assurance, exercised against an injected
 * transport (no live Tencent call, no simulated "live" claim): the review is a
 * TEST fixture produced by the injected transport, and the tests assert the
 * real contract — persistence on the analysed record, audit trail, evidence
 * traceability enforcement, rejected-citation handling, credential and
 * evidence guards, and the API auth gate.
 */

const OPERATOR_TOKEN = "test-op-token";
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    HUNYUAN_API_KEY: process.env.HUNYUAN_API_KEY,
    HUNYUAN_MODEL: process.env.HUNYUAN_MODEL,
    NIGHTSHIFT_API_TOKEN: process.env.NIGHTSHIFT_API_TOKEN,
  };
  process.env.HUNYUAN_API_KEY = "test-key";
  process.env.HUNYUAN_RETRY_DELAY_MS = "1";
  process.env.NIGHTSHIFT_API_TOKEN = OPERATOR_TOKEN;
  setHunyuanTransportForTests(null);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setHunyuanTransportForTests(null);
});

const NOW = "2026-11-28T10:00:00.000Z";

function assuranceRecord(id: string, evidenceIds: string[]): Investigation {
  return {
    id,
    reference: `NS-TX-${id.slice(0, 8).toUpperCase()}`,
    createdAt: NOW,
    updatedAt: NOW,
    status: "assessed",
    dataMode: "live",
    owner: null,
    transaction: {
      payerWallet: "0xpayer",
      recipientWallet: "0xrecipient",
      amountUsdc: 25000,
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      jurisdiction: "DE",
      approvedBeneficiary: "Acme GmbH",
      contractRef: "CON-1",
      memo: "supplier settlement",
      documents: [],
      ownershipRequired: true,
    },
    counterparty: { legalName: `Acme GmbH ${id.slice(0, 8)}`, registrationNumber: "HRB 12345" },
    evidence: evidenceIds.map((evidenceId, i) => ({
      id: evidenceId,
      class: "node_verified" as const,
      capability: "counterparty_registry",
      title: "Registry extract",
      detail: "Registry record retrieved through the paid Telegraph answer, payload re-derived against the node signal.",
      facts: { legalName: "Acme GmbH", status: i === 0 ? "active" : "registered", jurisdiction: "DE" },
      source: { kind: "telegraph" as const, ref: `sig-${evidenceId}`, label: "corp registry", observedAt: NOW },
    })),
    findings: [
      {
        id: "f-1",
        code: "REGISTRY_OK",
        severity: "info",
        title: "Registry status active",
        explanation: "Registry extract shows status active.",
        significance: "The counterparty exists and is registered.",
        evidenceIds: [evidenceIds[0]],
        requiresHuman: false,
      },
    ],
    decision: {
      outcome: "HOLD",
      rationale: "Awaiting sanctions screening before settlement.",
      decidedAt: NOW,
      criteria: [{ id: "c-1", label: "Registry status", status: "pass", detail: "active" }],
      openIssues: 1,
      settlementAuthorized: false,
    },
    intelligenceRuns: [],
    settlement: null,
    spendLimitUsdCents: 100,
    operator: { createdBy: "test", tenant: "test" },
    audit: [],
    limitations: [],
  };
}

function validReview(evidenceIds: string[]) {
  return {
    subject: "Acme GmbH",
    headline: "Registry evidence supports identity; the hold stands on missing sanctions coverage.",
    materialFindings: [
      {
        title: "Registry status established",
        severity: "minor",
        basis: "established_fact",
        explanation: "Two registry records agree the entity is active and registered.",
        significance: "Identity is confirmed for this file.",
        evidenceIds: [evidenceIds[0]],
      },
    ],
    establishedFacts: [{ statement: "Acme GmbH is registered in DE", evidenceIds }],
    inferences: [{ statement: "The file is ready for screening", reasoning: "Registry identity is verified; screening is the only open issue.", evidenceIds: [evidenceIds[0]] }],
    unknowns: [{ question: "Is the entity sanctions-listed?", whyMaterial: "A hit would stop the settlement." }],
    conflicts: [],
    missingEvidence: [{ requirement: "Sanctions screening result", whyMaterial: "Required by the decision criteria.", suggestedCapability: "sanctions_screening" }],
    risks: [{ title: "Unscreened counterparty", detail: "No screening evidence on file.", severity: "material" }],
    confidence: { level: "medium", basis: "Registry records are node-verified; no screening evidence exists." },
    conclusions: [{ statement: "Keep the hold until screening completes", actionable: true, evidenceIds: [] }],
    recommendedVerification: [{ step: "Run sanctions screening", capability: "sanctions_screening", tracesTo: "unknown: sanctions status" }],
    limitations: ["No paid intelligence has been executed on this file."],
  };
}

function providerBody(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
    model: "hy4-flash",
  };
}

function transportReturning(review: unknown) {
  return async () => new Response(JSON.stringify(providerBody(JSON.stringify(review))), { status: 200, headers: { "Content-Type": "application/json" } });
}

function authedReq(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe("decision assurance workflow", () => {
  it("persists the review on the investigation record with an audit entry and traceable citations", async () => {
    const inv = assuranceRecord("da-persist-0001", ["ev-reg-1", "ev-reg-2"]);
    await saveInvestigation(inv);
    setHunyuanTransportForTests(transportReturning(validReview(["ev-reg-1", "ev-reg-2"])));

    const result = await runDecisionAssurance("assurance", inv.id);
    expect(result.record.review.headline).toContain("hold");
    expect(result.record.model).toBe("hy4-flash");
    expect(result.record.usage?.totalTokens).toBe(700);
    expect(result.record.provider).toBe("tencent-hunyuan");
    expect(result.citationsAccepted).toBeGreaterThan(0);
    expect(result.citationsRejected).toBe(0);

    const stored = await getInvestigation(inv.id);
    expect(stored?.hunyuanAssurance?.review.materialFindings).toHaveLength(1);
    expect(stored?.audit.some((a) => a.actor === "hunyuan" && a.action === "decision_assurance")).toBe(true);
  });

  it("strips invented citations and records them as rejected claims instead of findings", async () => {
    const inv = assuranceRecord("da-reject-0002", ["ev-reg-1", "ev-reg-2"]);
    await saveInvestigation(inv);
    const fabricated = validReview(["ev-reg-1", "ev-reg-2"]);
    fabricated.materialFindings[0].evidenceIds = ["ev-invented-xyz"];
    fabricated.establishedFacts[0].evidenceIds = ["ev-invented-xyz"];
    setHunyuanTransportForTests(transportReturning(fabricated));

    const result = await runDecisionAssurance("assurance", inv.id);
    expect(result.citationsRejected).toBeGreaterThan(0);
    expect(result.record.rejectedClaims.length).toBeGreaterThan(0);
    // The unresolvable finding was removed entirely; the surviving facts cite only real ids.
    expect(result.record.review.materialFindings).toHaveLength(0);
    expect(result.record.review.establishedFacts).toHaveLength(0);
    const stored = await getInvestigation(inv.id);
    expect(stored?.hunyuanAssurance?.review.limitations.some((l) => l.includes("removed"))).toBe(true);
  });

  it("refuses to produce a review from a record with no evidence, without calling the provider", async () => {
    let called = false;
    setHunyuanTransportForTests(async () => {
      called = true;
      return transportReturning(validReview([]))();
    });
    const inv = assuranceRecord("da-empty-0003", []);
    await saveInvestigation(inv);
    await expect(runDecisionAssurance("assurance", inv.id)).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
    const stored = await getInvestigation(inv.id);
    expect(stored?.hunyuanAssurance ?? null).toBeNull();
  });

  it("errors with HunyuanCredentialsError when the key is missing and writes nothing", async () => {
    delete process.env.HUNYUAN_API_KEY;
    let called = false;
    setHunyuanTransportForTests(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    const inv = assuranceRecord("da-creds-0004", ["ev-reg-1"]);
    await saveInvestigation(inv);
    await expect(runDecisionAssurance("assurance", inv.id)).rejects.toBeInstanceOf(HunyuanCredentialsError);
    expect(called).toBe(false);
    const stored = await getInvestigation(inv.id);
    expect(stored?.hunyuanAssurance ?? null).toBeNull();
  });

  it("404s on an unknown record id", async () => {
    await expect(runDecisionAssurance("assurance", "does-not-exist")).rejects.toMatchObject({ status: 404 });
  });

  it("builds a bounded context digest (40 evidence records maximum)", async () => {
    const inv = assuranceRecord("da-bound-0005", Array.from({ length: 45 }, (_, i) => `ev-bulk-${i}`));
    await saveInvestigation(inv);
    const ctx = await buildDecisionContext("assurance", inv.id);
    expect(ctx.evidence).toHaveLength(40);
    expect(ctx.evidence.every((e) => e.id.startsWith("ev-bulk-"))).toBe(true);
  });

  it("persists the review on a desk investigation with its discrepancies as context", async () => {
    const desk: DeskInvestigation = {
      id: "da-desk-0006",
      reference: "NS-CP-DESKTEST1",
      kind: "desk",
      type: "counterparty_due_diligence",
      createdAt: NOW,
      updatedAt: NOW,
      status: "reported",
      dataMode: "live",
      owner: null,
      subject: { legalName: "Globex Ltd desk-dadesk0006", jurisdiction: "UK" },
      unsupported: [],
      evidence: [
        {
          id: "ev-desk-1",
          provenance: "verified",
          class: "node_verified",
          capability: "counterparty-intelligence:registry",
          label: "Registry",
          title: "Registry record",
          detail: "Committed registry answer, hash re-derived.",
          facts: { status: "active" },
          source: { kind: "telegraph", ref: "sig-desk-1", label: "registry", observedAt: NOW },
        },
      ],
      findings: [],
      report: {
        preparedAt: NOW,
        type: "counterparty_due_diligence",
        mode: "free",
        headline: "Registry verified; screening missing.",
        assessment: {
          verdict: "hold_pending_review",
          summary: "Registry identity verified; sanctions screening missing.",
          basis: ["Registry record ev-desk-1"],
          nextActions: [],
        },
        findings: [],
        discrepancies: [{ id: "disc-1", kind: "missing_fields", title: "Missing screening", detail: "No screening dimension.", evidenceIds: [], material: false }],
        sections: [],
        limitations: [],
        outstandingQuestions: ["Screening status?"],
        counts: { verified: 1, verification_failed: 0, unverified: 0, node_asserted: 0, missing: 0, analysis: 0 },
        confidence: "partially_verified",
      },
      runs: [],
      spendLimitUsdCents: 100,
      operator: { createdBy: "test", tenant: "test" },
      audit: [],
    };
    await saveDeskInvestigation(desk);
    setHunyuanTransportForTests(transportReturning({ ...validReview(["ev-desk-1"]), subject: "Globex Ltd" }));

    const result = await runDecisionAssurance("desk", desk.id);
    expect(result.record.scope).toBe("desk");
    const stored = await getDeskInvestigation(desk.id);
    expect(stored?.hunyuanAssurance?.review.subject).toBe("Globex Ltd");
    expect(stored?.audit.some((a) => a.action === "decision_assurance")).toBe(true);
  });
});

describe("decision assurance API gate", () => {
  it("refuses an anonymous caller", async () => {
    const req = new NextRequest("http://localhost/api/hunyuan/decision-assurance", { method: "POST", body: JSON.stringify({ scope: "assurance", id: "x" }), headers: { "Content-Type": "application/json" } });
    const res = await postRoute(req);
    expect(res.status).toBe(401);
  });

  it("refuses an anonymous GET: a persisted private review is never retrievable without the operator credential", async () => {
    // Persist a real review first, so the 401 is proven against a record that
    // actually exists and carries one — not against an empty record.
    const inv = assuranceRecord("da-get-0008", ["ev-reg-1"]);
    await saveInvestigation(inv);
    setHunyuanTransportForTests(transportReturning(validReview(["ev-reg-1"])));
    const runRes = await postRoute(authedReq("/api/hunyuan/decision-assurance", { method: "POST", body: { scope: "assurance", id: inv.id } }));
    expect(runRes.status).toBe(200);
    const persisted = await getInvestigation(inv.id);
    expect(persisted?.hunyuanAssurance).toBeTruthy();

    const anonRes = await getRoute(new NextRequest(`http://localhost/api/hunyuan/decision-assurance?scope=assurance&id=${inv.id}`));
    expect(anonRes.status).toBe(401);
    const anonBody = JSON.stringify((await anonRes.json()) as unknown);
    // The response body must not leak any review content either.
    expect(anonBody).not.toContain("headline");
    expect(anonBody).not.toContain("materialFindings");
    expect(anonBody).not.toContain(validReview(["ev-reg-1"]).headline);

    // And the persisted review is still there for the operator afterwards.
    const opRes = await getRoute(authedReq(`/api/hunyuan/decision-assurance?scope=assurance&id=${inv.id}`));
    expect(opRes.status).toBe(200);
    const opBody = (await opRes.json()) as { exists: boolean };
    expect(opBody.exists).toBe(true);
  });

  it("anonymous GET fails closed even without scope/id params (existence probing)", async () => {
    const anonRes = await getRoute(new NextRequest("http://localhost/api/hunyuan/decision-assurance"));
    expect(anonRes.status).toBe(401);
  });

  it("serves the persisted review to the operator and maps 400/404 honestly", async () => {
    const inv = assuranceRecord("da-route-0007", ["ev-reg-1"]);
    await saveInvestigation(inv);
    setHunyuanTransportForTests(transportReturning(validReview(["ev-reg-1"])));

    const runRes = await postRoute(authedReq("/api/hunyuan/decision-assurance", { method: "POST", body: { scope: "assurance", id: inv.id } }));
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { review: { model: string } };
    expect(runBody.review.model).toBe("hy4-flash");

    const getRes = await getRoute(authedReq(`/api/hunyuan/decision-assurance?scope=assurance&id=${inv.id}`));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { exists: boolean };
    expect(getBody.exists).toBe(true);

    const badScope = await postRoute(authedReq("/api/hunyuan/decision-assurance", { method: "POST", body: { scope: "nope", id: "x" } }));
    expect(badScope.status).toBe(400);
    const missing = await postRoute(authedReq("/api/hunyuan/decision-assurance", { method: "POST", body: { scope: "assurance", id: "does-not-exist" } }));
    expect(missing.status).toBe(404);
  });
});
