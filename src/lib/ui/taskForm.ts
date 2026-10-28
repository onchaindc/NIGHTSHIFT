/**
 * Goal composer rules as pure functions, so they can be tested without a
 * browser and reused by the console and any future surface.
 */

export const DEFAULT_SPEND_LIMIT_LABEL = "Default ceiling $1.00";

export interface TaskRequestPayload {
  goal: string;
  spendLimitUsdCents?: number;
  requiresApproval: boolean;
}

export type FormError = "goalEmpty" | "goalDuplicate" | "limitInvalid";

/**
 * Parse the raw spending-ceiling input. Empty input means "use the server
 * default", which is valid. Anything present must parse to at least one cent.
 */
export function cleanLimit(raw: string): { cents: number | null; valid: boolean } {
  const digits = raw.replace(/[^0-9.]/g, "");
  if (digits === "") return { cents: null, valid: true };
  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value) || value <= 0) return { cents: null, valid: false };
  const cents = Math.round(value * 100);
  if (cents <= 0) return { cents: null, valid: false };
  return { cents, valid: true };
}

/** True while a task with the same typed goal is already live or awaiting approval. */
export function isDuplicateGoal(goal: string, liveGoals: string[]): boolean {
  const trimmed = goal.trim();
  return liveGoals.some((g) => g.trim().toUpperCase() === trimmed.toUpperCase());
}

export function buildTaskRequest(input: {
  goal: string;
  limitRaw: string;
  requiresApproval: boolean;
  liveGoals?: string[];
}): { ok: true; payload: TaskRequestPayload } | { ok: false; error: FormError } {
  const goal = input.goal.trim();
  if (!goal) return { ok: false, error: "goalEmpty" };
  if (isDuplicateGoal(goal, input.liveGoals ?? [])) return { ok: false, error: "goalDuplicate" };
  const { cents, valid } = cleanLimit(input.limitRaw);
  if (!valid) return { ok: false, error: "limitInvalid" };
  return {
    ok: true,
    payload: {
      goal,
      ...(cents ? { spendLimitUsdCents: cents } : {}),
      requiresApproval: input.requiresApproval,
    },
  };
}

export const FORM_ERROR_COPY: Record<FormError, string> = {
  goalEmpty: "Write a goal first, or pick one of the examples.",
  goalDuplicate: "A task with this exact goal is already running or waiting for approval.",
  limitInvalid: "Enter a ceiling of at least $0.01, or clear the field to use the default.",
};
