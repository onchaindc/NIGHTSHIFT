/**
 * Wallet readiness check for NIGHTSHIFT's Telegraph x402 purchases.
 * Reads the payment key ONLY from the server-side environment (loaded from
 * .env.local). Prints the derived address and balances — never the key.
 * Run: node scripts/check-wallet.mjs
 */
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.TELEGRAPH_CHECK_RPC_URL || "https://sepolia.base.org";
const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (docs.telegraphprotocol.com)

const key = process.env.TELEGRAPH_EVM_PRIVATE_KEY;
if (!key) {
  console.log("TELEGRAPH_EVM_PRIVATE_KEY: NOT SET");
  process.exit(2);
}
console.log("TELEGRAPH_EVM_PRIVATE_KEY: set ✓");

let account;
try {
  account = privateKeyToAccount(key);
} catch (err) {
  console.log("key is present but not a valid private key:", err.message);
  process.exit(1);
}
console.log("derived address:", account.address);

const rpc = (method, params) =>
  fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

const [ethRes, usdcRes] = await Promise.all([
  rpc("eth_getBalance", [account.address, "latest"]),
  rpc("eth_call", [
    { to: TESTNET_USDC, data: "0x70a08231" + account.address.replace(/^0x/, "").padStart(64, "0") },
    "latest",
  ]),
]);

if (ethRes.error || usdcRes.error) {
  console.log("RPC error:", JSON.stringify(ethRes.error || usdcRes.error));
  process.exit(1);
}

console.log("native ETH balance:", (Number(BigInt(ethRes.result)) / 1e18).toFixed(10));
console.log("test USDC balance:", (Number(BigInt(usdcRes.result)) / 1e6).toFixed(6));
