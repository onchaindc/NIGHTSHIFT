import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DeskForm } from "@/components/desk/desk-form";
import { deskWorkflow, describeDeskWorkflow } from "@/lib/desk/workflows";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ type?: string }> }): Promise<Metadata> {
  const { type } = await searchParams;
  const workflow = type ? deskWorkflow(type) : undefined;
  return {
    title: workflow ? `New ${workflow.name} file` : "New investigation file",
    description: workflow ? workflow.scope : "Open a specialised Deal Desk investigation file.",
  };
}

export default async function NewDeskInvestigationPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  if (!type || !deskWorkflow(type)) notFound();
  return <DeskForm workflow={describeDeskWorkflow(type as Parameters<typeof describeDeskWorkflow>[0])} />;
}
