/**
 * Dependency injection for the NIGHTSHIFT MCP server.
 *
 * Every default here calls the EXISTING NIGHTSHIFT service implementation —
 * the Telegraph client, the capability runner, the task engine and the chain
 * reader. Nothing is re-implemented: the MCP layer is another transport over
 * the same services the web API routes use. Tests substitute this bundle to
 * keep the suite hermetic (no live node, no paid path).
 */

import { listIntents, listMiners, lookupSignal, type IntentSummary, type MinerSummary, type SignalRecord } from "@/lib/telegraph/client";
import { probeMindCoverage, type MindCoverageProbe } from "@/lib/minds/capability-runner";
import { createTask, runTask, type CreateTaskInput } from "@/lib/engine/engine";
import { getTask, listTasks } from "@/lib/engine/store";
import { getTransactionReceipt, type ChainReceipt } from "@/lib/chain/rpc";
import type { TaskRecord } from "@/lib/engine/types";

export interface McpDeps {
  listIntents(): Promise<IntentSummary[]>;
  listMiners(intent?: string): Promise<MinerSummary[]>;
  probeMindCoverage(slug: string): Promise<MindCoverageProbe>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  runTask(id: string): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(): Promise<TaskRecord[]>;
  lookupSignal(signalHash: string): Promise<SignalRecord>;
  getTransactionReceipt(txHash: string, rpcUrl?: string): Promise<ChainReceipt>;
  now(): number;
}

export function defaultMcpDeps(): McpDeps {
  return {
    listIntents: () => listIntents(),
    listMiners: (intent?: string) => listMiners(intent),
    probeMindCoverage: (slug: string) => probeMindCoverage(slug),
    createTask: (input: CreateTaskInput) => createTask(input),
    runTask: (id: string) => runTask(id),
    getTask: (id: string) => getTask(id),
    listTasks: () => listTasks(),
    lookupSignal: (hash: string) => lookupSignal(hash),
    getTransactionReceipt: (txHash: string, rpcUrl?: string) => getTransactionReceipt(txHash, rpcUrl),
    now: () => Date.now(),
  };
}

/**
 * Caller identity carried from the MCP HTTP transport into the existing
 * authorization gates. Only the credentials the MCP client itself presented
 * are forwarded: the bearer token (NIGHTSHIFT_API_TOKEN) and the operator /
 * user session cookie. Nothing here can mint authority — without these
 * headers every gate behaves exactly as it does for an anonymous HTTP caller.
 */
export interface McpCaller {
  authorization?: string | null;
  cookie?: string | null;
}

/**
 * The synthetic Request the gates evaluate. Same header semantics as the
 * real API routes: `Authorization: Bearer <token>` or the operator/user
 * session cookie. A missing token/cookie reproduces the anonymous case.
 */
export function callerRequest(caller: McpCaller, url = "http://mcp.nightshift.internal/"): Request {
  const headers = new Headers();
  if (caller.authorization) headers.set("authorization", caller.authorization);
  if (caller.cookie) headers.set("cookie", caller.cookie);
  return new Request(url, { headers });
}
