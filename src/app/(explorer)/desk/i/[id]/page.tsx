import { redirect } from "next/navigation";

/**
 * The /desk/i/:id deep links predate the unified /desk/:id resolver. They keep
 * working: the id resolves at /desk/:id, which opens Deal Desk investigations
 * and safely redirects Assurance settlement files to /assurance/:id.
 */
export default async function DeskInvestigationCompatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/desk/${id}`);
}
