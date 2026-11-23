import { telegraphNodeUrl } from "@/lib/telegraph/client";
import IndexDeskClient, { type IndexDeskGuarantees } from "@/components/indexdesk/index-desk-client";

export const metadata = { title: "Index Reconstitution Desk" };
export const dynamic = "force-dynamic";

/**
 * Minds · Index Reconstitution Desk — the first specialist Mind over the
 * network's market-data intents. The user declares an index universe and its
 * methodology; every askable dimension of every asset is probed for free
 * (live pricing), paid asks run only after the human approval gate, and the
 * proposal is deterministic — weights, exclusions, evidence and the
 * missing-dimension ledger are all reproducible from the recorded signals.
 */
export default function IndexDeskPage() {
  const guarantees: IndexDeskGuarantees = {
    nodeUrl: telegraphNodeUrl(),
    coverage: [
      { dimension: "Issuer registry record", intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL", miner: "zk-corp-atlas", price: "$0.01 / ask" },
      { dimension: "USD price", intent: "CRYPTO_PRICE_USD", miner: "cp-coinbase", price: "$0.01 / ask" },
      { dimension: "Total supply", intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", miner: "verifywire-token-total-supply", price: "$0.01 / ask" },
      { dimension: "DEX pool liquidity", intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL", miner: "verifywire-liquidity-depth", price: "$0.01 / ask" },
      { dimension: "Holder count", intent: "TOKEN_HOLDER_COUNT_GENERAL", miner: "router (no pin)", price: "$0.01 / ask" },
      { dimension: "Regulatory filings (12m)", intent: "REGULATORY_FILING_MONITOR_GENERAL", miner: "verireceipt", price: "$0.01 / ask" },
    ],
    notCovered: [
      "Circulating float — no network intent; declared inputs only",
      "Trading volumes — no network intent; declared inputs only",
    ],
  };
  return <IndexDeskClient guarantees={guarantees} />;
}
