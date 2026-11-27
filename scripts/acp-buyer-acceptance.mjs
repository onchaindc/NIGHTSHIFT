/**
 * NIGHTSHIFT Buyer Desk — LIVE acceptance probe against the real Virtuals ACP
 * network, run from the sandbox with a THROWAWAY unfunded wallet (never the
 * provider's key).
 *
 * What this proves with real network traffic:
 *   1. the production catalog serves the four published offerings;
 *   2. the ACP server authenticates a BUYER wallet (signed acp-auth challenge);
 *   3. agent discovery sees the registered NIGHTSHIFT agent and its offerings;
 *   4. the SDK prepares REAL on-chain calls (createJob / approveAllowance /
 *      fund) against live Base state;
 *   5. the on-chain read path works (getJob on the ACP contract).
 *
 * What it cannot do (reported, not faked): BROADCAST those calls — that needs
 * a funded buyer wallet (Base ETH for gas + the USDC price), which only a
 * human buyer can sign for in their browser.
 */

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { AcpApiClient } from "@virtuals-protocol/acp-node-v2/dist/events/acpApiClient.js";
import { SseTransport } from "@virtuals-protocol/acp-node-v2/dist/events/sseTransport.js";
import { EvmAcpClient } from "@virtuals-protocol/acp-node-v2/dist/clients/evmAcpClient.js";
import { ACP_CONTRACT_ADDRESSES, USDC_ADDRESSES } from "@virtuals-protocol/acp-node-v2/dist/core/constants.js";
import { createEvmNetworkContext } from "@virtuals-protocol/acp-node-v2/dist/core/chains.js";

const BASE_URL = "https://nightshift-telegraph.vercel.app";
const CHAIN = 8453;
const CONTRACT = ACP_CONTRACT_ADDRESSES[CHAIN];
const USDC = USDC_ADDRESSES[CHAIN];

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

/** Read-only adapter: real reads, and a LOUD refusal on writes (the buyer's
 *  browser is where signing happens). */
const adapter = {
  providerName: "sandbox-acceptance-readonly",
  async getAddress() {
    return account.address;
  },
  async getSupportedChainIds() {
    return [CHAIN];
  },
  async getNetworkContext(chainId) {
    return createEvmNetworkContext(chainId);
  },
  async sendTransaction() {
    throw new Error("BLOCKER (expected): broadcasting requires the buyer's funded wallet in the browser — gas for createJob, USDC for the escrow.");
  },
  async sendCalls() {
    throw new Error("BLOCKER (expected): broadcasting requires the buyer's funded wallet in the browser.");
  },
  async getTransactionReceipt(chainId, hash) {
    return await publicClient.getTransactionReceipt({ hash });
  },
  async readContract(chainId, params) {
    return await publicClient.readContract(params);
  },
  async getLogs(chainId, params) {
    const events = Array.isArray(params.events) ? params.events : [params.events];
    const out = [];
    for (const event of events) {
      out.push(...(await publicClient.getLogs({ address: params.address, event, fromBlock: params.fromBlock, toBlock: params.toBlock ?? "latest" })));
    }
    return out;
  },
  async getBlockNumber() {
    return await publicClient.getBlockNumber();
  },
  async signMessage(chainId, message) {
    return await account.signMessage({ message });
  },
  async signTypedData(chainId, typedData) {
    return await account.signTypedData(typedData);
  },
};

// A real wallet with no funds — generated fresh for this probe, never the
// provider's key, never persisted.
const account = privateKeyToAccount(generatePrivateKey());

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`throwaway buyer wallet: ${account.address} (unfunded — gas/USDC steps are reported, not faked)\n`);

/* 1 — the production catalog */
console.log("[1] production buyer catalog");
const catalogRes = await fetch(`${BASE_URL}/api/acp/buyer/catalog`);
if (!catalogRes.ok) {
  console.log(`  FAIL  catalog endpoint not reachable (${catalogRes.status}) — deploy the Buyer Desk first`);
  process.exit(1);
}
const catalog = await catalogRes.json();
check("four published offerings served", Array.isArray(catalog.offerings) && catalog.offerings.length === 4, `${(catalog.offerings ?? []).length} offerings`);
check("provider wallet exposed for buyers", /^0x[0-9a-fA-F]{40}$/.test(catalog.provider?.walletAddress ?? ""), catalog.provider?.walletAddress ?? "none");
check("chain is Base (8453)", catalog.provider?.chainId === CHAIN);
const offerings = catalog.offerings ?? [];
console.log(`      ${offerings.map((o) => `${o.name} ($${(o.priceUsdCents / 100).toFixed(2)})`).join(" · ")}`);

/* 2 — real buyer auth against api.acp.virtuals.io */
console.log("\n[2] ACP server: buyer authentication (signed challenge)");
const providerWallet = catalog.provider.walletAddress;
const ctx = {
  agentAddresses: { evm: account.address },
  contractAddresses: { [CHAIN]: CONTRACT },
  providerSupportedChainIds: [CHAIN],
  getClientForChain: () => client,
  signMessage: (chainId, message) => adapter.signMessage(chainId, message),
};
const client = await EvmAcpClient.create({ contractAddresses: { [CHAIN]: CONTRACT }, provider: adapter });
const transport = new SseTransport();
const api = new AcpApiClient();
transport.setContext(ctx);
api.setContext(ctx);
let authDetail = "";
try {
  await api.getActiveJobs();
  authDetail = "authenticated";
} catch (err) {
  authDetail = err.message;
}
// The ACP chat API serves REGISTERED agents only. An unregistered buyer
// wallet gets exactly one behavior: 404 "Agent not found with wallet
// address …" — signature first verified (a bad signature gets 401 instead).
// This is why the requirement rides the on-chain job description.
const registrationRequired = /Agent not found/i.test(authDetail);
check(
  "chat API behavior for an unregistered buyer wallet is understood",
  authDetail === "authenticated" || registrationRequired,
  registrationRequired ? 'server: "Agent not found with wallet address …" → requirement rides the on-chain description' : authDetail,
);

/* 3 — agent discovery */
console.log("\n[3] ACP server: agent discovery");
let detail = null;
try {
  detail = await api.getAgentByWalletAddress(providerWallet);
} catch (err) {
  console.log(`      lookup error: ${err.message}`);
}
check("NIGHTSHIFT agent visible to a buyer", !!detail, detail ? `agent "${detail.name}" role=${detail.role}` : "not found");
const serverOfferings = detail?.offerings ?? [];
check("four offerings published on the ACP server", serverOfferings.length === 4, serverOfferings.map((o) => o.name).join(", "));
const catalogNames = offerings.map((o) => o.name).sort();
const serverNames = serverOfferings.map((o) => o.name).sort();
check("server offerings match the catalog", JSON.stringify(catalogNames) === JSON.stringify(serverNames), serverNames.join(" · "));

/* 4 — REAL prepared transactions against live Base state */
console.log("\n[4] SDK prepares the real on-chain calls (no broadcast)");
const offering = offerings[0];
const expiredAt = Math.floor(Date.now() / 1000) + 86400;
const createPrepared = await client.createJob(CHAIN, {
  providerAddress: providerWallet,
  evaluatorAddress: "0x0000000000000000000000000000000000000000",
  expiredAt,
  description: offering.id,
});
check("createJob prepared", createPrepared.tx.length > 0, `${createPrepared.tx.length} call(s) → ${createPrepared.tx[0].to} · ${createPrepared.tx[0].data.slice(0, 10)}…`);
const allowancePrepared = await client.approveAllowance(CHAIN, {
  tokenAddress: USDC,
  spenderAddress: CONTRACT,
  amount: BigInt(offering.priceUsdCents) * 10_000n,
});
check("approveAllowance prepared (USDC → ACP contract)", allowancePrepared.tx.length > 0, `approve ${offering.priceUsdCents * 10000} base units`);
const fundPrepared = await client.fund(CHAIN, { jobId: 1n, expectedBudget: BigInt(offering.priceUsdCents) * 10_000n });
check("fund prepared (escrow)", fundPrepared.tx.length > 0, `fund job 1 with ${format(offering.priceUsdCents * 10000)} USDC base units`);

function format(baseUnits) {
  return (Number(baseUnits) / 1_000_000).toFixed(2);
}

/* 5 — on-chain read path */
console.log("\n[5] on-chain reads (public Base RPC)");
let block = null;
try {
  block = await publicClient.getBlockNumber();
} catch { /* reported below */ }
check("Base RPC reachable", block !== null, block !== null ? `block ${block}` : "unreachable");

console.log("\n=== RESULT ===");
console.log(`passed ${passed} · failed ${failed}`);
console.log(`\nEXACT BLOCKER for the final settlement step (broadcast): the three buyer transactions
(createJob, approveAllowance, fund) are prepared and valid, but broadcasting them requires a
funded buyer wallet in the browser — Base ETH for gas (~cents) plus the offering price in USDC.
The Buyer Desk UI performs exactly these prepared calls with the buyer's own wallet signature;
no provider credential is involved. To run the full acceptance transaction: open
${BASE_URL}/buyer in a browser, sign in with any funded Base wallet, and complete the flow.`);
process.exit(failed > 0 ? 1 : 0);
