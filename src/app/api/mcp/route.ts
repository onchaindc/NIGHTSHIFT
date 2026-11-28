import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createNightshiftMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Free investigations await their unpaid execution; paid requests return
// immediately at the approval gate. The window covers the free path.
export const maxDuration = 300;

/**
 * POST /api/mcp — the NIGHTSHIFT remote MCP endpoint (Streamable HTTP).
 *
 * Official TypeScript MCP SDK over the Streamable HTTP transport in
 * STATELESS mode (`sessionIdGenerator: undefined` + JSON responses):
 * no in-memory session state is required, so the endpoint survives Vercel
 * serverless execution where request-bound instances do not persist. A fresh
 * server + transport pair is built per request, carrying ONLY the caller's
 * own Authorization/cookie headers into the existing authorization gates.
 *
 * Authentication is per tool, exactly like the REST API:
 *   - discovery tools and free investigations: open (they can never spend);
 *   - paid intelligence: the operator bearer token or a wallet session;
 *   - task/evidence/verification reads: operator, or the task's owner.
 * Configure the bearer token in the MCP client transport headers; it is never
 * part of any skill file, tool output, log or bundle.
 */

function callerFrom(req: Request) {
  return {
    authorization: req.headers.get("authorization"),
    cookie: req.headers.get("cookie"),
  };
}

function statelessTransport() {
  return new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no sessions on serverless
    enableJsonResponse: true, // JSON replies instead of SSE streams
  });
}

export async function POST(req: Request): Promise<Response> {
  const transport = statelessTransport();
  const server = createNightshiftMcpServer(callerFrom(req));
  await server.connect(transport);
  return await transport.handleRequest(req);
}

/**
 * GET (server-initiated SSE stream) and DELETE (session termination) are not
 * offered in stateless JSON mode. The transport answers both with 405, which
 * the Streamable HTTP spec allows for servers without server-initiated
 * streams or session state.
 */
export async function GET(req: Request): Promise<Response> {
  const transport = statelessTransport();
  const server = createNightshiftMcpServer(callerFrom(req));
  await server.connect(transport);
  return await transport.handleRequest(req);
}

export async function DELETE(req: Request): Promise<Response> {
  const transport = statelessTransport();
  const server = createNightshiftMcpServer(callerFrom(req));
  await server.connect(transport);
  return await transport.handleRequest(req);
}
