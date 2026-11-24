import { MIND_STATUS_LABEL, type MindStatus } from "@/lib/minds/registry";

/** Shared status treatment for the catalogue and profiles. */
export const MIND_STATUS_TONE: Record<MindStatus, string> = {
  available: "border-teal/25 bg-teal/5 text-teal",
  in_development: "border-amber/40 bg-amber-soft/50 text-amber-deep",
  planned: "border-edge bg-panel-2 text-ink-faint",
};

const DOT: Record<MindStatus, string> = {
  available: "bg-teal",
  in_development: "bg-amber",
  planned: "bg-ink-faint/50",
};

export function MindStatusChip({ status }: { status: MindStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] ${MIND_STATUS_TONE[status]}`}
    >
      <span aria-hidden className={`size-1 rounded-full ${DOT[status]}`} />
      {MIND_STATUS_LABEL[status]}
    </span>
  );
}
