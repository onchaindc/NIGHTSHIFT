import { NextRequest, NextResponse } from "next/server";

import { userAddressFromRequest } from "@/lib/api/auth";
import {
  buildBuyerJobView,
  getBuyerJob,
  listBuyerJobs,
  registerBuyerJob,
  updateBuyerJob,
} from "@/lib/acp/buyer";
import { acpConfig } from "@/lib/acp/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionAddress(req: NextRequest): string | null {
  const address = userAddressFromRequest(req);
  return address && address.startsWith("0x") ? address.toLowerCase() : null;
}

function providerChainId(): number {
  return acpConfig().chainId || 8453;
}

/**
 * The buyer's own ACP jobs — authenticated by the wallet session cookie (the
 * same verified wallet that signed in with its signature; no operator token,
 * no anonymous access). The provider signer never appears: these routes only
 * persist what the BUYER's browser did with the BUYER's wallet and merge the
 * provider's public lifecycle status for the job they own.
 *
 * GET  — the buyer's job list, each merged: their record + the provider
 *        lifecycle status + the derived phase and next action.
 * POST — { action: "register", chainId, jobId, txHash?, offering, requirement }
 *        after the browser created the on-chain job, or
 *        { action: "update", key, requirementSent?, allowanceTxHash?,
 *          fundedTxHash?, completedTxHash?, note? } after each SDK step.
 *        Both bind to the session wallet: nobody registers under a stranger.
 */
export async function GET(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to see your requests" }, { status: 401 });
  }
  const jobs = await listBuyerJobs(address);
  const views = await Promise.all(jobs.map((j) => buildBuyerJobView(j)));
  return NextResponse.json({ jobs: views, total: views.length, address });
}

export async function POST(req: NextRequest) {
  const address = sessionAddress(req);
  if (!address) {
    return NextResponse.json({ error: "sign in with your wallet to create or update a request" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const action = body.action;

  if (action === "register") {
    const chainId = Number(body.chainId);
    if (chainId !== providerChainId()) {
      return NextResponse.json({ error: `jobs run on chain ${providerChainId()} (Base)` }, { status: 400 });
    }
    const result = await registerBuyerJob({
      clientAddress: address,
      chainId,
      jobId: typeof body.jobId === "string" || typeof body.jobId === "number" ? String(body.jobId) : "",
      offering: typeof body.offering === "string" ? body.offering : "",
      txHash: typeof body.txHash === "string" ? body.txHash : null,
      requirement: (body.requirement as Record<string, unknown>) ?? {},
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ job: result.view });
  }

  if (action === "update") {
    const key = typeof body.key === "string" ? body.key : "";
    if (!/^\d+:\d+$/.test(key)) {
      return NextResponse.json({ error: 'key must be "<chainId>:<jobId>"' }, { status: 400 });
    }
    // The session must already own this key — updateBuyerJob re-checks.
    const owned = await getBuyerJob(key);
    if (!owned || owned.clientAddress !== address) {
      return NextResponse.json({ error: "no such job for this wallet" }, { status: 404 });
    }
    const tx = (v: unknown, name: string): { ok: boolean; value: string | null | undefined; error?: string } => {
      if (v === undefined) return { ok: true, value: undefined };
      if (v === null) return { ok: true, value: null };
      if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) return { ok: true, value: v };
      return { ok: false, value: null, error: `${name} must be a transaction hash or null` };
    };
    const allowance = tx(body.allowanceTxHash, "allowanceTxHash");
    const funded = tx(body.fundedTxHash, "fundedTxHash");
    const completed = tx(body.completedTxHash, "completedTxHash");
    for (const t of [allowance, funded, completed]) {
      if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 });
    }
    const result = await updateBuyerJob({
      clientAddress: address,
      key,
      requirementSent: body.requirementSent === true ? true : undefined,
      allowanceTxHash: allowance.value,
      fundedTxHash: funded.value,
      completedTxHash: completed.value,
      note: typeof body.note === "string" ? body.note.slice(0, 240) : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ job: result.view });
  }

  return NextResponse.json({ error: 'action must be "register" or "update"' }, { status: 400 });
}
