import type { Metadata } from "next";

import { AssuranceWorkspace } from "@/components/assurance/assurance-workspace";

export const metadata: Metadata = {
  title: "Transaction investigation",
  description: "One transaction, its evidence, its assessment and its authorization decision.",
};

export const dynamic = "force-dynamic";

export default async function AssuranceInvestigationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AssuranceWorkspace investigationId={id} />;
}
