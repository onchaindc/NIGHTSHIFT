import type { TaskRecord } from "@/lib/engine/types";
import { mindBySlug } from "@/lib/minds/registry";

/**
 * The human label of whatever a task's paid entries bought, for spend
 * breakdowns ("where the money went"). Steps carry machine targets —
 * Minds capability runs embed a JSON config with the Mind slug, desk runs
 * embed the investigation config — and the raw JSON must never reach the
 * UI as a "name" (the budget strip once printed whole input objects as
 * line items). Unknown shapes degrade to a short, honest word.
 */
export function spendLabelForTask(task: TaskRecord): string {
  for (const step of task.plan ?? []) {
    if (!/^(capability|mind|index|counterparty|desk)_/.test(step.kind)) continue;
    const target = typeof step.target === "string" ? step.target.trim() : "";
    if (!target) continue;
    if (step.kind.startsWith("desk_")) return "Deal Desk";
    if (!target.startsWith("{")) {
      return truncateLabel(target);
    }
    try {
      const parsed = JSON.parse(target) as { slug?: unknown; type?: unknown };
      if (typeof parsed.slug === "string" && parsed.slug.trim()) {
        const mind = mindBySlug(parsed.slug.trim());
        return truncateLabel(mind?.name ?? parsed.slug.trim());
      }
      if (typeof parsed.type === "string" && parsed.type.trim()) {
        return truncateLabel(parsed.type.trim());
      }
    } catch {
      /* not JSON after all — fall through to the truncation */
    }
    return truncateLabel(target);
  }
  if (task.jobType === "protocol_watch") return "Protocol Watch";
  if (task.jobType === "terminal_request") return "Terminal";
  return "Other";
}

function truncateLabel(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}
