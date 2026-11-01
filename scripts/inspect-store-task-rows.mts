/**
 * One-off diagnostic: read task rows via the app's own persistence module and
 * find records where a display-normalizer assumed field is undefined. Run with
 * the project env already loaded: bun scripts/inspect-store-task-rows.mts
 */
import { listTasks } from "../src/lib/engine/store";

const rows = await listTasks();
console.log("rows:", rows.length);
for (const d of rows) {
  const bad: string[] = [];
  if (d?.goal == null) bad.push("goal");
  for (const e of d?.events ?? []) if (e?.message == null) bad.push(`ev:${e?.type}`);
  if (d?.spend == null) bad.push("spend");
  else for (const e of d.spend.entries ?? []) if (e?.description == null) bad.push("entry:" + JSON.stringify(e)?.slice(0, 60));
  if (d?.result != null && d.result.summary == null) bad.push("summary");
  const idStr: string = typeof d?.id === "string" ? d.id : JSON.stringify(d)?.slice(0, 24) ?? "?";
  if (bad.length) console.log(idStr.slice(0, 12), d?.state, bad.join(","));
}
