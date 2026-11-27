import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CircleAlert } from "lucide-react";

import { DeskWorkspace } from "@/components/desk/desk-workspace";
import { getDeskInvestigation } from "@/lib/desk/store";
import { getInvestigation } from "@/lib/assurance/store";
import { readOutcome } from "@/lib/api/bounded-read";

export const metadata: Metadata = {
  title: "Investigation file",
  description: "One specialised Deal Desk investigation: its evidence ledger with provenance, its runs and its report.",
};

export const dynamic = "force-dynamic";

/**
 * /desk/:id resolves by the record's actual stored type, never by an id
 * prefix: a Deal Desk investigation opens here; an Assurance settlement file
 * redirects to its own workspace at /assurance/:id; only an id that exists in
 * neither store is a 404. Old Assurance deep links keep working through the
 * redirect, and record contents stay gated by the identity-aware APIs.
 *
 * Reads are bounded and outcome-valued: a timed-out or rejected read is NOT a
 * 404 and NOT a crash — this page hung 30s+ in production on the cold-start
 * database path (probe + migrate ahead of the first query), so a slow read
 * now renders an honest retry state and a verified-null is the only 404.
 */
const READ_DEADLINE_MS = 20_000;

function ReadFailure({ what }: { what: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
      <div role="alert" className="rounded-xl border border-risk/30 bg-panel px-4 py-5 sm:px-6">
        <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <CircleAlert size={14} aria-hidden className="shrink-0 text-risk" />
          The {what} could not be read just now.
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
          The record store did not answer in time. Nothing was lost and nothing was invented — the file exists or it
          does not, and retrying answers that question.
        </p>
        <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
          <Link href="/desk" className="btn-primary !min-h-9 sm:w-auto">
            Back to the desk
          </Link>
          <Link href="/overview" className="btn-quiet !min-h-9 sm:w-auto">
            Overview
          </Link>
        </div>
      </div>
    </div>
  );
}

export default async function DeskCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const deskRead = await readOutcome(getDeskInvestigation(id), READ_DEADLINE_MS);
  if (deskRead.state === "failed") return <ReadFailure what="investigation file" />;
  if (deskRead.value) return <DeskWorkspace investigationId={id} />;

  const assuranceRead = await readOutcome(getInvestigation(id), READ_DEADLINE_MS);
  if (assuranceRead.state === "failed") return <ReadFailure what="settlement file" />;
  if (assuranceRead.value) redirect(`/assurance/${id}`);

  notFound();
}
