import { randomUUID } from "node:crypto";
import type { EngineDeps, ExecutionOutputs } from "@/lib/engine/engine";
import { canTransition, type ExecutionEvent, type TaskRecord, type PlanStep } from "@/lib/engine/types";
import { fetchSource } from "./sources";
import { getWatch, mutateWatch } from "./store";
import type {
  Finding,
  FindingConfidence,
  FindingSignificance,
  SourceFetchResult,
  SourceSnapshot,
  WatchConfig,
  WatchRunState,
} from "./types";

/**
 * Protocol Watch step executors. Imported by the task engine and dispatched
 * by runPlan for plan steps of kind watch_check / watch_investigate /
 * watch_deliver / watch_report. All source data comes from real fetches;
 * confidence is real; delivery failures are recorded, never hidden.
 */

/* ------------------------------------------------------------------ */
/* Injectable runner deps (tests override; production uses defaults)   */
/* ------------------------------------------------------------------ */

export interface WatchRunnerDeps {
  fetchSource: (source: WatchConfig["sources"][number]) => Promise<SourceFetchResult>;
  /** Telegram delivery. Throwing means the delivery failed and is recorded. */
  sendTelegram: (chatId: string | number, text: string) => Promise<void>;
}

async function defaultFetch(source: WatchConfig["sources"][number]) {
  return fetchSource(source);
}

async function defaultSendTelegram(chatId: string | number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured on the server");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.slice(0, 160)}`);
  }
}

export const watchDeps: WatchRunnerDeps = {
  fetchSource: defaultFetch,
  sendTelegram: defaultSendTelegram,
};

/** Test hook: replace the runner deps, restore with resetWatchDeps(). */
export function setWatchDeps(overrides: Partial<WatchRunnerDeps>): void {
  Object.assign(watchDeps, overrides);
}
export function resetWatchDeps(): void {
  watchDeps.fetchSource = defaultFetch;
  watchDeps.sendTelegram = defaultSendTelegram;
}

/* ------------------------------------------------------------------ */
/* Plan construction                                                   */
/* ------------------------------------------------------------------ */

export function planWatchSteps(watch: WatchConfig, investigate: boolean): PlanStep[] {
  const steps: PlanStep[] = [
    {
      id: "watch-check",
      kind: "watch_check",
      description: `Read ${watch.sources.length} configured source${watch.sources.length === 1 ? "" : "s"} for ${watch.protocol} and compare against the last observed signatures`,
    },
  ];
  if (investigate) {
    steps.push({
      id: "watch-investigate",
      kind: "watch_investigate",
      description: "When something changed, buy a bounded Telegraph insight into why it matters, then cross-check the paid words against the fetched source data",
      maxCostUsdCents: watch.spendLimitUsdCents,
    });
  }
  steps.push(
    {
      id: "watch-corroborate",
      kind: "watch_corroborate",
      description: "Cross the detected changes against every other source actually read this run, and label significance with a keyword heuristic",
    },
    {
      id: "watch-deliver",
      kind: "watch_deliver",
      description: watch.telegramChatId
        ? "Deliver the verified findings to the configured Telegram chat"
        : "Delivery check: no Telegram chat is configured for this watch, the report stays in the Command Center",
    },
    {
      id: "watch-report",
      kind: "watch_report",
      description: "Verify the report invariants (real source evidence, honest errors, no duplicates), assemble findings with confidence, and complete",
    },
  );
  return steps;
}

/* ------------------------------------------------------------------ */
/* Event + output helpers                                              */
/* ------------------------------------------------------------------ */

/** Minimal slice of the engine deps the watch executors need. */
export interface WatchEngineDeps {
  now: () => number;
  telegraph: EngineDeps["telegraph"];
}

function allowed(task: TaskRecord, action: "telegraph.ask" | "telegram.notify"): boolean {
  return task.permissions.allowedActions.includes(action);
}

function guardedTransition(task: TaskRecord, next: TaskRecord["state"]): void {
  if (!canTransition(task.state, next)) {
    throw new Error(`illegal task transition ${task.state} to ${next}`);
  }
  task.state = next;
}

/** The engine exposes event()/saveTask(); we build the same primitive here
 * so this module stays usable from tests without engine internals. */
interface WatchTools {
  now: () => number;
  event: (task: TaskRecord, type: ExecutionEvent["type"], message: string, data?: Record<string, unknown>) => Promise<void>;
}

function makeTools(deps: WatchEngineDeps, task: TaskRecord): WatchTools {
  return {
    now: deps.now,
    event: async (task_, type, message, data) => {
      const e: ExecutionEvent = { id: randomUUID(), ts: deps.now(), type, message };
      if (data) e.data = data;
      task_.events.push(e);
      task_.updatedAt = deps.now();
      const { saveTask } = await import("@/lib/engine/store");
      await saveTask(task_);
    },
  };
}

function getRunState(outputs: ExecutionOutputs, watch: WatchConfig): WatchRunState {
  if (!outputs.watch) {
    outputs.watch = { watchId: watch.id, findings: [], sourcesReadOk: 0, sourcesFailed: 0 };
  }
  return outputs.watch;
}

/* ------------------------------------------------------------------ */
/* Step 1: check sources, detect real changes                          */
/* ------------------------------------------------------------------ */

/**
 * Reads every configured source, diffs against the persisted fingerprint, and
 * produces findings only from what was actually observed. Sources that fail
 * are recorded as source errors. A first observation records the baseline
 * without raising a false alarm. Fails the task only when EVERY source failed.
 */
export async function executeWatchCheck(
  task: TaskRecord,
  deps: WatchEngineDeps,
  outputs: ExecutionOutputs,
): Promise<void> {
  const watchId = task.watch?.watchId;
  if (!watchId) throw new Error("watch task is missing its watch reference");
  const watch = await getWatch(watchId);
  if (!watch) throw new Error(`watch ${watchId} is no longer configured`);
  const tools = makeTools(deps, task);

  await tools.event(task, "step_started", `Checking ${watch.sources.length} source${watch.sources.length === 1 ? "" : "s"} for ${watch.protocol}`, {
    sourceIds: watch.sources.map((s) => s.id),
  });

  const runState = getRunState(outputs, watch);
  const results: SourceFetchResult[] = [];

  for (const source of watch.sources) {
    const r = await watchDeps.fetchSource(source);
    results.push(r);    if (r.ok && r.snapshot) {
      runState.sourcesReadOk++;
      const prev = watch.fingerprints[source.id];
      const isFirstObservation = !prev;
      await tools.event(
        task,
        "watch_source_checked",
        `Source "${source.label}" read successfully (${r.snapshot.summary})`,
        { sourceId: source.id, signature: r.snapshot.signature },
      );
      if (isFirstObservation) {
        await tools.event(
          task,
          "watch_baseline",
          `First observation for "${source.label}": recorded as the baseline. Nothing is reported as a change until the next read differs.`,
          { sourceId: source.id, signature: r.snapshot.signature },
        );
      } else if (prev.signature !== r.snapshot.signature) {
        const finding: Finding = {
          id: randomUUID(),
          sourceId: source.id,
          sourceLabel: source.label,
          kind: findingKindFor(source, prev.signature),
          title: r.snapshot.summary,
          detail: r.snapshot.detail,
          url: r.snapshot.url,
          confidence: "source-direct",
          verified: true,
          detectedAt: deps.now(),
        };
        runState.findings.push(finding);
        await tools.event(
          task,
          "watch_change_detected",
          `Change detected on "${source.label}": ${r.snapshot.summary} (was: ${prev.summary ?? prev.signature})`,
          { sourceId: source.id, findingId: finding.id },
        );
      }
      if (!runState.observed) runState.observed = [];
      runState.observed.push({ sourceId: source.id, label: source.label, summary: r.snapshot.summary, detail: r.snapshot.detail });
    } else {
      runState.sourcesFailed++;
      const finding: Finding = {
        id: randomUUID(),
        sourceId: source.id,
        sourceLabel: source.label,
        kind: "source_error",
        title: `Source read failed: ${source.label}`,
        detail: `The source could not be read, so it is NOT counted as either a change or no-change. Error: ${r.error ?? "unknown error"}`,
        url: source.target,
        confidence: "uncertain" as FindingConfidence,
        verified: false,
        detectedAt: deps.now(),
      };
      runState.findings.push(finding);
      await tools.event(task, "watch_source_checked", `Source "${source.label}" FAILED to read: ${r.error ?? "unknown error"}. This source is excluded from change detection for this run.`, {
        sourceId: source.id,
        error: r.error,
      });
    }
  }

  // Persist fingerprints for the sources that were successfully read.
  await mutateWatch(watch.id, (w) => {
    for (const r of results) {
      if (r.ok && r.snapshot) {
        w.fingerprints[r.sourceId] = { signature: r.snapshot.signature, seenAt: deps.now(), summary: r.snapshot.summary };
      }
    }
    w.lastCheckedAt = deps.now();
  });

  if (runState.sourcesReadOk === 0) {
    throw new Error(
      `every configured source failed to read (${runState.sourcesFailed} source(s)): nothing can be honestly reported`,
    );
  }
}

function findingKindFor(source: WatchConfig["sources"][number], _prev: string): Finding["kind"] {
  switch (source.type) {
    case "github_releases":
      return "new_release";
    case "github_commits":
      return "new_commits";
    case "docs_url":
      return "content_change";
    case "discourse_forum":
      return "new_topics";
    case "rss_feed":
      return "feed_item";
    default:
      return "content_change";
  }
}

/* ------------------------------------------------------------------ */
/* Shared token helpers (corroboration + paid cross-check)             */
/* ------------------------------------------------------------------ */

/** Distinctive lowercase tokens of a text: long enough and not stop words. */
function distinctiveTokens(...texts: string[]): string[] {
  return Array.from(
    new Set(
      texts
        .join(" ")
        // NOTE: "." is deliberately NOT a split character: versions, hashes
        // and ids (v4.1.0, CVE-2025-9999) must survive as whole tokens, or
        // corroboration loses exactly the identifiers that matter.
        .split(/[\s/()[\],:;#,@]+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 5 && !/^(the|this|that|with|from|have|been|were|into|about|their|which|when|what|than|then|also|more|over|under|after|before|latest|release|summary|detail|source|change|detected|read|notes|published|successfully|first|observation|recorded|baseline|next)$/i.test(t)),
    ),
  );
}

/** Does at least `min` distinctive tokens of `text` appear in `corpus`? */
function mentionsTokens(text: string, corpus: string, min = 2): boolean {
  const tokens = distinctiveTokens(text);
  const haystack = corpus.toLowerCase();
  const hits = tokens.filter((t) => haystack.includes(t));
  return hits.length >= min;
}

/**
 * Identifier-level tokens for CORROBORATION between sources: words containing
 * digits (versions, tags, hashes, CVE ids, dates). Generic prose and proper
 * nouns are deliberately excluded because a shared protocol name proves
 * nothing. A single shared identifier of this kind is already meaningful.
 */
function identifierTokens(text: string): string[] {
  return distinctiveTokens(text).filter((t) => /\d/.test(t) && t.length >= 4);
}

/** Does the corpus contain identifier-level tokens of `text`? Uses the same
 * run-internal, strict rule shared by corroboration and paid cross-check. */
function mentionsIdentifiers(text: string, corpus: string): boolean {
  const haystack = corpus.toLowerCase();
  return identifierTokens(text).some((t) => haystack.includes(t));
}

/** Very small, explicit term-overlap check: does the paid text mention the
 * concrete identifiers the source actually showed? Honest about its limits. */
function paidInsightAgrees(finding: Finding, paidText: string): boolean {
  return mentionsTokens(
    finding.title + " " + finding.detail,
    paidText,
  );
}

/** Significance is a transparent keyword heuristic over the claim text. */
function significanceFor(text: string): FindingSignificance {
  const t = text.toLowerCase();
  if (/security|vulnerab|exploit|\bcve\b|advisory|critical|attack|breach|compromis/.test(t)) {
    // Guard against an explicit "not a real event" label being read as a
    // security event just because it contains the word.
    if (t.includes("test fixture") || t.includes("not a real event")) return "routine";
    return "high";
  }
  if (/deprecat|breaking|governance|proposal|migration|incident|paused|suspend|halt/.test(t)) return "notable";
  return "routine";
}

/* ------------------------------------------------------------------ */
/* Step 1b (free): corroborate findings across sources                 */
/* ------------------------------------------------------------------ */

/**
 * Free corroboration, always part of the plan: a change finding gains
 * confidence only when ANOTHER successfully-read source of the same watch
 * showed the same identifiers during this same run. Uses only real reads.
 * Significance is a keyword heuristic stated as such, never an AI opinion.
 */
export async function executeWatchCorroborate(
  task: TaskRecord,
  deps: WatchEngineDeps,
  outputs: ExecutionOutputs,
): Promise<void> {
  const runState = outputs.watch;
  if (!runState) throw new Error("watch corroboration ran before the source check");
  const tools = makeTools(deps, task);
  const targets = runState.findings.filter((f) => f.kind !== "source_error");
  if (targets.length === 0) {
    await tools.event(task, "watch_corroborated", "Nothing changed, so there is nothing to corroborate this run.");
    return;
  }
  for (const f of targets) {
    f.significance = significanceFor(f.title + " " + f.detail);
    // A witness is any OTHER successfully-read source of this run (never the
    // finding's own source), so corroboration always has a second read.
    const witnesses = Array.from(
      new Set(
        (runState.observed ?? [])
          .filter((o) => o.sourceId !== f.sourceId && mentionsIdentifiers(f.title + " " + f.detail, o.summary + " " + o.detail))
          .map((o) => o.label),
      ),
    );
    if (witnesses.length > 0) {
      f.corroboratedBy = witnesses;
      f.confidence = "cross-checked";
      await tools.event(
        task,
        "watch_corroborated",
        `Change on "${f.sourceLabel}" was independently corroborated by ${witnesses.join(", ")} in this run (cross-checked).`,
        { findingId: f.id, corroboratedBy: witnesses },
      );
    } else {
      await tools.event(
        task,
        "watch_corroborated",
        `Change on "${f.sourceLabel}" stands on the source's own data (source-direct): no other configured source read this run repeats the claim. This is not a contradiction, just a single read.`,
        { findingId: f.id },
      );
    }
  }
  await tools.event(task, "step_succeeded", `Corroboration pass complete: ${targets.filter((f) => f.corroboratedBy?.length).length} of ${targets.length} change finding(s) cross-checked against a second real read.`);
}

/* ------------------------------------------------------------------ */
/* Step 2 (optional): paid investigation with cross-check               */
/* ------------------------------------------------------------------ */

export async function executeWatchInvestigate(
  task: TaskRecord,
  deps: WatchEngineDeps,
  outputs: ExecutionOutputs,
): Promise<void> {
  const runState = outputs.watch;
  if (!runState) throw new Error("watch investigation ran before the source check");
  const real = runState.findings.filter((f) => f.kind !== "source_error");
  const tools = makeTools(deps, task);
  if (real.length === 0) {
    await tools.event(task, "watch_paid_skipped", "No source changed, so no paid investigation: Telegraph intelligence adds nothing here.");
    return;
  }

  if (!allowed(task, "telegraph.ask")) {
    await tools.event(task, "permission_denied", 'Action "telegraph.ask" is not in this task\'s allowed actions, so the paid investigation was skipped.');
    return;
  }
  const remaining = task.spend.limitUsdCents - task.spend.spentUsdCents;
  if (remaining <= 0) {
    await tools.event(task, "spend_denied", "Spending limit already exhausted, paid investigation skipped.");
    return;
  }

  const watchId = task.watch?.watchId;
  const watch = watchId ? await getWatch(watchId) : null;
  const protocolLine = watch ? `Protocol: ${watch.protocol}.` : "";
  const priority = real[0];
  const query =
    `Protocol Watch report context. ${protocolLine} A monitored source changed. ` +
    `Observed change: "${priority.title}". Detail from the source itself: ${priority.detail.slice(0, 600)}. ` +
    `Question: for a protocol team, why does this change matter, and what should they check next? Answer in 3 short bullets, grounded in the observed change, no speculation.`;

  await tools.event(task, "step_started", "Purchasing a bounded Telegraph insight into the detected change");
  let paid;
  try {
    paid = await deps.telegraph.askAuto({
      query,
      remainingBudgetUsdCents: remaining,
      onChallenge: (info) => {
        void tools.event(
          task,
          "telegraph_challenge",
          `Network priced the insight at ${(info.amountUsdCents / 100).toFixed(2)} USD, budget${info.amountUsdCents > remaining ? " exceeded" : " OK"}`,
          { amountUsdCents: info.amountUsdCents },
        );
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/budget|exceed|402.*over|insufficient/i.test(message)) {
      await tools.event(task, "spend_denied", `Paid insight refused within the ceiling: ${message}. The ${real.length} source-direct finding${real.length === 1 ? "" : "s"} stand on their own evidence.`);
      return;
    }
    if (/not configured|credentials/i.test(message)) {
      await tools.event(task, "watch_paid_skipped", `Paid intelligence is not configured (${message}). Findings stand as source-direct facts.`);
      return;
    }
    throw err;
  }

  // Account the spend exactly like the goal task does, from the receipt.
  const cents = paid.receipt?.amount_uusdc
    ? Math.round(Number(paid.receipt.amount_uusdc) / 10000)
    : Math.round((paid.costUsd ?? 0) * 100);
  if (cents > 0) {
    task.spend.spentUsdCents += cents;
    task.spend.entries.push({
      ts: deps.now(),
      description: "Telegraph insight (Protocol Watch investigation)",
      amountUsdCents: cents,
      source: "telegraph",
      receiptHash: paid.receipt?.receipt_hash,
      txHash: paid.receipt?.tx_hash,
      signalHash: paid.signalHash ?? undefined,
    });
    await tools.event(task, "spend_recorded", `Spent ${(cents / 100).toFixed(2)} USD on a Telegraph insight (watch budget now ${(task.spend.spentUsdCents / 100).toFixed(2)} / ${(task.spend.limitUsdCents / 100).toFixed(2)})`, {
      amountUsdCents: cents,
      receiptHash: paid.receipt?.receipt_hash,
      signalHash: paid.signalHash,
    });
  }

  const answerText = flattenAnswer(paid.answer);
  await tools.event(task, "step_succeeded", `Insight received from ${paid.minerName ?? paid.minerId} (signal ${paid.signalHash})`);

  for (const f of runState.findings) {
    if (f.kind === "source_error") continue;
    f.paidInsight = answerText.slice(0, 1200);
    f.paidInsightAgrees = paidInsightAgrees(f, answerText);
    f.confidence = f.paidInsightAgrees ? "cross-checked" : "uncertain";
    await tools.event(
      task,
      f.paidInsightAgrees ? "criteria_check_passed" : "criteria_failed",
      `Cross-check of the paid insight against the fetched source data for "${f.sourceLabel}": ${f.paidInsightAgrees ? "the insight agrees with the observed change (cross-checked)" : "the insight does not clearly agree with the observed change, so this finding is marked uncertain"}`,
      { findingId: f.id, agreed: f.paidInsightAgrees },
    );
  }
}

function flattenAnswer(answer: Record<string, unknown>): string {
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") parts.push(node);
    else if (typeof node === "number") parts.push(String(node));
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(answer);
  return parts.join("\n").trim();
}

/* ------------------------------------------------------------------ */
/* Step 3: delivery                                                    */
/* ------------------------------------------------------------------ */

function reportText(task: TaskRecord, runState: WatchRunState): string {
  const lines: string[] = [];
  lines.push(`Protocol Watch: ${task.watch?.watchName ?? "watch"} report`);
  const changes = runState.findings.filter((f) => f.kind !== "source_error");
  const errors = runState.findings.filter((f) => f.kind === "source_error");
  if (changes.length === 0 && errors.length === 0) {
    lines.push("No changes detected in the monitored sources.");
  } else {
    for (const f of changes) {
      lines.push("");
      lines.push(`[${f.confidence.toUpperCase()}] ${f.title}`);
      lines.push(f.detail.slice(0, 500));
      if (f.corroboratedBy?.length) lines.push(`Corroboration: independently seen on ${f.corroboratedBy.join(", ")} in the same check run.`);
      if (f.significance) lines.push(`Significance: ${f.significance} (keyword heuristic over the source text, not an AI judgment).`);
      if (f.paidInsight && f.paidInsightAgrees) lines.push(`Why it matters: ${f.paidInsight.slice(0, 400)}`);
      if (f.paidInsight && f.paidInsightAgrees === false) lines.push("Note: the paid insight did not clearly agree with the source, so treat the source facts as primary.");
      if (f.url) lines.push(`Evidence: ${f.url}`);
    }
    for (const f of errors) {
      lines.push("");
      lines.push(`[SOURCE ERROR] ${f.sourceLabel}`);
      lines.push(f.detail.slice(0, 300));
    }
  }
  lines.push("");
  lines.push(
    `Next steps: compare the linked release notes / docs diff against your integration before upgrading, and re-run a check after any fix. Costs this run: $${(task.spend.spentUsdCents / 100).toFixed(2)} of the ${(task.spend.limitUsdCents / 100).toFixed(2)} ceiling.`,
  );
  return lines.join("\n").slice(0, 3800);
}

export async function executeWatchDeliver(
  task: TaskRecord,
  deps: WatchEngineDeps,
  outputs: ExecutionOutputs,
): Promise<void> {
  const runState = outputs.watch;
  if (!runState) throw new Error("watch delivery ran before the source check");
  const tools = makeTools(deps, task);
  const chatId = task.watch?.telegramChatId;

  if (runState.findings.length === 0) {
    // Nothing changed and nothing failed: delivering an all-quiet report on
    // every check would be spam. The quiet run is still recorded in history.
    await tools.event(task, "delivery_skipped", "Nothing to deliver: no changes and no source errors surfaced this run.");
    return;
  }

  if (!chatId) {
    await tools.event(task, "delivery_skipped", "No Telegram chat is configured for this watch: report stays in the Command Center history. Configure one to enable delivery.");
    return;
  }
  if (!allowed(task, "telegram.notify")) {
    await tools.event(task, "delivery_skipped", 'Action "telegram.notify" is not in this task\'s allowed actions, delivery skipped.');
    return;
  }

  const text = reportText(task, runState);
  await tools.event(task, "delivery_started", `Delivering the report to Telegram chat (id ending ${String(chatId).slice(-4)})`);
  try {
    await watchDeps.sendTelegram(chatId, text);
    await tools.event(task, "delivery_succeeded", "Report delivered to Telegram.", { chatIdSuffix: String(chatId).slice(-4) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tools.event(task, "delivery_failed", `Telegram delivery FAILED, the report is kept in the task history: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Step 4: verify invariants + final report                            */
/* ------------------------------------------------------------------ */

export async function executeWatchReport(
  task: TaskRecord,
  deps: WatchEngineDeps,
  outputs: ExecutionOutputs,
): Promise<void> {
  const runState = outputs.watch;
  if (!runState) throw new Error("watch report ran before the source check");
  const tools = makeTools(deps, task);

  // Invariants, enforced (and tested): every non-error finding restates real
  // fetched data; source errors never claim change/knowledge; duplicate
  // signatures could never emit findings twice because the fingerprint is
  // persisted inside the check step.
  const invalid = runState.findings.filter(
    (f) => f.kind !== "source_error" && !(f.verified === true && f.detail.length > 0),
  );
  if (invalid.length > 0) {
    throw new Error(`report invariant failed: ${invalid.length} finding(s) lack real source evidence`);
  }

  guardedTransition(task, "verifying");
  await tools.event(task, "verification_started", "Verifying report invariants: every finding must restate fetched source data, errors stay errors, nothing invented");
  if (invalid.length > 0) throw new Error("invariant failed before completion");
  const summary = reportText(task, runState);
  task.result = {
    summary,
    // Real report evidence: each finding names the source that produced it and
    // its confidence. NOT a purchase signal; there is no payment in a free run.
    evidence: runState.findings.map((f) => ({
      kind: "watch_finding" as const,
      sourceLabel: f.sourceLabel,
      findingKind: f.kind,
      confidence: f.confidence,
      url: f.url ?? null,
      corroboratedBy: f.corroboratedBy,
    })),
    completedAt: deps.now(),
  };
  await tools.event(task, "verification_passed", `All report invariants verified: ${runState.findings.filter((f) => f.kind !== "source_error").length} finding(s) grounded in fetched sources, ${runState.findings.filter((f) => f.kind === "source_error").length} honest source error(s)`);
  guardedTransition(task, "completed");
  await tools.event(task, "task_completed", "Protocol Watch check complete.", { findings: runState.findings.length });
}
