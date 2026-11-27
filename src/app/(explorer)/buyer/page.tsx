import type { Metadata } from "next";

import { BuyerDesk } from "@/components/buyer/buyer-desk";

export const metadata: Metadata = {
  title: "Buyer Desk",
  description:
    "Buy NIGHTSHIFT intelligence on the Virtuals Agent Commerce Protocol: published services, on-chain escrow on Base, your wallet, evidence-backed reports.",
};

export default function BuyerDeskPage() {
  return (
    <div className="bg-night">
      <BuyerDesk />
    </div>
  );
}
