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
import type { TaskRecord } from "@/lib/engine/types";

const API_BASE = "https://api.telegram.org";

export const missingBotCredentials = () => {
  const keys = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) keys.push("TELEGRAM_BOT_TOKEN");
  return keys;
};

interface SendFn {
  (chatId: string | number, text: string): Promise<void>;
}

async function defaultSend(chatId: string | number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }), // plain text: no escaping foot-guns
  });
  if (!res.ok) {
    // Bot API errors are best-effort: a task's outcome matters more than the
    // notification failing, so we log and continue rather than throw.
    const body = await res.text().catch(() => "");
    console.error(`telegram sendMessage failed: HTTP ${res.status} ${body}`);
  }
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

/* ------------------------------------------------------------------ */

const HELP = [
  "NIGHTSHIFT, until the work is done.",
  "",
  "Commands:",
  "/goal <text> submit a goal for autonomous execution",
  "/tasks list your recent goals",
  "/status <id-prefix> show one task in detail",
  "/approve <id-prefix> approve a plan awaiting approval",
  "/reject <id-prefix> reject a plan awaiting approval",
  "",
  "Every purchase is checked against the task's spending limit and the",
  "network's actual 402 price before any payment is signed. Approval-gated",
  "goals stay awaiting_approval until you approve them here (or in the web app).",
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
  if (last) lines.push(`Last event: ${last.message}`);
  if (t.error) lines.push(`Error: ${t.error}`);
  if (t.state === "awaiting_approval") lines.push("→ use /approve " + shortId(t.id) + " or /reject " + shortId(t.id));
  return lines.join("\n");
}

function findByPrefix(prefix: string, tasks: TaskRecord[]): TaskRecord | undefined {
  return tasks.find((t) => t.id.startsWith(prefix)) ?? tasks[0];
}

export function statusSummary(t: TaskRecord): string {
  return taskCard(t);
}

function formatFinal(t: TaskRecord): string {
  const lines: string[] = [];
  if (t.state === "completed") {
    // The completion claim states exactly what kind of deliverable was
    // verified. Execution goals can never reach this branch: they always lack
    // external-action evidence, so no claim is ever restated here.
    const intent = t.criteria.goalIntent ?? "information";
    lines.push(
      intent === "preparation"
        ? "✅ Completed: preparation material produced. The action itself was NOT executed by NIGHTSHIFT, and external execution remains unverified."
        : "✅ Completed: informational answer delivered, verified against recorded evidence. No external action was performed or implied.",
    );
  } else {
    lines.push(`${t.state.toUpperCase()}: ${t.error ?? ""}`.trim());
    // Failed or partial work reports its actual state, spend and unresolved
    // criteria rather than a generic success line.
    const unmet = t.events.filter((e) => e.type === "criteria_failed").map((e) => `- ${e.message}`);
    if (unmet.length) {
      lines.push("");
      lines.push("Unresolved criteria:");
      lines.push(...unmet);
    }
    if (t.spend.spentUsdCents > 0 && !t.result) {
      lines.push("Purchases were made during the attempt, but no outcome was verified as meeting the goal.");
    }
  }
  lines.push(`Spent: $${(t.spend.spentUsdCents / 100).toFixed(2)} (limit $${(t.spend.limitUsdCents / 100).toFixed(2)})`);
  if (t.result) {
    lines.push("");
    lines.push("Result:");
    lines.push(t.result.summary.slice(0, 2800));
    lines.push("");
    for (const ev of t.result.evidence) {
      if (ev.kind === "telegraph_signal") lines.push(`Evidence: signal ${ev.signalHash}`);
      if (ev.kind === "telegraph_receipt")
        lines.push(`Evidence: receipt ${ev.receiptHash}${ev.txHash ? ` (tx ${ev.txHash.slice(0, 18)}…)` : ""}`);
      if (ev.kind === "on_chain_settlement")
        lines.push(`Evidence: settlement ${ev.txHash.slice(0, 18)}… status ${ev.status} at block ${ev.blockNumber}`);
      if (ev.kind === "chain_gas_crosscheck")
        lines.push(
          `Evidence: cross-check ${ev.answerGasGwei} vs ${ev.chainGasGwei.toFixed(6)} gwei (${ev.chain}), ${ev.agreed ? "agree" : "disagree"}`,
        );
      if (ev.kind === "watch_finding")
        lines.push(
          `Evidence: ${ev.findingKind} from "${ev.sourceLabel}" (confidence ${ev.confidence}${ev.corroboratedBy?.length ? `, corroborated by ${ev.corroboratedBy.join(", ")}` : ""})${ev.url ? ` ${ev.url}` : ""}`,
        );
    }
  }
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
 * Runs the engine task asynchronously while pumping new timeline events to
 * the chat, then sends the final report. The engine stays unchanged (it has
 * no transport code); this polls the persisted task record.
 */
async function runWithProgress(
  taskId: string,
  chatId: string | number,
  engine: EngineDeps,
  run: Promise<TaskRecord>,
  send: SendFn,
): Promise<void> {
  let sentEventIds = new Set<string>();
  let done = false;
  const pump = (async () => {
    while (!done) {
      const t = await getTask(taskId);
      if (t) {
        for (const e of t.events) {
          if (sentEventIds.has(e.id)) continue;
          sentEventIds.add(e.id);
          const icon = EVENT_ICON[e.type] ?? "·";
          await send(chatId, `${icon} ${e.message}`.slice(0, 3800));
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
  await getTask(taskId).then((t) => t && send(chatId, formatFinal(t)));
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
    ? `\n\n⚠️ Paid intelligence is currently unavailable: ${telegraphMissing.join(", ")} is not configured on the server. Goals will be blocked at the purchase step (nothing is charged).`
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
        // Execution goals arrive here already stopped: state the limitation
        // plainly instead of pretending to "work on it".
        await send(chatId, taskCard(task));
        return;
      }
      await send(chatId, "Working on it, live updates follow.");
      await runWithProgress(task.id, chatId, engine, runEngineTask(task.id, engine), send);
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
      await send(chatId, "Plan approved, executing, live updates follow.");
      await runWithProgress(task.id, chatId, engine, approveTask(task.id, engine), send);
      return;
    }
    default:
      await send(chatId, "Unknown command. Try /help.");
  }
}


