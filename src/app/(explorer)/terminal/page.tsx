import { fetchIntents } from "@/lib/explorer/network";
import { paidCredentialsConfigured, telegraphNodeUrl } from "@/lib/telegraph/client";
import { payerAddress } from "@/lib/terminal/ask";
import TerminalClient, { type TerminalIntentSummary } from "@/components/terminal/terminal-client";

export const metadata = { title: "Terminal" };
export const dynamic = "force-dynamic";

/**
 * The interactive Terminal (Phase 2). The node's intent registry supplies the
 * guided compose picker; the payment flow itself runs through the terminal
 * API routes, which never sign anything without an explicit, offer-pinned
 * user approval.
 */
export default async function TerminalPage({ searchParams }: { searchParams: Promise<{ intent?: string; miner?: string }> }) {
  const { intent, miner } = await searchParams;
  const fetched = await fetchIntents();
  const intents: TerminalIntentSummary[] =
    fetched.status === "ok"
      ? fetched.payload
          .filter((i) => i.intent_name)
          .map((i) => ({
            intent: i.intent_name!,
            minerCount: i.miner_count,
            description: (i.description ?? "").slice(0, 240),
          }))
      : [];

  return (
    <TerminalClient
      intents={intents}
      wallet={{ configured: paidCredentialsConfigured(), address: payerAddress() }}
      initialIntent={intent?.toUpperCase()}
      initialMiner={miner}
      nodeUrl={telegraphNodeUrl()}
    />
  );
}
