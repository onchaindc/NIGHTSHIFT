import { listTasks } from "@/lib/engine/store";
import { defaultSpendLimit } from "@/lib/engine/engine";
import { isPayerAddress, requestAuthorized, userAddressFromRequest } from "@/lib/api/auth";
import { creditBalanceOf } from "@/lib/wallet/credits";

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
 * signed-in wallet user passes when THEIR OWN in-app spend credit covers the
 * run's ceiling AND the per-user daily cap has room (the cap stays as the
 * guard on faucet-funded credit), an anonymous caller is refused. Callers
 * that know the run's exact ceiling pass it as `ceilingCents`; runs whose
 * price is only known later block at 1 cent.
 */
export async function paidRunGate(req: Request, label: string, ceilingCents?: number): Promise<PaidRunGate> {
  if (requestAuthorized(req)) return { kind: "allow", operator: true, userAddress: null };
  const userAddress = userAddressFromRequest(req);
  if (userAddress && isPayerAddress(userAddress)) return { kind: "allow", operator: true, userAddress: null };
  if (!userAddress) {
    return {
      kind: "deny",
      status: 401,
      error: `sign in with your wallet to run ${label}; the free modes stay open to everyone`,
    };
  }
  // The user's own in-app credit is the budget now — the deployment payer no
  // longer fronts signed-in users' runs. A run with an unknown price still
  // costs SOMETHING, so "unknown" counts as 1 cent.
  const needed = ceilingCents === undefined ? 1 : Math.max(1, Math.round(ceilingCents));
  const balance = await creditBalanceOf(userAddress);
  if (balance < needed) {
    return {
      kind: "deny",
      status: 403,
      error: `your in-app spend credit is ${(balance / 100).toFixed(2)} USD but this run needs about ${(needed / 100).toFixed(2)} USD. Paid runs settle from YOUR wallet's credit — top it up on the Wallet page (the faucet mint adds 10.00 of credit alongside the on-chain test USDC). Free modes stay open.`,
    };
  }
  const standing = await userPaidSpend24h(userAddress);
  if (!standing.allowsAdditional(ceilingCents === undefined ? 1 : ceilingCents)) {
    return {
      kind: "deny",
      status: 403,
      error: `daily spend cap reached: this wallet has already spent ${(standing.spentCents / 100).toFixed(2)} USD of the ${(standing.capCents / 100).toFixed(2)} USD per-day allowance for payer-funded runs (rolling 24h window). Free modes stay open.`,
    };
  }
  return { kind: "allow", operator: false, userAddress };
}
