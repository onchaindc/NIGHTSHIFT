import type { Metadata } from "next";

import { AssuranceIndex } from "@/components/assurance/assurance-index";

export const metadata: Metadata = {
  title: "Deal Desk",
  description:
    "Institutional transaction intelligence: investigate a counterparty, its standing and its payment rails before a high-value settlement — one decision, every finding cited.",
};

export const dynamic = "force-dynamic";

export default function DealDeskPage() {
  return <AssuranceIndex />;
}
