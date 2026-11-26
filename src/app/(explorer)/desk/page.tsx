import type { Metadata } from "next";

import { AssuranceIndex } from "@/components/assurance/assurance-index";
import { DeskEntry } from "@/components/desk/desk-entry";
import { DESK_TYPE_ORDER, describeDeskWorkflow } from "@/lib/desk/workflows";

export const metadata: Metadata = {
  title: "Deal Desk",
  description:
    "The Deal Desk is the entry point for four specialised investigation workflows: Counterparty Due Diligence, Asset Intelligence, Trade & Supplier Intelligence and Listing Underwriter — one evidence engine, explicit provenance, named gaps.",
};

export const dynamic = "force-dynamic";

export default function DealDeskPage() {
  const workflows = DESK_TYPE_ORDER.map((type) => describeDeskWorkflow(type));
  return (
    <>
      <DeskEntry workflows={workflows} />
      {/* The original settlement-assurance deal-file flow, preserved as-is. */}
      <AssuranceIndex />
    </>
  );
}
