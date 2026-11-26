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

/** Report dimension statuses (run consoles): what became of each committed answer. */
export const REPORT_STATUS_DOT: Record<string, string> = {
  verified: "bg-teal",
  recorded: "bg-amber",
  unverified: "bg-risk",
  routable_unverified: "bg-ink-faint/40",
  gap: "bg-ink-faint/40",
};

export const REPORT_STATUS_WORD: Record<string, string> = {
  verified: "Verified",
  recorded: "Recorded",
  unverified: "Unverified",
  routable_unverified: "Routable, unverified",
  gap: "Unsupported",
};

/** Probe statuses (catalogue and profile pages): what the unpaid matrix probe found. */
export const PROBE_STATUS_DOT: Record<string, string> = {
  verified: "bg-teal",
  partial: "bg-amber",
  gap: "bg-ink-faint/40",
};

export const PROBE_STATUS_WORD: Record<string, string> = {
  verified: "Route verified",
  partial: "Partial",
  gap: "Unsupported",
};
