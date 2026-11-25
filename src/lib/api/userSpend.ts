import { listTasks } from "@/lib/engine/store";
import { defaultSpendLimit } from "@/lib/engine/engine";
import { requestAuthorized, userAddressFromRequest } from "@/lib/api/auth";

/**
 * Per-user daily spend cap for payer-funded paid runs.
 *
 * Multi-user production means MANY wallets can trigger runs that settle from
 * the deployment's paid-research wallet (the server payer). Free runs cost
 * nothing and stay open to everyone; anything that spends is capped per user
 * per rolling 24h so one wallet cannot drain a shared budget. The operator
 * session bypasses the cap: it belongs to whoever funds the payer wallet.
 */

export function userDailySpendCapCents(): number {
  const raw = Number(process.env.NIGHTSHIFT_USER_DAILY_SPEND_CENTS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 200; // $2.00/day per user by default
}

export interface UserSpendStanding {
  spentCents: number;
  capCents: number;
  /** True when a NEW paid run with this ceiling would still fit under the cap. */
  allowsAdditional: (requestedCeilingCents: number) => boolean;
}

export async function userPaidSpend24h(owner: string): Promise<UserSpendStanding> {
  const tasks = await listTasks();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const wanted = owner.toLowerCase();
  let spent = 0;
  for (const task of tasks) {
    if ((task.owner ?? "").toLowerCase() !== wanted) continue;
    for (const entry of task.spend?.entries ?? []) {
      if (entry.ts >= cutoff && entry.source === "telegraph") spent += entry.amountUsdCents;
    }
  }
  const capCents = userDailySpendCapCents();
  return {
    spentCents: spent,
    capCents,
    allowsAdditional: (requested: number) => spent + Math.max(0, requested) <= capCents,
  };
}

/** The ceiling a user-requested paid task would carry (body limit or the deployment default). */
export function requestedSpendCeilingCents(spendLimitUsdCents: number | undefined): number {
  return Math.round(spendLimitUsdCents ?? defaultSpendLimit());
}

export type PaidRunGate =
  | { kind: "allow"; operator: boolean; userAddress: string | null }
  | { kind: "deny"; status: 401 | 403; error: string };

/**
 * Shared gate for Mind run routes that can spend: the operator passes, a
 * signed-in wallet user passes subject to their daily cap, an anonymous
 * caller is refused. Callers that know the run's exact ceiling pass it as
 * `ceilingCents`; runs whose price is only known later block at the cap.
 */
export async function paidRunGate(req: Request, label: string, ceilingCents?: number): Promise<PaidRunGate> {
  if (requestAuthorized(req)) return { kind: "allow", operator: true, userAddress: null };
  const userAddress = userAddressFromRequest(req);
  if (!userAddress) {
    return {
      kind: "deny",
      status: 401,
      error: `sign in with your wallet to run ${label}; the free modes stay open to everyone`,
    };
  }
  const standing = await userPaidSpend24h(userAddress);
  // A run with an unknown price still costs SOMETHING, so "unknown" counts as
  // 1 cent — a wallet sitting exactly at the cap must be refused, not waved
  // through by the +0 of an unpriced run.
  if (!standing.allowsAdditional(ceilingCents === undefined ? 1 : ceilingCents)) {
    return {
      kind: "deny",
      status: 403,
      error: `daily spend cap reached: this wallet has already spent ${(standing.spentCents / 100).toFixed(2)} USD of the ${(standing.capCents / 100).toFixed(2)} USD per-day allowance for payer-funded runs (rolling 24h window). Free modes stay open.`,
    };
  }
  return { kind: "allow", operator: false, userAddress };
}
