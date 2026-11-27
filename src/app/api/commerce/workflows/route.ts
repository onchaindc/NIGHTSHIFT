import { NextRequest, NextResponse } from "next/server";

import { userAddressFromRequest } from "@/lib/api/auth";
import { addWorkflowStep, cancelWorkflow, createWorkflow, runWorkflowStep, syncWorkflowSteps } from "@/lib/commerce/fulfill";
import { listWorkflows } from "@/lib/commerce/store";
import type { CommerceWorkflow } from "@/lib/commerce/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionAddress(req: NextRequest): string | null {
  const address = userAddressFromRequest(req);
  return address && address.startsWith("0x") ? address.toLowerCase() : null;
}

function publicWorkflow(wf: CommerceWorkflow, caller: string | null) {
  return { ...wf, ownerIsCaller: caller !== null && wf.ownerWallet === caller };
}

/**
 * GET /api/commerce/workflows — the caller's own workflows (wallet session),
 * synced against reality first: completed free pre-flights are absorbed into
 * their desk files, the desk's free report is built, and steps pick up the
 * report's verdict. Nothing here spends or approves anything.
 *
 * POST — action-based, wallet session required:
 *   { action: "create", title, goal, template, steps? }
 *   { action: "runStep", id, stepId }   — desk steps open a REAL desk file and
 *                                          start its FREE pre-flight (no spend)
 *   { action: "addStep", id, label, deskType? | serviceId? }
 *   { action: "cancel", id }
 */
export async function GET(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to see your workflows" }, { status: 401 });
  }
  const mine = (await listWorkflows()).filter((wf) => wf.ownerWallet === address);
  let touched = false;
  for (const wf of mine) {
    const { changed } = await syncWorkflowSteps(wf);
    touched = touched || changed;
  }
  return NextResponse.json({ workflows: mine.map((wf) => publicWorkflow(wf, address)), synced: touched, total: mine.length });
}

export async function POST(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to run a workflow" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const action = body.action;

  if (action === "create") {
    const result = await createWorkflow({ ownerWallet: address, title: body.title, goal: body.goal, template: body.template, steps: body.steps });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ workflow: publicWorkflow(result.value, address) }, { status: 201 });
  }

  if (action === "runStep") {
    const result = await runWorkflowStep({ id: body.id, stepId: body.stepId, ownerWallet: address });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ workflow: publicWorkflow(result.value, address) });
  }

  if (action === "addStep") {
    const result = await addWorkflowStep({ id: body.id, ownerWallet: address, label: body.label, deskType: body.deskType, serviceId: body.serviceId });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ workflow: publicWorkflow(result.value, address) });
  }

  if (action === "cancel") {
    const result = await cancelWorkflow(body.id, address);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ workflow: publicWorkflow(result.value, address) });
  }

  return NextResponse.json({ error: 'action must be "create", "runStep", "addStep" or "cancel"' }, { status: 400 });
}
