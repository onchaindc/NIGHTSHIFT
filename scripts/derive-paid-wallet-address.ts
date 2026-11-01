// One-off funding helper: derives ONLY the public address of the paid-research
// wallet from the private key loaded by the runtime environment. Never prints
// or logs any key material.
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.TELEGRAPH_EVM_PRIVATE_KEY;
if (!key || key.trim().length < 32) {
  console.log("NO_KEY_IN_THIS_ENVIRONMENT");
  process.exit(0);
}
const normalized = key.trim().startsWith("0x") ? key.trim() : `0x${key.trim()}`;
try {
  const acct = privateKeyToAccount(normalized as `0x${string}`);
  console.log("ADDRESS:", acct.address);
} catch (err) {
  console.log("MALFORMED_KEY");
}
