import { telegraphNodeUrl } from "@/lib/telegraph/client";
import CounterpartyClient, {
  type CounterpartyGuarantees,
} from "@/components/counterparty/counterparty-client";

export const metadata = { title: "Counterparty Intel" };
export const dynamic = "force-dynamic";

/**
 * B2B Counterparty Intelligence — the product flow over the Terminal's rails.
 * The user names a company (and jurisdiction); the node's unpaid pre-flight
 * prices the pinned CORPORATE_REGISTRY_LOOKUP_GENERAL ask at zk-corp-atlas;
 * the wallet pays only after an explicit offer approval; and the answer shown
 * is the hash-committed one, split into verified facts, missing fields and
 * disagreements.
 */
export default function CounterpartyPage() {
  const guarantees: CounterpartyGuarantees = {
    intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
    miner: "zk-corp-atlas",
    nodeUrl: telegraphNodeUrl(),
  };
  return <CounterpartyClient guarantees={guarantees} />;
}
