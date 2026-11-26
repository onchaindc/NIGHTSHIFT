/**
 * Budget standing for the signed-in caller — the data behind the dashboard.
 *
 * Multi-user production: free probes are open to everyone, but paid runs
 * settle from the deployment's payer wallet and are capped per user per
 * rolling 24h (see userSpend.ts). This endpoint makes that allowance VISIBLE:
 * total spent vs cap, and a per-Mind breakdown of where it went.
 *
 * - wallet session: own spend, own cap
 * - operator: aggregate payer-funded spend (uncapped by design — the operator
 *   IS the payer)
 * - anonymous: nothing spent, cap shown so the model is legible before sign-in
 */
import { NextRequest, NextResponse } from "next/server";
import { callerIdentity } from "@/lib/api/auth";
import { userDailySpendCapCents } from "@/lib/api/userSpend";
import { listTasks } from "@/lib/engine/store";
import type { TaskRecord } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mindOfTask(task: TaskRecord): string {
  for (const step of task.plan ?? []) {
    if (/^(capability|mind|index|counterparty)_/.test(step.kind) && typeof step.target === "string" && step.target) {
      return step.target;
    }
  }
  if (task.jobType === "protocol_watch") return "protocol-watch";
  if (task.jobType === "terminal_request") return "terminal";
  return "other";
}

function spendBreakdown(tasks: TaskRecord[], ownerLower: string | null): { spentCents: number; perMind: Array<{ mind: string; spentCents: number }> } {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const perMind = new Map<string, number>();
  let spent = 0;
  for (const task of tasks) {
    if (ownerLower !== null && (task.owner ?? "").toLowerCase() !== ownerLower) continue;
    for (const entry of task.spend?.entries ?? []) {
      if (entry.ts >= cutoff && entry.source === "telegraph") {
        spent += entry.amountUsdCents;
        const mind = mindOfTask(task);
        perMind.set(mind, (perMind.get(mind) ?? 0) + entry.amountUsdCents);
      }
    }
  }
  return { spentCents: spent, perMind: [...perMind].map(([mind, cents]) => ({ mind, spentCents: cents })).sort((a, b) => b.spentCents - a.spentCents) };
}

export async function GET(req: NextRequest) {
  const identity = callerIdentity(req);
  const capCents = userDailySpendCapCents();
  if (identity.kind === "anonymous") {
    return NextResponse.json({ signedIn: false, spentCents: 0, capCents, remainingCents: capCents, perMind: [], windowHours: 24 });
  }
  const tasks = await listTasks();
  if (identity.kind === "operator") {
    const { spentCents, perMind } = spendBreakdown(tasks, null);
    return NextResponse.json({
      signedIn: true,
      operator: true,
      spentCents,
      capCents: null,
      remainingCents: null,
      perMind,
      windowHours: 24,
    });
  }
  const { spentCents, perMind } = spendBreakdown(tasks, identity.address.toLowerCase());
  return NextResponse.json({
    signedIn: true,
    spentCents,
    capCents,
    remainingCents: Math.max(0, capCents - spentCents),
    perMind,
    windowHours: 24,
  });
}
