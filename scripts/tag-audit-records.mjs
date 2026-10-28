/**
 * Tags the task records created by the automated browser interaction audit
 * (scripts/audit-interactions.mjs) with a provenance label so they stay in
 * history but are never presented as ordinary user work.
 *
 * Nothing is deleted. Task states, spending, and pending approvals are left
 * exactly as they are; only `labels` gains a marker.
 *
 * Matching rule (deliberately narrow):
 *   origin.source === "web"
 *   && state is rejected or awaiting_approval
 *   && spend.spentUsdCents === 0
 *   && goal exactly matches one of the audit's own submission strings
 *   && createdAt within the audit window (2026-10-27 18:00-18:25 UTC)
 *
 * Legitimate records (funded web runs at 15:39-16:46, the gas workflow, and
 * every Telegram task) do not match this rule and are left untouched.
 *
 * Run: node scripts/tag-audit-records.mjs [--dry]
 */
import { promises as fs } from "node:fs";

const LABEL = "audit-rehearsal"; // keep in sync with src/components/taskParts.tsx
const AUDIT_GOALS = [
  "What is the current BTC price in USD?",
  "What is the current ETH price in USD?",
];
const WINDOW_START = new Date("2026-10-27T18:00:00Z").getTime();
const WINDOW_END = new Date("2026-10-27T18:25:00Z").getTime();

const file = process.env.NIGHTSHIFT_DATA_FILE || ".data/tasks.json";
const dry = process.argv.includes("--dry");

const raw = await fs.readFile(file, "utf8");
const tasks = JSON.parse(raw);

let tagged = 0;
for (const t of tasks) {
  const matches =
    t.origin?.source === "web" &&
    (t.state === "rejected" || t.state === "awaiting_approval") &&
    t.spend?.spentUsdCents === 0 &&
    AUDIT_GOALS.includes(t.goal) &&
    t.createdAt >= WINDOW_START &&
    t.createdAt <= WINDOW_END;
  if (!matches) continue;
  t.labels = [...new Set([...(t.labels ?? []), LABEL])];
  tagged += 1;
  console.log(`tag  ${t.state.padEnd(18)} ${String(t.createdAt)}  ${t.id}  ${t.goal.slice(0, 40)}`);
}

const changed = JSON.stringify(tasks, null, 2) !== raw;
if (!dry && changed) {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2));
  await fs.rename(tmp, file);
  console.log(`tagged ${tagged} record(s), written to ${file}`);
} else {
  console.log(`dry run: would tag ${tagged} record(s)`);
}
