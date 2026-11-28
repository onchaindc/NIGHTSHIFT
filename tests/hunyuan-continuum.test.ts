import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  collectEntityViews,
  detectChanges,
  fingerprintFor,
  readContinuumEvents,
  readEntityEvents,
  readContinuumRuns,
  runContinuumTick,
} from "@/lib/hunyuan/continuum";
import { setHunyuanTransportForTests } from "@/lib/hunyuan/client";
import { getInvestigation, saveInvestigation } from "@/lib/assurance/store";
import { saveDeskInvestigation } from "@/lib/desk/store";
import type { DeskInvestigation } from "@/lib/desk/types";
import { POST as tickRoute, } from "@/app/api/hunyuan/continuum/tick/route";
import { GET as ledgerRoute } from "@/app/api/hunyuan/continuum/route";
import type { Investigation } from "@/lib/assurance/types";

/**
 * Mission #02 — Continuous Enterprise Intelligence. Detection and dedup are
 * deterministic code, so these tests are exact; the Hunyuan assessment layer
 * is exercised through an injected transport. No live Tencent call and no
 * simulated "live" claim anywhere.
 */

const OPERATOR_TOKEN = "test-op-token";
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    HUNYUAN_API_KEY: process.env.HUNYUAN_API_KEY,
    HUNYUAN_MODEL: process.env.HUNYUAN_MODEL,
    HUNYUAN_RETRY_DELAY_MS: process.env.HUNYUAN_RETRY_DELAY_MS,
    NIGHTSHIFT_API_TOKEN: process.env.NIGHTSHIFT_API_TOKEN,
    NIGHTSHIFT_CONTINUUM_AUTOCHECK: process.env.NIGHTSHIFT_CONTINUUM_AUTOCHECK,
  };
  delete process.env.HUNYUAN_API_KEY;
  process.env.HUNYUAN_RETRY_DELAY_MS = "1";
  process.env.NIGHTSHIFT_API_TOKEN = OPERATOR_TOKEN;
  process.env.NIGHTSHIFT_CONTINUUM_AUTOCHECK = "1";
  setHunyuanTransportForTests(null);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setHunyuanTransportForTests(null);
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 28, 10, 0, 0); // 2026-11-28T10:00Z

let seq = 0;
function nextId(): string {
  return `cont-${(++seq).toString().padStart(4, "0")}`;
}

function continuumInvestigation(entityName: string, evidence: Array<{ id: string; capability: string; facts: Record<string, string>; observedAt: string; klass?: "node_verified" | "probe_verified" }>): Investigation {
  return {
    id: nextId(),
    reference: `NS-TX-${nextId()}`,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    status: "assessed",
    dataMode: "live",
    owner: null,
    transaction: {
      payerWallet: "0xpayer",
      recipientWallet: "0xrecipient",
      amountUsdc: 1000,
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      jurisdiction: "DE",
      approvedBeneficiary: entityName,
      contractRef: "CON-1",
      memo: "continuum test",
      documents: [],
      ownershipRequired: true,
    },
    counterparty: { legalName: entityName },
    evidence: evidence.map((e) => ({
      id: e.id,
      class: e.klass ?? ("node_verified" as const),
      capability: e.capability,
      title: `${e.capability} record`,
      detail: "test record",
      facts: e.facts,
      source: { kind: "telegraph" as const, ref: `sig-${e.id}`, label: "test", observedAt: e.observedAt },
    })),
    findings: [],
    decision: null,
    intelligenceRuns: [],
    settlement: null,
    spendLimitUsdCents: 100,
    operator: { createdBy: "test", tenant: "test" },
    audit: [],
    limitations: [],
  };
}

describe("deterministic detection", () => {
  it("treats first sight as a baseline: no events on the first tick", async () => {
    const name = `Continuum Baseline Co ${nextId()}`;
    const inv = continuumInvestigation(name, [{ id: "ev-a1", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - 2 * DAY).toISOString() }]);
    await saveInvestigation(inv);

    const result = await runContinuumTick({ now: NOW });
    expect(result.baselinesEstablished).toBeGreaterThanOrEqual(1);
    expect(result.newEvents).toBe(0);
    expect(await readEntityEvents(`registry:de:${name.toLowerCase()}`)).toHaveLength(0);
  });

  it("detects new evidence, field changes, contradictions and staleness; dedups repeats", async () => {
    const name = `Continuum Change Co ${nextId()}`;
    const entityKey = `registry:de:${name.toLowerCase()}`;
    const inv = continuumInvestigation(name, [
      { id: "ev-old", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - 40 * DAY).toISOString() },
    ]);
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW }); // baseline

    // Second tick: a NEW registry record with a changed field (strong provenance)
    inv.evidence.push({
      id: "ev-new",
      class: "node_verified",
      capability: "registry",
      title: "registry refresh",
      detail: "updated",
      facts: { status: "dissolved" },
      source: { kind: "telegraph", ref: "sig-ev-new", label: "test", observedAt: new Date(NOW - 1 * DAY).toISOString() },
    });
    await saveInvestigation(inv);

    const result = await runContinuumTick({ now: NOW });
    expect(result.newEvents).toBeGreaterThan(0);

    const events = await readEntityEvents(entityKey);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has("new_evidence")).toBe(true);
    expect(kinds.has("field_change")).toBe(true);
    expect(kinds.has("contradiction")).toBe(true);
    expect(kinds.has("stale_evidence")).toBe(true); // the 40-day-old record was never renewed

    const contradiction = events.find((e) => e.kind === "contradiction");
    expect(contradiction?.evidenceIds.sort()).toEqual(["ev-new", "ev-old"]);
    expect(contradiction?.materiality).toBe("material");
    expect(contradiction?.investigationIds[0].id).toBe(inv.id);

    // Third tick with NO change: everything is deduplicated by fingerprint.
    const repeat = await runContinuumTick({ now: NOW + 60_000 });
    expect(repeat.newEvents).toBe(0);
  });

  it("does not report a contradiction from unverified records", () => {
    const prior = { evidenceSetHash: "", processedEvidence: [{ id: "ev-w1", capability: "registry", facts: { status: "active" }, strong: false, observedAt: new Date(NOW - DAY).toISOString() }], fingerprints: {}, lastDecision: null, lastReportSignature: null };
    const view = {
      key: "k", label: "l", scope: "assurance" as const, investigationId: "i", reference: "r", decision: null, reportSignature: null,
      evidence: [{ id: "ev-w2", capability: "registry", title: "t", facts: { status: "dissolved" }, provenance: "probe_verified", strong: false, observedAt: new Date(NOW).toISOString() }],
    };
    const { candidates } = detectChanges(view, prior, NOW, 30 * DAY);
    expect(candidates.some((c) => c.kind === "field_change")).toBe(true);
    expect(candidates.some((c) => c.kind === "contradiction")).toBe(false);
  });

  it("produces stable fingerprints for identical candidates", async () => {
    const name = `Continuum Fingerprint Co ${nextId()}`;
    const inv = continuumInvestigation(name, [{ id: "ev-fp", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - DAY).toISOString() }]);
    const prior = undefined;
    const view = collectEntityViews([inv], [])[0];
    expect(view).toBeDefined();
    expect(view!.key).toBe(`registry:de:${name.toLowerCase()}`);
    const second = collectEntityViews([inv], [])[0];
    const a = fingerprintFor(view!.key, { kind: "new_evidence", title: "t", detail: "d", evidenceIds: ["ev-fp"], payload: { evidenceId: "ev-fp", capability: "registry", provenance: "node_verified", facts: { status: "active" } }, materiality: "minor" });
    const b = fingerprintFor(second!.key, { kind: "new_evidence", title: "t", detail: "d", evidenceIds: ["ev-fp"], payload: { provenance: "node_verified", facts: { status: "active" }, capability: "registry", evidenceId: "ev-fp" }, materiality: "minor" });
    expect(a).toBe(b); // key order in the payload must not matter
    expect(prior).toBeUndefined();
  });

  it("tracks desk subjects as entities", async () => {
    const subjectName = `Continuum Desk Subject ${nextId()}`;
    await saveDeskInvestigation({
      id: nextId(),
      reference: "NS-CP-CONTTEST",
      kind: "desk",
      type: "counterparty_due_diligence",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      status: "reported",
      dataMode: "live",
      owner: null,
      subject: { legalName: subjectName, jurisdiction: "UK" },
      unsupported: [],
      evidence: [
        {
          id: "ev-desk-c1",
          provenance: "verified",
          class: "node_verified",
          capability: "counterparty-intelligence:registry",
          label: "Registry",
          title: "Registry record",
          detail: "d",
          facts: { status: "active" },
          source: { kind: "telegraph", ref: "sig", label: "registry", observedAt: new Date(NOW - DAY).toISOString() },
        },
      ],
      findings: [],
      report: null,
      runs: [],
      spendLimitUsdCents: 100,
      operator: { createdBy: "test", tenant: "test" },
      audit: [],
    });
    const result = await runContinuumTick({ now: NOW });
    expect(result.baselinesEstablished).toBeGreaterThanOrEqual(1);
    expect(result.scannedEntities).toBeGreaterThan(0);
  });

  it("does not crash when a desk file carries a report without an assessment yet (awaiting_approval shape)", async () => {
    const subjectName = `Continuum Partial Report ${nextId()}`;
    // Runtime shape seen in production: a desk file parked at
    // awaiting_approval can hold a report object whose assessment (and
    // confidence) have not been produced yet, even though the DeskReport
    // type promises them. The tick must treat this as "no signature yet",
    // not crash.
    const partialReport = { generatedAt: new Date(NOW).toISOString() } as unknown as DeskInvestigation["report"];
    await saveDeskInvestigation({
      id: nextId(),
      reference: "NS-CP-CONTTEST",
      kind: "desk",
      type: "counterparty_due_diligence",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      status: "collecting",
      dataMode: "live",
      owner: null,
      subject: { legalName: subjectName, jurisdiction: "UK" },
      unsupported: [],
      evidence: [
        {
          id: "ev-desk-p1",
          provenance: "unverified",
          class: "analysis",
          capability: "counterparty-intelligence:registry",
          label: "Registry",
          title: "Registry probe",
          detail: "free-mode analysis, no purchased signal",
          facts: { status: "active" },
          source: { kind: "telegraph", ref: "sig", label: "registry", observedAt: new Date(NOW - DAY).toISOString() },
        },
      ],
      findings: [],
      report: partialReport,
      runs: [],
      spendLimitUsdCents: 100,
      operator: { createdBy: "test", tenant: "test" },
      audit: [],
    });
    const result = await runContinuumTick({ now: NOW });
    expect(result.scannedEntities).toBeGreaterThan(0);
    // A second pass must be a clean dedup, not a crash or a phantom change.
    const repeat = await runContinuumTick({ now: NOW + 60_000 });
    expect(repeat.newEvents).toBe(0);
  });
});

describe("provider assessment layer", () => {
  it("records deterministic events with providerAssessment null and an explicit limitation when unconfigured", async () => {
    const name = `Continuum Unconfigured Co ${nextId()}`;
    const entityKey = `registry:de:${name.toLowerCase()}`;
    const inv = continuumInvestigation(name, [{ id: "ev-u1", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - 40 * DAY).toISOString() }]);
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW });
    let providerCalls = 0;
    setHunyuanTransportForTests(async () => {
      providerCalls++;
      return new Response("{}", { status: 200 });
    });

    inv.evidence.push({
      id: "ev-u2",
      class: "node_verified",
      capability: "registry",
      title: "refresh",
      detail: "updated",
      facts: { status: "liquidated" },
      source: { kind: "telegraph", ref: "sig-u2", label: "test", observedAt: new Date(NOW - DAY).toISOString() },
    });
    await saveInvestigation(inv);
    const result = await runContinuumTick({ now: NOW });
    expect(result.providerConfigured).toBe(false);
    expect(providerCalls).toBe(0); // never called when unconfigured
    expect(result.newEvents).toBeGreaterThan(0);

    const events = await readEntityEvents(entityKey);
    const changed = events.find((e) => e.kind === "field_change");
    expect(changed?.providerAssessment).toBeNull();
    expect(changed?.limitations.some((l) => l.includes("HUNYUAN_API_KEY"))).toBe(true);
    expect(changed?.materiality).toBe("material"); // deterministic materiality stands
  });

  it("attaches provider assessments and lets them set materiality", async () => {
    process.env.HUNYUAN_API_KEY = "test-key";
    const name = `Continuum Enriched Co ${nextId()}`;
    const entityKey = `registry:de:${name.toLowerCase()}`;
    const inv = continuumInvestigation(name, [{ id: "ev-e1", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - DAY).toISOString() }]);
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW });

    inv.evidence.push({
      id: "ev-e2",
      class: "node_verified",
      capability: "registry",
      title: "refresh",
      detail: "updated",
      facts: { status: "dissolved" },
      source: { kind: "telegraph", ref: "sig-e2", label: "test", observedAt: new Date(NOW).toISOString() },
    });
    await saveInvestigation(inv);

    setHunyuanTransportForTests(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const detected = JSON.parse(body.messages[1].content.split("DETECTED EVENTS:\n")[1]);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assessments: detected.map((d: { eventId: string }) => ({
                    eventId: d.eventId,
                    summary: "Registry status moved from active to dissolved — a material adverse development.",
                    materiality: "minor",
                    recommendedAction: "Re-pull the registry record and confirm with a second source.",
                  })),
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          model: "hy4-flash",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await runContinuumTick({ now: NOW });
    expect(result.providerConfigured).toBe(true);
    expect(result.enriched).toBe(result.newEvents);
    const events = await readEntityEvents(entityKey);
    const assessed = events.filter((e) => e.providerAssessment !== null);
    expect(assessed.length).toBeGreaterThan(0);
    expect(assessed[0].providerAssessment?.model).toBe("hy4-flash");
    expect(assessed[0].materiality).toBe("minor"); // provider override applied
    expect(assessed[0].providerAssessment?.recommendedAction).toContain("registry");
  });

  it("keeps deterministic events and records the failure when the provider fails", async () => {
    process.env.HUNYUAN_API_KEY = "test-key";
    const name = `Continuum Failure Co ${nextId()}`;
    const entityKey = `registry:de:${name.toLowerCase()}`;
    const inv = continuumInvestigation(name, [{ id: "ev-f1", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - DAY).toISOString() }]);
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW });
    setHunyuanTransportForTests(async () => new Response("upstream down", { status: 500 }));

    inv.evidence.push({
      id: "ev-f2",
      class: "node_verified",
      capability: "registry",
      title: "refresh",
      detail: "updated",
      facts: { status: "dissolved" },
      source: { kind: "telegraph", ref: "sig-f2", label: "test", observedAt: new Date(NOW).toISOString() },
    });
    await saveInvestigation(inv);

    const result = await runContinuumTick({ now: NOW });
    expect(result.newEvents).toBeGreaterThan(0); // detection persisted anyway
    expect(result.providerError).toBeTruthy();
    const events = await readEntityEvents(entityKey);
    expect(events.every((e) => e.providerAssessment === null)).toBe(true);
    expect(events.every((e) => e.limitations.some((l) => l.includes("provider assessment unavailable")))).toBe(true);
  });
});

describe("linkage and persistence", () => {
  it("appends a material development to the linked investigation's audit trail", async () => {
    const name = `Continuum Linkage Co ${nextId()}`;
    const inv = continuumInvestigation(name, [{ id: "ev-l1", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - DAY).toISOString() }]);
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW });

    inv.evidence.push({
      id: "ev-l2",
      class: "node_verified",
      capability: "registry",
      title: "refresh",
      detail: "updated",
      facts: { status: "dissolved" },
      source: { kind: "telegraph", ref: "sig-l2", label: "test", observedAt: new Date(NOW).toISOString() },
    });
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW });

    const stored = await getInvestigation(inv.id);
    const auditEntries = stored?.audit.filter((a) => a.action === "continuum_event") ?? [];
    expect(auditEntries.length).toBeGreaterThan(0);
    expect(auditEntries[0].detail).toContain("Material development");
  });

  it("emits a decision_change event when the recorded decision moves", async () => {
    const name = `Continuum Decision Co ${nextId()}`;
    const entityKey = `registry:de:${name.toLowerCase()}`;
    const inv = continuumInvestigation(name, [{ id: "ev-d1", capability: "registry", facts: { status: "active" }, observedAt: new Date(NOW - DAY).toISOString() }]);
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW });

    inv.decision = {
      outcome: "HOLD",
      rationale: "screening pending",
      decidedAt: new Date(NOW).toISOString(),
      criteria: [],
      openIssues: 1,
      settlementAuthorized: false,
    };
    await saveInvestigation(inv);
    await runContinuumTick({ now: NOW });

    const events = await readEntityEvents(entityKey);
    expect(events.some((e) => e.kind === "decision_change" && e.materiality === "material")).toBe(true);
  });

  it("bounds the ledger and keeps run records", async () => {
    const runs = await readContinuumRuns(10);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].trigger).toBeDefined();
    const ledger = await readContinuumEvents(500);
    expect(ledger.length).toBeLessThanOrEqual(500);
  });
});

describe("continuum API gate", () => {
  it("refuses an anonymous tick and an anonymous ledger read", async () => {
    const req = new NextRequest("http://localhost/api/hunyuan/continuum/tick", { method: "POST" });
    expect((await tickRoute(req)).status).toBe(401);
    const read = new NextRequest("http://localhost/api/hunyuan/continuum");
    expect((await ledgerRoute(read)).status).toBe(401);
  });

  it("runs a manual tick for the operator", async () => {
    const req = new NextRequest("http://localhost/api/hunyuan/continuum/tick", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    const res = await tickRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { scannedEntities: number } };
    expect(body.result.scannedEntities).toBeGreaterThan(0);

    const read = new NextRequest("http://localhost/api/hunyuan/continuum", { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
    const ledgerRes = await ledgerRoute(read);
    expect(ledgerRes.status).toBe(200);
    const ledgerBody = (await ledgerRes.json()) as { events: unknown[] };
    expect(Array.isArray(ledgerBody.events)).toBe(true);
  });
});
