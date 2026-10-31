/**
 * Telegram bot adapter — official Bot API only (https://api.telegram.org),
 * no third-party bot framework. Keeps TELEGRAM_BOT_TOKEN strictly server-side:
 * this module never runs in the browser; it is imported only by the webhook
 * API route (node runtime).
 *
 * The adapter drives the SAME task engine, permissions and spending limits as
 * the web app: submitting a goal via Telegram creates and runs an identical
 * engine task; /approve resumes one that is waiting for approval. Engine deps
 * and the send function are injectable so tests can exercise the full command
 * surface offline against fakes.
 *
 * Duplicate-update policy: updates are marked processed (persistently, see
 * offsets.ts) BEFORE handling — at-most-once, so a redelivered update can
 * never mint a second purchase. A dropped message is recoverable (resubmit);
 * a double-spent goal is not.
 */

import { createTask, defaultSpendLimit, approveTask, rejectTask, defaultDeps, runTask as runEngineTask } from "@/lib/engine/engine";
import type { EngineDeps } from "@/lib/engine/engine";
import { getTask, listTasks } from "@/lib/engine/store";
import { missingPaidCredentials } from "@/lib/telegraph/client";
import { claimUpdate } from "./offsets";
import { humanize } from "@/lib/ui/humanize";
import { resolveWebhookBaseUrl } from "./webhook-register";
import type { TaskRecord, ExecutionEventType } from "@/lib/engine/types";

const API_BASE = "https://api.telegram.org";

export const missingBotCredentials = () => {
  const keys = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) keys.push("TELEGRAM_BOT_TOKEN");
  return keys;
};

interface SendFn {
  (chatId: string | number, text: string): Promise<void>;
}

const MAX_SEND_ATTEMPTS = 3;

/**
 * sendMessage with bounded retries: a transient network error or Telegram
 * 429 (rate limit, honored via `retry_after`) is retried; other Bot API
 * HTTP errors are not (they are deterministic-ish, and the task outcome
 * matters more than the notification — we log and continue rather than
 * throw, so a failed progress message can never kill a live task run).
 */
async function defaultSend(chatId: string | number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  let lastDetail = "unknown error";
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }), // plain text: no escaping foot-guns
      });
      if (res.ok) return;
      const payload = await res.text().catch(() => "");
      lastDetail = `HTTP ${res.status} ${payload}`;
      if (res.status === 429 && attempt < MAX_SEND_ATTEMPTS) {
        let waitMs = 1500;
        try {
          const parsed = JSON.parse(payload) as { parameters?: { retry_after?: number } };
          if (parsed?.parameters?.retry_after) waitMs = Math.min(10_000, parsed.parameters.retry_after * 1000);
        } catch {}
        await sleep(waitMs);
        continue;
      }
      break; // non-429 API error: not retryable
    } catch (err) {
      // Network-level failure: the serverless runtime freezes, DNS blips,
      // connection resets — retry with a small backoff.
      lastDetail = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_SEND_ATTEMPTS) {
        await sleep(500 * attempt);
        continue;
      }
    }
  }
  console.error(`telegram sendMessage failed after ${MAX_SEND_ATTEMPTS} attempts: ${lastDetail}`);
}

/** Direct single-shot gateway used by recovery to re-deliver task results. */
export async function sendViaDefault(chatId: string | number, text: string): Promise<void> {
  await defaultSend(chatId, text);
}

/**
 * Re-delivers a finished task's final report (used after recovery re-runs
 * a task whose origin chat is a numeric user id). Best-effort by contract:
 */
export async function deliverResult(chatId: string | number, task: TaskRecord, send: SendFn = sendViaDefault): Promise<void> {
  await send(chatId, formatFinal(task));
}

export interface TelegramDeps {
  engine?: EngineDeps;
  send?: SendFn;
}

interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}

export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
}

/* ------------------------------------------------------------------ */  const HELP = [
    "NIGHTSHIFT, until the work is done.",
    "",
    "Commands:",
    "/goal <text> research for FREE (public chain RPC + public price APIs); questions with no free capability are refused, never paid for silently",
    "/paid <text> EXPLICIT paid research via Telegraph (requires TELEGRAPH_EVM_PRIVATE_KEY); the plan waits for your /approve before anything is spent",
    "/tasks list your recent goals",
    "/status <id-prefix> show one task in detail",
    "/approve <id-prefix> approve a plan awaiting approval",
    "/reject <id-prefix> reject a plan awaiting approval",
    "",
    "Every purchase is checked against the task's spending limit and the",
    "network's actual 402 price before any payment is signed. Nothing is",
    "ever switched from free to paid behind your back.",
  ].join("\n");

function shortId(id: string): string {
  return id.slice(0, 8);
}

function taskCard(t: TaskRecord): string {
  const spent = (t.spend.spentUsdCents / 100).toFixed(2);
  const limit = (t.spend.limitUsdCents / 100).toFixed(2);
  const lines = [
    `[${shortId(t.id)}] ${t.state.toUpperCase()}`,
    `Goal: ${t.goal}`,
    `Spend: $${spent} / $${limit} limit`,
  ];
  const last = t.events[t.events.length - 1];
  if (last) lines.push(`Last event: ${humanize(last.message)}`);
  if (t.error) lines.push(`Error: ${humanize(t.error)}`);
  if (t.state === "awaiting_approval") lines.push("→ use /approve " + shortId(t.id) + " or /reject " + shortId(t.id));
  return lines.join("\n");
}

function findByPrefix(prefix: string, tasks: TaskRecord[]): TaskRecord | undefined {
  return tasks.find((t) => t.id.startsWith(prefix)) ?? tasks[0];
}

export function statusSummary(t: TaskRecord): string {
  return taskCard(t);
}

/** Web report link, only when the deployment has a known public base URL. */
function webReportLink(taskId: string): string | null {
  const base = resolveWebhookBaseUrl();
  return base ? `${base}/tasks/${taskId}` : null;
}

function clampLine(text: string, max: number): string {
  const single = text.trim().split("\n")[0].trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/**
 * Concise BLOCKED report: status, short reason, spend status and a next step.
 * Never the full internal criteria/plan dump. Used both by the live /goal flow
 * (blocked-at-creation tasks) and by the final-report path.
 */
export function blockedReport(t: TaskRecord): string {
  const id = shortId(t.id);
  const blockerEvent = [...t.events].reverse().find((e) => e.type === "task_blocked");
  const reason = clampLine(humanize(t.error ?? blockerEvent?.message ?? "the plan was blocked"), 400);
  const lines = [`⛔ BLOCKED [${id}]`, "", reason, ""];
  if (t.spend.spentUsdCents > 0) lines.push(`Spent: $${(t.spend.spentUsdCents / 100).toFixed(2)} (limit $${(t.spend.limitUsdCents / 100).toFixed(2)})`);
  else lines.push("Nothing was executed and nothing was spent — no payment was signed.");
  const reportLink = webReportLink(t.id);
  if (reportLink) lines.push("", `Full record: ${reportLink}`);
  return lines.join("\n").slice(0, 4000);
}

/**
 * Result-first, concise final messages. The full internal record (plan,
 * criteria, every event, all raw evidence) stays in the engine task record
 * and the web report; Telegram gets the outcome, spend, operation id and a
 * link where a public base URL exists. Completion claims are only ever built
 * from verified results — a completed state always passed verification.
 */
function formatFinal(t: TaskRecord): string {
  const id = shortId(t.id);
  const spent = `Spent: $${(t.spend.spentUsdCents / 100).toFixed(2)} (limit $${(t.spend.limitUsdCents / 100).toFixed(2)})`;
  const reportLink = webReportLink(t.id);

  if (t.state === "blocked") {
    return blockedReport(t);
  }

  if (t.state !== "completed") {
    const failureEvent = [...t.events].reverse().find((e) => e.type === "criteria_failed" || e.type === "task_failed");
    const reason = humanize(t.error ?? failureEvent?.message ?? "the run failed");
    const lines = [`✗ FAILED [${id}]`, "", reason.length > 600 ? `${reason.slice(0, 600)}…` : reason, "", spent];
    if (t.spend.spentUsdCents > 0) {
      // Honest recovery guidance: a spent research plan is never re-run
      // automatically — that would risk a second charge.
      lines.push("Purchases were made but the outcome did not verify. Re-running would spend again; /status " + id + " has the full record first.");
    } else {
      lines.push("No purchases were made; this goal can be re-run for free.");
    }
    if (reportLink) lines.push("", `Full record: ${reportLink}`);
    return lines.join("\n").slice(0, 4000);
  }

  // COMPLETED — result first: status, the answer itself, verification, spend.
  const lines = [`✅ COMPLETED [${id}]`];
  const intent = t.criteria.goalIntent ?? "information";
  if (intent === "preparation") {
    lines.push("Preparation material produced — NIGHTSHIFT did NOT execute any action, and that remains unverified.");
  }
  if (t.result) {
    // The recorded summary already carries the actual answer, its real source
    // and the cost — send it prominently, unembellished.
    lines.push("", t.result.summary.slice(0, 2400));
  }
  lines.push("");
  lines.push(`Verified ✓ outcome checked against the recorded evidence. ${spent}`);
  lines.push(`Ops ID: ${t.id}`);
  if (reportLink) lines.push(`Full report (events, evidence, verification): ${reportLink}`);
  return lines.join("\n").slice(0, 4000);
}

/* ------------------------------------------------------------------ */
/* Progress delivery                                                   */
/* ------------------------------------------------------------------ */

const EVENT_ICON: Partial<Record<TaskRecord["events"][number]["type"], string>> = {
  step_started: "⚙",
  step_succeeded: "✓",
  step_failed: "✗",
  step_retried: "↻",
  recovery_selected: "↻",
  action_started: "⚙",
  permission_denied: "⛔",
  spend_denied: "⛔",
  spend_recorded: "$",
  telegraph_challenge: "$",
  verification_started: "…",
  verification_passed: "✓",
  verification_failed: "✗",
  criteria_failed: "✗",
  criteria_check_passed: "✓",
  task_completed: "🎉",
  task_failed: "✗",
  task_blocked: "⛔",
};

/**
 * Concise-stream policy: Telegram is NOT shown the internal execution
 * timeline (plans, criteria, step chatter, repeated cost explanations stay in
 * the task record and the web report). The one stream-worthy moment is real
 * money moving; everything else arrives result-first in the final message.
 */
const STREAMED_EVENT_TYPES: ReadonlySet<ExecutionEventType> = new Set<ExecutionEventType>(["spend_recorded"]);

/**
 * Runs the engine task asynchronously, streaming only milestone events to
 * the chat, then sends the final result-first report. The engine stays
 * unchanged (it has no transport code); this polls the persisted task record.
 */
async function runWithProgress(
  taskId: string,
  chatId: string | number,
  engine: EngineDeps,
  run: Promise<TaskRecord>,
  send: SendFn,
): Promise<void> {
  let sentEventIds = new Set<string>();
  let sendFailures = 0;
  let done = false;
  // A failed send used to abort the whole progress pump, silently dropping
  // every remaining update (final report included). Each send is now
  // guarded: the task keeps producing events and the pump keeps delivering.
  const guardedSend = async (text: string): Promise<void> => {
    try {
      await send(chatId, text);
    } catch (err) {
      sendFailures++;
      console.error("telegram progress send failed:", err);
    }
  };
  const pump = (async () => {
    while (!done) {
      const t = await getTask(taskId);
      if (t) {
        for (const e of t.events) {
          if (!STREAMED_EVENT_TYPES.has(e.type)) continue; // internal timeline stays off Telegram
          if (sentEventIds.has(e.id)) continue;
          sentEventIds.add(e.id);
          const icon = EVENT_ICON[e.type] ?? "·";
          await guardedSend(humanize(`${icon} ${e.message}`).slice(0, 3800));
        }
        if (t.state === "completed" || t.state === "failed" || t.state === "blocked") break;
      }
      await sleep(900);
    }
  })().catch((err) => console.error("progress pump error:", err));

  const finished = await run.catch((err) => {
    console.error("task run error:", err);
    return null;
  });
  done = true;
  await pump;
  const t = await getTask(taskId);
  if (t) {
    // The final report is the one message that must not be lost to a single
    // transient failure; the retrying defaultSend backs it up in production.
    const final = formatFinal(t);
    if (sendFailures > 0) {
      await guardedSend(
        `${final}\n\n⚠️ ${sendFailures} live update(s) could not be delivered earlier; use /status ${shortId(taskId)} in case anything is missing.`,
      );
    } else {
      await guardedSend(final);
    }
  }
  void finished;
  sentEventIds = new Set(); // allow old runs to be GC'd cleanly
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Update handling                                                     */
/* ------------------------------------------------------------------ */

export async function handleUpdate(update: TgUpdate, deps: TelegramDeps = {}): Promise<void> {
  const engine = deps.engine ?? defaultDeps();
  const send = deps.send ?? defaultSend;
  const msg = update.message;
  const text = msg?.text?.trim();
  if (!msg || !text) return;

  // At-most-once: claim BEFORE handling so a redelivery can never double-spend.
  const isNewlyClaimed = await claimUpdate(update.update_id);
  if (!isNewlyClaimed) return; // duplicate update delivery — ignored

  const chatId = msg.chat.id;
  const sender = msg.from?.username ? `@${msg.from.username}` : String(msg.from?.id ?? "unknown");

  const missing = missingBotCredentials();
  if (missing.length) {
    await send(chatId, `Bot is not configured: missing ${missing.join(", ")} on the server.`);
    return;
  }

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();

  const telegraphMissing = missingPaidCredentials();
  const credentialNote = telegraphMissing.length
    ? `\n\n⚠️ Paid research is currently unavailable: ${telegraphMissing.join(", ")} is not configured on the server. Free research still works; explicit /paid goals would block at the purchase step (nothing is charged).`
    : "";

  switch (command) {
    case "/start":
    case "/help": {
      await send(chatId, HELP + credentialNote);
      return;
    }
    case "/goal": {
      if (!arg) {
        await send(chatId, "Usage: /goal <what you want done>");
        return;
      }
      let task: TaskRecord;
      try {
        task = await createTask(
          {
            goal: arg,
            spendLimitUsdCents: defaultSpendLimit(),
            requiresApproval: false,
            origin: { source: "telegram", actor: sender },
            // /goal is FREE by default, matching the web UI. A question with
            // no free capability is refused at creation; it can never become
            // a silent paid purchase.
            mode: "free",
          },
          engine,
        );
      } catch (err) {
        await send(chatId, `Could not create the task: ${err instanceof Error ? err.message : err}`);
        return;
      }
      await send(chatId, `Goal accepted [${shortId(task.id)}].`);

      if (task.state === "awaiting_approval") {
        await send(chatId, taskCard(task) + "\n\nThe plan waits for your approval, use /approve " + shortId(task.id));
        return;
      }
      if (task.state === "blocked") {
        // Execution goals and goals without a free capability arrive here
        // already stopped: state the limitation plainly (blocked tasks never
        // spend) instead of pretending or falling back to a paid purchase.
        await send(chatId, blockedReport(task));
        return;
      }
      await send(chatId, "Working on it.");
      await runWithProgress(task.id, chatId, engine, runEngineTask(task.id, engine), send);
      return;
    }
    case "/paid": {
      if (!arg) {
        await send(chatId, "Usage: /paid <what you want researched> — explicitly starts a PAID Telegraph research task (needs TELEGRAPH_EVM_PRIVATE_KEY) and waits for your /approve before anything is spent.");
        return;
      }
      let task: TaskRecord;
      try {
        task = await createTask(
          {
            goal: arg,
            spendLimitUsdCents: defaultSpendLimit(),
            // Explicit paid choice, double-gated: approval must confirm the
            // spend before any payment can be signed.
            requiresApproval: true,
            origin: { source: "telegram", actor: sender },
            mode: "paid",
          },
          engine,
        );
      } catch (err) {
        await send(chatId, `Could not create the task: ${err instanceof Error ? err.message : err}`);
        return;
      }
      await send(chatId, taskCard(task) + "\n\nThis is a PAID task awaiting your confirmation: /approve " + shortId(task.id) + " or /reject " + shortId(task.id));
      return;
    }
    case "/tasks": {
      const tasks = await listTasks();
      const mine = tasks.filter((t) => t.origin.source === "telegram" && t.origin.actor === sender).slice(0, 10);
      if (!mine.length) {
        await send(chatId, "No tasks yet. Submit one with /goal <text>.");
        return;
      }
      await send(chatId, mine.map(taskCard).join("\n\n"));
      return;
    }
    case "/status": {
      if (!arg) {
        await send(chatId, "Usage: /status <task id prefix>");
        return;
      }
      const task = findByPrefix(arg, await listTasks());
      if (!task) {
        await send(chatId, `No task matches "${arg}". Try /tasks.`);
        return;
      }
      await send(chatId, taskCard(task));
      return;
    }
    case "/approve":
    case "/reject": {
      if (!arg) {
        await send(chatId, `Usage: ${command} <task id prefix>`);
        return;
      }
      const task = findByPrefix(arg, await listTasks());
      if (!task) {
        await send(chatId, `No task matches "${arg}". Try /tasks.`);
        return;
      }
      if (task.state !== "awaiting_approval") {
        await send(
          chatId,
          `Task ${shortId(task.id)} is ${task.state}; only awaiting_approval tasks can be ${command.slice(1)}d.`,
        );
        return;
      }
      if (command === "/reject") {
        const rejected = await rejectTask(task.id, engine);
        await send(chatId, `Task ${shortId(rejected.id)} rejected. Nothing was spent.`);
        return;
      }
      await send(chatId, "Plan approved, executing.");
      await runWithProgress(task.id, chatId, engine, approveTask(task.id, engine), send);
      return;
    }
    default:
      await send(chatId, "Unknown command. Try /help.");
  }
}


