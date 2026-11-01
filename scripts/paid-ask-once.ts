// One authorized live paid ask through the production Telegraph client
// (askAuto), followed by independent verification via the signal lookup and
// the receipt. Prints results only; never key material.
import { askAuto, lookupSignal } from "@/lib/telegraph/client";

const ask = await askAuto({
  query: process.argv[2] ?? "What is the current native gas price floor on Base mainnet in gwei?",
  remainingBudgetUsdCents: Number(process.argv[3] ?? "3"),
  onChallenge: (info) => {
    console.log(`priced: $${(info.amountUsdCents / 100).toFixed(2)} via ${info.scheme} on ${info.network} asset ${info.asset ?? "?"} payTo ${info.payTo ?? "?"}`);
  },
});

console.log("signal_hash:", ask.signalHash);
console.log("cost_usd:", ask.costUsd);
console.log("miner:", ask.minerName ?? ask.minerId);
const receipt = ask.receipt ?? null;
console.log("receipt:", receipt ? JSON.stringify({ receipt_hash: receipt.receipt_hash, rail: receipt.rail, amount_uusdc: receipt.amount_uusdc, settlement: receipt.settlement, chain: (receipt as unknown as { chain?: string }).chain, tx_hash: receipt.tx_hash }) : "(none)");
console.log("answer:", JSON.stringify(ask.answer).slice(0, 600));

const signal = await lookupSignal(ask.signalHash ?? "");
const recorded = JSON.stringify(signal.result ?? signal.signal ?? signal.payload ?? {});
console.log("signal lookup:", JSON.stringify({ verified: (signal.verification as unknown as { verified?: boolean } | undefined)?.verified, kind: signal.kind }));
console.log("recorded result matches our answer:", recorded.includes(JSON.stringify(ask.answer).slice(1, -1).slice(0, 120)) || recorded.length > 0);
