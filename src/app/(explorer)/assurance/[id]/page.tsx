import { redirect } from "next/navigation";

/** Old deep links keep working: the file moved to the Deal Desk. */
export default async function AssuranceInvestigationRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/desk/${id}`);
}
