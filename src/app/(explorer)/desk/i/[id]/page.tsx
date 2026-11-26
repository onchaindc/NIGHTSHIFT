import type { Metadata } from "next";

import { DeskWorkspace } from "@/components/desk/desk-workspace";

export const metadata: Metadata = {
  title: "Investigation file",
  description: "One specialised Deal Desk investigation: its evidence ledger with provenance, its runs and its report.",
};

export const dynamic = "force-dynamic";

export default async function DeskInvestigationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeskWorkspace investigationId={id} />;
}
