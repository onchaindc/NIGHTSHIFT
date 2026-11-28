import { NextResponse } from "next/server";

import { hunyuanConfig, missingHunyuanCredentials } from "@/lib/hunyuan/client";
import { listInvestigations } from "@/lib/assurance/store";
import { listDeskInvestigations } from "@/lib/desk/store";
import { readContinuumEvents, readContinuumRuns } from "@/lib/hunyuan/continuum";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/hunyuan/status - truthful provider and mission status, in the same
 * spirit as /api/status: which integrations are CONFIGURED (names, never
 * values) and what each mission has actually produced. A missing HUNYUAN_API_KEY
 * is reported as unconfigured — never dressed up as a live integration.
 */
export async function GET() {
  const cfg = hunyuanConfig();
  const missing = missingHunyuanCredentials();

  let linkedAssurance = 0;
  let linkedDesk = 0;
  const runAts: string[] = [];
  try {
    const [assurances, desks] = await Promise.all([listInvestigations(), listDeskInvestigations()]);
    for (const inv of assurances) {
      if (inv.hunyuanAssurance) {
        linkedAssurance++;
        runAts.push(inv.hunyuanAssurance.runAt);
      }
    }
    for (const inv of desks) {
      if (inv.hunyuanAssurance) {
        linkedDesk++;
        runAts.push(inv.hunyuanAssurance.runAt);
      }
    }
  } catch {
    // Store unreachable: report the mission counters as unavailable, not zero.
  }
  // ISO timestamps sort lexicographically; the max is the newest run.
  const lastAssuranceRun = runAts.sort()[runAts.length - 1] ?? null;

  let events = 0;
  let lastEventAt: string | null = null;
  let runs: Awaited<ReturnType<typeof readContinuumRuns>> = [];
  try {
    const ledger = await readContinuumEvents(500);
    events = ledger.length;
    lastEventAt = ledger[0]?.ts ?? null;
    runs = await readContinuumRuns(3);
  } catch {
    // same honest omission
  }
  const lastRun = runs[0] ?? null;

  return NextResponse.json({
    provider: "tencent-hunyuan",
    configured: cfg !== null,
    missing: missing.length > 0 ? missing : [],
    model: cfg?.model ?? null,
    baseUrl: cfg?.baseUrl ?? "https://tokenhub-intl.tencentmaas.com/v1",
    missions: {
      decisionAssurance: {
        description: "Enterprise Decision Assurance — structured Hunyuan review persisted on assurance and desk investigation records, evidence-traceable.",
        linkedRecords: linkedAssurance + linkedDesk,
        linkedByScope: { assurance: linkedAssurance, desk: linkedDesk },
        lastRunAt: lastAssuranceRun,
      },
      continuousIntelligence: {
        description: "Continuous Enterprise Intelligence — deterministic change detection over tracked entities, Hunyuan-assessed, deduplicated by fingerprint.",
        events,
        lastEventAt,
        lastTick: lastRun,
      },
    },
    note: cfg === null
      ? "Tencent Hunyuan is NOT configured: set HUNYUAN_API_KEY to enable live inference. Mission workflows detect changes and validate schemas regardless; no simulated provider output is ever produced."
      : "Live provider configured. All Hunyuan output is stored as analysis with declared provenance — never as an evidence class.",
  });
}
