import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { callerIdentity } from "@/lib/api/auth";
import { processAcpEntry } from "@/lib/acp/runtime";
import { getAcpJob } from "@/lib/acp/store";
import { acpProviderStatus } from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/acp/simulate — operator-only: inject a SIMULATED buyer job
 * through the real intake pipeline (validation → pricing → investigation →
 * approval gate). This exists because this deployment has no ACP credentials;
 * it is always a mock-transport interaction, labelled as such, and it can
 * never spend: the paid run it creates parks at the human approval gate.
 *
 * Body: { offering: "nightshift/listing-underwriter", subject: { ...inputs } }
 * (legacy shape accepted: the subject fields at the top level).
 */
export async function POST(req: NextRequest) {
  const identity = callerIdentity(req);
  if (identity.kind === "anonymous") {
    return NextResponse.json({ error: "sign in to simulate an ACP buyer" }, { status: 401 });
  }
  const status = await acpProviderStatus();
  if (status.mode === "real") {
    return NextResponse.json({ error: "the live transport is active — simulated buyers are refused to keep mock and real traffic apart" }, { status: 409 });
  }

  let body: { offering?: unknown; subject?: unknown } = {};
  try {
    body = (await req.json()) as { offering?: unknown; subject?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.offering !== "string" || typeof body.subject !== "object" || body.subject === null) {
    return NextResponse.json({ error: 'body must be { offering: string, subject: Record<string, string> }' }, { status: 400 });
  }

  const ref = { chainId: status.chainId, jobId: `sim-${randomUUID().slice(0, 8)}` };
  const requirement = JSON.stringify({
    offering: body.offering,
    inputs: body.subject,
  });

  try {
    await processAcpEntry(ref, { kind: "system", event: { type: "job.created" }, clientAddress: "0xsimulated-buyer" });
    await processAcpEntry(ref, { kind: "message", contentType: "requirement", content: requirement, clientAddress: "0xsimulated-buyer" });
  } catch (err) {
    return NextResponse.json({ error: `intake failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` }, { status: 500 });
  }
  const job = await getAcpJob(`${ref.chainId}:${ref.jobId}`);
  if (!job) return NextResponse.json({ error: "the simulated job was not recorded" }, { status: 500 });
  return NextResponse.json({ simulated: true, job }, { status: 201 });
}
