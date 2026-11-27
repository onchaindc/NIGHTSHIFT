"use client";

/**
 * The buyer's introductory purchases — every record on the internal credit
 * rail with its honest settlement note: what was bought for $0.01, what
 * artifact it produced, and the fact that no wallet signature was requested.
 */

import { formatUsdc, usdcBaseUnits } from "@/lib/acp/buyer-browser";
import { COMMERCE_SECTION_LABEL, type CommerceJob } from "@/lib/commerce/types";
import { EmptyNote, MicroHeading, Panel, StateChip } from "./ui-bits";

export function CommerceJobs({ jobs }: { jobs: CommerceJob[] }) {
  if (jobs.length === 0) {
    return <EmptyNote>No purchases yet — the four introductory offerings settle internally at $0.01 each.</EmptyNote>;
  }
  return (
    <div className="space-y-2.5">
      <MicroHeading>Your purchases — internal credit rail</MicroHeading>
      {jobs.map((j) => (
        <Panel key={j.id} className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip tone={j.status === "fulfilled" ? "teal" : "risk"}>{j.status}</StateChip>
            <span className="tabular text-[11px] text-ink-faint">{COMMERCE_SECTION_LABEL[j.section]}</span>
            <span className="tabular ml-auto text-[12px] font-semibold text-teal">{formatUsdc(usdcBaseUnits(j.priceUsdCents))}</span>
          </div>
          {j.deliverable ? (
            <>
              <p className="text-[12.5px] font-medium leading-snug text-ink">{j.deliverable.title}</p>
              <p className="text-[12px] leading-relaxed text-ink-soft">{j.deliverable.detail}</p>
              {j.deliverable.artifactReference && (
                <p className="tabular text-[11px] text-ink-faint">artifact {j.deliverable.artifactReference}</p>
              )}
            </>
          ) : (
            <p className="text-[12px] leading-relaxed text-risk">{j.settlementNote}</p>
          )}
          <p className="text-[11px] leading-relaxed text-ink-faint">{j.settlementNote}</p>
        </Panel>
      ))}
    </div>
  );
}
