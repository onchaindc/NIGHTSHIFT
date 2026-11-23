// One-off funding helper for the paid-research wallet: mints the Telegraph
// Sepolia test token (per the documented mint in the x402 docs page) so the
// wallet can cover signed EIP-3009 transfers. Uses the key loaded by the
// runtime environment only; never prints or logs key material.
//
// Usage: bun scripts/fund-paid-wallet.ts [amount]  (default 10000000 = 10 whole units, 6 decimals)
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const TOKEN = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"]);

const key = process.env.TELEGRAPH_EVM_PRIVATE_KEY;
if (!key || key.trim().length < 32) {
  console.log("NO_KEY_IN_THIS_ENVIRONMENT");
  process.exit(0);
}
const account = privateKeyToAccount((key.trim().startsWith("0x") ? key.trim() : `0x${key.trim()}`) as `0x${string}`);
console.log("wallet:", account.address);

const amount = BigInt(process.argv[2] ?? "10000000");
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

const balanceBefore = await publicClient.readContract({ address: TOKEN, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] });
console.log("balance before (atomic):", balanceBefore.toString());
if (balanceBefore >= amount) {
  console.log("ALREADY_FUNDED: no transaction needed");
  process.exit(0);
}

const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) });
const hash = await walletClient.sendTransaction({
  to: TOKEN,
  data: encodeFunctionData({ abi: MINT_ABI, functionName: "mint", args: [account.address, amount] }),
});
console.log("tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log("status:", receipt.status === "success" ? "success" : "FAILED");
const balanceAfter = await publicClient.readContract({ address: TOKEN, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] });
console.log("balance after (atomic):", balanceAfter.toString(), `= ${Number(balanceAfter) / 1e6} whole units`);
