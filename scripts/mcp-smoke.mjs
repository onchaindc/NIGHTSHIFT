#!/usr/bin/env node
/**
 * Real local MCP protocol test for the NIGHTSHIFT MCP endpoint.
 *
 * Prerequisites (run from the repository root):
 *   npm run build
 *   NIGHTSHIFT_API_TOKEN=<token> npx next start -p 3100   # separate shell
 *   NIGHTSHIFT_MCP_URL=http://localhost:3100/api/mcp node scripts/mcp-smoke.mjs
 *
 * Optional env:
 *   NIGHTSHIFT_API_TOKEN   — set it here too to exercise operator-clearance
 *                            tools (paid request creation; still approval-gated).
 *   NIGHTSHIFT_MCP_URL     — endpoint (default http://localhost:3100/api/mcp).
 *
 * What it does: connects a REAL MCP client over Streamable HTTP, completes
 * the initialize handshake, lists tools, and invokes representative
 * discovery and free-investigation tools against the running server.
 * Exit code 0 = every step verified.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_BASE = process.env.NIGHTSHIFT_MCP_URL ?? "http://localhost:3100/api/mcp";
const TOKEN = process.env.NIGHTSHIFT_API_TOKEN;

const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args ?? {} });
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "{}";
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { result, parsed };
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(URL_BASE), {
    requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
  });
  const client = new Client({ name: "nightshift-mcp-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);
    const version = client.getServerVersion();
    record("initialize handshake", version?.name === "nightshift", JSON.stringify(version ?? {}));

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = [
      "nightshift_create_free_investigation",
      "nightshift_get_mind_coverage",
      "nightshift_get_task",
      "nightshift_get_task_evidence",
      "nightshift_list_minds",
      "nightshift_request_intelligence",
      "nightshift_verify_task",
      "telegraph_list_intents",
      "telegraph_list_miners",
    ];
    record("tools/list exposes all nine tools", JSON.stringify(names) === JSON.stringify(expected), `${names.length} tools`);

    const intents = await call(client, "telegraph_list_intents");
    record("telegraph_list_intents (live node)", !intents.result.isError && intents.parsed.count > 0, `${intents.parsed.count} intents`);

    const miners = await call(client, "telegraph_list_miners", {});
    record("telegraph_list_miners (live node)", !miners.result.isError && miners.parsed.count > 0, `${miners.parsed.count} miners (truncated=${miners.parsed.truncated})`);

    const minds = await call(client, "nightshift_list_minds");
    record("nightshift_list_minds", !minds.result.isError && minds.parsed.count > 0, `${minds.parsed.count} Minds`);

    const coverage = await call(client, "nightshift_get_mind_coverage", { slug: "counterparty-intelligence" });
    record("nightshift_get_mind_coverage (matrix)", !coverage.result.isError && coverage.parsed.mode === "matrix", `${coverage.parsed.dimensions?.length ?? 0} dimensions`);

    const free = await call(client, "nightshift_create_free_investigation", {
      objective: "Investigate MARA HOLDINGS INC in the US",
    });
    const freeOk = !free.result.isError && (free.parsed.state === "completed" || free.parsed.state === "failed");
    record("nightshift_create_free_investigation (real free run)", freeOk,
      `state=${free.parsed.state} spent=${free.parsed.spend?.spentUsdCents}¢ taskId=${free.parsed.taskId}`);
    if (!freeOk) {
      console.log(JSON.stringify(free.parsed, null, 2));
    } else {
      const evidence = await call(client, "nightshift_get_task_evidence", { taskId: free.parsed.taskId });
      record("nightshift_get_task_evidence", !evidence.result.isError, `evidence=${evidence.parsed.evidence?.length ?? 0}, criteria=${!!evidence.parsed.criteria}`);

      const verify = await call(client, "nightshift_verify_task", { taskId: free.parsed.taskId });
      record("nightshift_verify_task (independent)", !verify.result.isError,
        `verdict=${verify.parsed.verdict} checks=${verify.parsed.checks?.length} gaps=${verify.parsed.unresolvedGaps?.length}`);
    }

    if (TOKEN) {
      const paid = await call(client, "nightshift_request_intelligence", {
        objective: "Investigate GLEIF in the US (mcp smoke paid request)",
      });
      const paidOk = !paid.result.isError && paid.parsed.state === "awaiting_approval";
      record("nightshift_request_intelligence stops at approval", paidOk,
        `state=${paid.parsed.state} spent=${paid.parsed.spend?.spentUsdCents}¢`);
    } else {
      const anonPaid = await call(client, "nightshift_request_intelligence", { objective: "Investigate GLEIF in the US" });
      record("paid request refused anonymously (auth gate)", anonPaid.result.isError === true, String(anonPaid.parsed.error ?? "").slice(0, 80));
    }

    await client.close();
  } catch (err) {
    record("MCP session", false, err instanceof Error ? err.message : String(err));
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
