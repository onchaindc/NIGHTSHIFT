/**
 * One-off live probe: buys a real ONCHAIN_TX_LOOKUP via the query route
 * so NIGHTSHIFT's verifier is written against the ACTUAL response shape.
 * Costs real test USDC (~$0.01). Prints no secrets.
 * Run: node scripts/probe-tx-lookup.mjs <tx_hash>
 *
 * The free 402 probe showed the typed {intent, params} body is NOT processed
 * by the paid retry (400 "invalid request body"), so the engine's natural
 * language {query} route is used — the engine classifies it to the lookup miner.
 */
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const txHash = process.argv[2];
if (!txHash) {
  console.error("usage: node scripts/probe-tx-lookup.mjs <tx_hash>");
  process.exit(1);
}

const account = privateKeyToAccount(process.env.TELEGRAPH_EVM_PRIVATE_KEY);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
});
const node = (process.env.TELEGRAPH_NODE_URL || "https://devnode.telegraphprotocol.com").replace(/\/+$/, "");

const query = `Transaction ${txHash} on Base: was it confirmed or reverted, what is its status, block number and did it succeed?`;
const res = await fetchWithPayment(`${node}/engine/v1/ask`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query }),
});

console.log("HTTP", res.status);
const body = await res.json().catch(() => null);
console.log("BODY:", JSON.stringify(body, null, 2).slice(0, 3000));
const receipt = res.headers.get("x-telegraph-receipt");
if (receipt) {
  console.log(
    "RECEIPT:",
    JSON.stringify(JSON.parse(Buffer.from(receipt, "base64").toString()), null, 2).slice(0, 900),
  );
}
const hash = body?.signal_hash;
if (hash) {
  const sig = await fetch(`${node}/engine/v1/signal/${hash}`).then((r) => r.json());
  console.log("SIGNAL RESULT:", JSON.stringify(sig.result, null, 2).slice(0, 2600));
}
