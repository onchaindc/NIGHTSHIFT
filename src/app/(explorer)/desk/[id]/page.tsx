import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DeskWorkspace } from "@/components/desk/desk-workspace";
import { getDeskInvestigation } from "@/lib/desk/store";
import { getInvestigation } from "@/lib/assurance/store";

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
 */
export default async function DeskCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const deskRecord = await getDeskInvestigation(id).catch(() => null);
  if (deskRecord) return <DeskWorkspace investigationId={id} />;

  const assuranceRecord = await getInvestigation(id).catch(() => null);
  if (assuranceRecord) redirect(`/assurance/${id}`);

  notFound();
}
