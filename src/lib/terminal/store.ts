/**
 * Terminal activity persistence (Phase 5b).
 *
 * Every interactive Terminal execution is recorded into the SAME task store
 * the engine, console and Activity centre already read (src/lib/engine/store,
 * backed by the swappable persistence module). No second history system; no
 * payment machinery is re-run here: recording happens strictly AFTER the
 * execute route's existing approval-pinned paid step agreed an outcome.
 *
 * Idempotency: answered runs are keyed once per network fact — the signal
 * hash the node assigns to that delivery — so re-writing the same outcome
 * upserts the same record instead of duplicating it. Failed attempts have no
 * network identity, so each attempt (a real, separate execution attempt with
 * a real reason) becomes one record keyed by a fresh attempt id.
 *
 * Never invented here: receipt, settlement and timing fields are stored only
 * when the response actually carried them; a failed attempt records the
 * refusal reason and no spend, never a payment. No private key material is
 * ever written: the payer shows up only as its public address.
 */

import { randomUUID } from "node:crypto";

import { saveTask } from "@/lib/engine/store";
import type { ExecutionEvent, TaskRecord, TerminalRunInfo, TelegraphReceipt } from "@/lib/engine/types";
import { assembleAskBody, type AskRequestSpec, type ApprovedOffer, type ExecuteOutcome } from "./ask";

export interface RecordedActivity {
  id: string;
  saved: boolean;
  /** Filled when saved is false: the persistence error, shown to the user. */
  detail?: string;
}

/** Execution events reuse the engine's existing vocabulary (same feed labels). */
function ev(ts: number, type: ExecutionEvent["type"], message: string, data?: Record<string, unknown>): ExecutionEvent {
  return { id: randomUUID(), ts, type, message, ...(data ? { data } : {}) };
}

/** The user-facing goal text of the recorded attempt, from the real request. */
function goalText(spec: AskRequestSpec): string {
  if (spec.rawBody !== undefined) return "Advanced JSON request sent through the Terminal";
  if (spec.intent !== undefined && spec.params !== undefined) {
    return `Terminal ask (${spec.intent}), guided parameters`;
  }
  return typeof spec.query === "string" ? spec.query : "Terminal ask";
}

/** Shared scaffolding so every record stays one task-record shape. */
function baseRecord(p: {
  id: string;
  state: TaskRecord["state"];
  goal: string;
  ts: number;
  error: string | null;
  terminal?: TerminalRunInfo;
}): TaskRecord {
  return {
    id: p.id,
    createdAt: p.ts,
    updatedAt: p.ts,
    state: p.state,
    jobType: "terminal_request",
    goal: p.goal,
    plan: null,
    events: [],
    spend: { limitUsdCents: 0, spentUsdCents: 0, entries: [] },
    // The engine's criteria machinery did not run for an interactive ask;
    // every field stays at its "not assessed" value rather than claiming checks.
    criteria: {
      primaryVerifiedAgainstNodeSignal: false,
      answerSane: false,
      answerMaxAgeSeconds: 0,
      ownPaymentSettledOnChain: false,
      reconcileLedgerEntries: false,
    },
    permissions: { allowedActions: ["telegraph.ask"], requiresApproval: true, maxRetries: 0 },
    result: null,
    error: p.error,
    origin: { source: "web" },
    labels: ["terminal"],
    ...(p.terminal ? { terminal: p.terminal } : {}),
  };
}

export async function recordTerminalOutcome(
  outcome: ExecuteOutcome,
  spec: AskRequestSpec,
  payerAddress?: string,
): Promise<RecordedActivity> {
  const ts = Date.now();
  try {
    const assembled = assembleAskBody(spec);
    const requestBody = "body" in assembled ? assembled.body : { raw: spec };
    const endpointPath = "body" in assembled ? assembled.urlPath : undefined;
    const goal = goalText(spec);

    if (outcome.kind === "answered") {
      const receipt: TelegraphReceipt = outcome.receipt;
      // amount_uusdc is 6-decimal atomic units: 10000 = $0.01 = 1 cent.
      const cents = Math.round(Number(receipt.amount_uusdc) / 10_000);
      const events: ExecutionEvent[] = [
        ev(ts, "goal_accepted", `Terminal ask submitted through the approved offer on ${outcome.offer.network}`, {
          request: outcome.requestSent ?? requestBody,
          offer: outcome.offer,
        }),
        ...(outcome.offer
          ? [ev(ts, "telegraph_challenge", `The network priced this ask; the user approved the exact offer before signing`, { offer: outcome.offer })]
          : []),
        ev(ts, "action_started", `Signed ${outcome.offer.scheme === "escrow" ? "escrow authorization" : "EIP-712 exact-scheme payment"} and called ${outcome.urlPath}`, {
          endpoint: outcome.urlPath,
          minerId: outcome.minerId ?? String(receipt.miner ?? ""),
        }),
        ev(ts, "spend_recorded", `Delivered 200 with an X-TELEGRAPH-RECEIPT; reconciled on receipt_hash`, {
          receiptHash: receipt.receipt_hash,
          txHash: receipt.tx_hash,
          signalHash: outcome.signalHash,
          amountUsdCents: cents,
        }),
      ];
      const task = baseRecord({ id: `terminal-${outcome.signalHash}`, state: "completed", goal, ts, error: null });
      task.events = events;
      task.spend = {
        limitUsdCents: cents,
        spentUsdCents: cents,
        entries: [
          {
            ts,
            description: `Terminal ask paid with ${outcome.offer.scheme === "escrow" ? "Telegraph escrow" : "x402 exact-scheme USDC"}`,
            amountUsdCents: cents,
            source: "telegraph",
            receiptHash: receipt.receipt_hash,
            ...(receipt.tx_hash ? { txHash: receipt.tx_hash } : {}),
            signalHash: outcome.signalHash,
          },
        ],
      };
      // Only fields the response genuinely carried end up in the record.
      task.terminal = {
        intent: outcome.intent ?? receipt.intent ?? null,
        miner: outcome.minerName ?? (outcome.minerId != null ? String(outcome.minerId) : receipt.miner != null ? String(receipt.miner) : null),
        endpointPath: outcome.urlPath,
        request: outcome.requestSent ?? requestBody,
        offer: outcome.offer,
        ...(payerAddress ? { payerAddress } : {}),
        ...(typeof outcome.durationMs === "number" ? { durationMs: outcome.durationMs } : {}),
        ...(typeof outcome.timestamp === "string" ? { timestamp: outcome.timestamp } : {}),
        ...(typeof outcome.settlementHeader === "string" ? { settlementHeader: outcome.settlementHeader } : {}),
      };
      task.result = {
        summary:
          typeof outcome.result === "string"
            ? outcome.result
            : outcome.result != null
              ? JSON.stringify(outcome.result)
              : "(the miner's answer arrived without a renderable result body)",
        completedAt: ts,
        evidence: [
          { kind: "telegraph_signal", signalHash: outcome.signalHash, minerId: outcome.minerId ?? String(receipt.miner ?? "") },
          {
            kind: "telegraph_receipt",
            receiptHash: receipt.receipt_hash,
            ...(receipt.tx_hash ? { txHash: receipt.tx_hash } : {}),
            amountUsdCents: cents,
          },
        ],
      };
      await saveTask(task);
      return { id: task.id, saved: true };
    }

    /* ---- not answered: record the attempt exactly as it ended ---- */

    let heading: string;
    let detail: string;
    let events: ExecutionEvent[];
    const priced = outcome.kind === "refused" && outcome.fresh?.kind === "challenge";
    switch (outcome.kind) {
      case "refused":
        heading = "Refused before anything was signed";
        detail = outcome.reason;
        break;
      case "unpaid_rejected":
        heading = "Refused by the node before payment";
        detail = `HTTP ${outcome.status}: the request did not pass the node's pre-payment checks. Nothing was signed and nothing settles.`;
        break;
      case "payment_rejected":
        heading = "Signed payment did not verify";
        detail = outcome.detail;
        break;
      case "failed":
        heading = "Paid request failed";
        detail = outcome.detail;
        break;
      case "integrity":
        heading = "Response could not be accounted";
        detail = `${outcome.detail} This record does not claim the request was answered OR that nothing settled; the network evidence needed to tell those apart was not in the response.`;
        break;
    }
    events = [
      ev(ts, "goal_accepted", "Terminal ask submitted for execution", { request: requestBody }),
      ...(priced
        ? [ev(ts, "telegraph_challenge", "The network priced the request, but execution refused before anything was signed", { offer: outcome.kind === "refused" && outcome.fresh?.kind === "challenge" ? outcome.fresh.approvedOffer : undefined })]
        : []),
      // action_started would claim a payment attempt happened; only the two
      // outcomes that actually reached the signing stage get it.
      ...(outcome.kind === "payment_rejected"
        ? [ev(ts, "action_started", "Signed and sent the payment payload after drift re-checking the approved offer")]
        : outcome.kind === "failed"
          ? [ev(ts, "action_started", "The paid request was sent; the node answered with an error status")]
          : []),
      ev(ts, "step_failed", detail, { kind: outcome.kind }),
    ];
    const task = baseRecord({ id: `terminal-attempt-${randomUUID()}`, state: "failed", goal, ts, error: `${heading}: ${detail}` });
    task.events = events;
    // A failed attempt still belongs to the wallet that signed it, so it can
    // appear in that wallet's history. No receipt or spend is claimed.
    // These fields are only declared on the answered variant, which returned
    // above; a cast keeps them readable without pretending the union has them.
    const carried = outcome as {
      urlPath?: string;
      requestSent?: unknown;
      offer?: { scheme: string; network: string; asset: string; payTo: string; amount: string };
    };
    task.terminal = {
      intent: spec.intent ?? null,
      miner: spec.minerId ?? null,
      endpointPath: carried.urlPath,
      request: carried.requestSent ?? requestBody,
      ...(carried.offer ? { offer: carried.offer } : {}),
      ...(payerAddress ? { payerAddress } : {}),
    };
    // spend stays zero: nothing is claimed as paid without an actual receipt.
    await saveTask(task);
    return { id: task.id, saved: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: "", saved: false, detail: msg.slice(0, 200) };
  }
}
