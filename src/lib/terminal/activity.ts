import type { TaskRecord } from "@/lib/engine/types";

/** The fields of the offer a Terminal ask was approved for. */
export interface ActivityOffer {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

function decodeBase64Json(input: string): unknown {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as unknown;
  } catch {
    return null;
  }
}

/**
 * The payer named in the PAYMENT-RESPONSE settlement proof. Older records were
 * written before the payer field existed, but the proof was always stored, so
 * their public payer is still recoverable without inventing anything.
 */
export function payerFromSettlement(header: string | null | undefined): string | null {
  if (!header) return null;
  const parsed = decodeBase64Json(header);
  if (!parsed || typeof parsed !== "object") return null;
  const payer = (parsed as { payer?: unknown }).payer;
  return typeof payer === "string" && /^0x[a-fA-F0-9]{40}$/.test(payer) ? payer : null;
}

/** The public payer address, preferring the field written at record time. */
export function payerOf(task: TaskRecord): string | null {
  return task.terminal?.payerAddress ?? payerFromSettlement(task.terminal?.settlementHeader);
}

/** Lower-cased payer for comparing against connected wallets. */
export function activityPayer(task: TaskRecord): string {
  return payerOf(task)?.toLowerCase() ?? "";
}

/** A readable title from the recorded request, not a blank obsolete goal. */
export function activityTitle(task: TaskRecord): string {
  const goal = task.goal?.trim() ?? "";
  const request =
    task.terminal?.request && typeof task.terminal.request === "object"
      ? (task.terminal.request as Record<string, unknown>)
      : null;
  const params =
    request?.params && typeof request.params === "object"
      ? (request.params as Record<string, unknown>)
      : null;
  const query =
    typeof params?.query === "string"
      ? params.query
      : typeof params?.claim === "string"
        ? params.claim
        : typeof params?.question === "string"
          ? params.question
          : typeof params?.topic === "string"
            ? params.topic
            : typeof request?.query === "string"
              ? request.query
              : "";

  if (goal && !/^Terminal ask \(/i.test(goal)) return goal;
  if (query.trim()) return query.trim();
  if (goal) return goal;
  if (task.terminal?.intent) return task.terminal.intent.replaceAll("_", " ");
  return "Terminal ask";
}

/** The approved offer, falling back to the offer captured in the request. */
export function activityOffer(task: TaskRecord): ActivityOffer | undefined {
  const direct = task.terminal?.offer;
  if (direct?.asset && direct.payTo) return direct;
  const request =
    task.terminal?.request && typeof task.terminal.request === "object"
      ? (task.terminal.request as { offer?: ActivityOffer })
      : null;
  return request?.offer ?? direct;
}
