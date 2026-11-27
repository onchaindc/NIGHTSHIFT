import type { Metadata } from "next";

import { AssuranceIndex } from "@/components/assurance/assurance-index";

export const metadata: Metadata = {
  title: "Assurance",
  description:
    "Investigate a high-value transaction before settlement: counterparties, ownership, sanctions exposure, documents and the authorization decision.",
};

export const dynamic = "force-dynamic";

export default function AssurancePage() {
  return <AssuranceIndex />;
}
