import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { mindBySlug, MINDS, MIND_STATUS_LABEL } from "@/lib/minds/registry";
import { CAPABILITIES, READINESS_LABEL, readinessFor, type CapabilityDimension } from "@/lib/minds/capabilities";
import { planMindInvestigation } from "@/lib/mind/plan";
import { paidRunGate } from "@/lib/api/userSpend";
import { taskForCaller } from "@/lib/api/public";
import { reapIfStalled, EngineError } from "@/lib/engine/engine";
import type { TaskRecord, PlanStep } from "@/lib/engine/types";
import { callerRequest, defaultMcpDeps, type McpCaller, type McpDeps } from "./deps";
import { defaultVerifyTaskDeps, independentlyVerifyTask } from "./verify-task";

/**
 * The NIGHTSHIFT MCP server (founder mission #19 — Native Telegraph
 * Integration, plus #20 — Independent Agent Task Verification).
 *
 * Every tool is a thin, strictly-schema'd wrapper over an EXISTING NIGHTSHIFT
 * service: the Telegraph client (discovery), the minds registry and
 * capability matrix, the engine's task lifecycle (`createTask` / `runTask`),
 * the shared authorization gates (`paidRunGate`, `taskForCaller`) and the
 * verification machinery (`lookupSignal`, `signalRecordMatchesAnswer`,
 * `reconcileLedger`). No parallel client, engine, payment system or evidence
 * store exists here.
 *
 * PAYMENT INVARIANTS (non-negotiable, enforced by the same code paths the web
 * API uses — not re-implemented here):
 *   - Discovery and free investigations never plan a purchase and never sign.
 *   - `nightshift_request_intelligence` creates a task that stops at
 *     awaiting_approval; the engine cannot execute it until a human approves
 *     through the existing approval gate (operator/owner action).
 *   - No tool accepts or returns secrets; the caller's bearer token is only
 *     forwarded to the in-process authorization gates.
 */

export const MCP_SERVER_NAME = "nightshift";
export const MCP_SERVER_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Bounded output sizes                                                */
/* ------------------------------------------------------------------ */

const MAX_INTENTS = 500;
const MAX_MINERS = 60;
const MAX_DIMENSIONS = 120;
const MAX_EVENTS = 40;
const MAX_TEXT = 4000;
const MAX_OBJECTIVE = 2000;

/* ------------------------------------------------------------------ */
/* Result helpers                                                      */
/* ------------------------------------------------------------------ */

function jsonText(payload: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(payload, null, 2) }];
}

function ok(payload: unknown) {
  return { content: jsonText(payload) };
}

/** Expected failure (bad input, authorization, unknown task, upstream error). */
function fail(message: string, extra?: Record<string, unknown>) {
  return {
    content: jsonText({ error: message, ...(extra ?? {}) }),
    isError: true,
  };
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`;
}

/* ------------------------------------------------------------------ */
/* Task view (bounded, caller-clearance-aware)                         */
/* ------------------------------------------------------------------ */

function stepView(step: PlanStep) {
  return {
    id: step.id,
    kind: step.kind,
    description: clip(step.description, 300),
    ...(step.maxCostUsdCents !== undefined ? { maxCostUsdCents: step.maxCostUsdCents } : {}),
  };
}

function eventView(events: TaskRecord["events"]) {
  return events.slice(-MAX_EVENTS).map((e) => ({
    ts: new Date(e.ts).toISOString(),
    type: e.type,
    message: clip(e.message, 300),
  }));
}

/**
 * Bounded task projection at the caller's clearance. When `redacted` is true
 * the caller received the discovery-level public projection (taskForCaller
 * already emptied the private fields); the view renders only aggregates and
 * never touches private content.
 */
function taskView(task: TaskRecord, redacted: boolean) {
  const base = {
    taskId: task.id,
    state: task.state,
    jobType: task.jobType ?? "goal",
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    spend: {
      limitUsdCents: task.spend?.limitUsdCents ?? 0,
      spentUsdCents: task.spend?.spentUsdCents ?? 0,
    },
    redacted,
  };
  if (redacted) {
    return {
      ...base,
      note:
        "Public projection: the objective, plan, timeline, report, evidence and spend ledger of this task are private to its owner and the deployment operator. Authenticate to inspect them.",
    };
  }
  const awaitingApproval = task.state === "awaiting_approval";
  return {
    ...base,
    owner: task.owner ?? null,
    ...(awaitingApproval
      ? {
          approval: {
            required: true,
            status: "awaiting_approval",
            note:
              "No payment has been signed and nothing has executed. A human must approve this exact plan before any paid step runs (operator token or the task owner, via the Approvals console or POST /api/tasks/:id/action {action:'approve'}).",
          },
        }
      : {}),
    goal: clip(task.goal, 1000),
    plan: (task.plan ?? []).map(stepView),
    events: eventView(task.events),
    error: task.error,
    result: task.result
      ? {
          summary: clip(task.result.summary),
          evidence: task.result.evidence.map((e) => (e as { kind: string }).kind),
          completedAt: new Date(task.result.completedAt).toISOString(),
          hasMindReport: !!task.result.mindReport,
          hasCapabilityReport: !!task.result.capabilityReport,
        }
      : null,
    nextSteps: awaitingApproval
      ? ["poll nightshift_get_task for state changes", "approval happens only through the human approval gate"]
      : ["poll nightshift_get_task for state changes", task.result ? "use nightshift_get_task_evidence / nightshift_verify_task for the evidence trail" : null].filter(Boolean),
  };
}

function dimensionView(d: CapabilityDimension) {
  return {
    id: d.id,
    label: d.label,
    status: d.status,
    ...(d.intent ? { intent: d.intent } : {}),
    ...(d.provider ? { provider: d.provider } : {}),
    ...(d.priceUsdCents !== undefined ? { priceUsdCents: d.priceUsdCents } : {}),
    ...(d.verification ? { verification: d.verification } : {}),
    ...(d.limitation ? { limitation: clip(d.limitation, 200) } : {}),
    ...(d.missingReason ? { missingReason: clip(d.missingReason, 200) } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Server factory                                                      */
/* ------------------------------------------------------------------ */

export function createNightshiftMcpServer(caller: McpCaller = {}, deps: McpDeps = defaultMcpDeps()) {
  const request = () => callerRequest(caller);
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  /* ------------------------- Discovery ------------------------- */

  server.registerTool(
    "telegraph_list_intents",
    {
      title: "List Telegraph intents",
      description:
        "Lists the intents available on the live Telegraph node (free discovery, no payment). Each entry carries intent_id, intent_name and miner_count. Use it to find which intelligence categories the network can answer.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const intents = await deps.listIntents();
        const bounded = intents.slice(0, MAX_INTENTS);
        return ok({
          count: bounded.length,
          totalAvailable: intents.length,
          truncated: intents.length > bounded.length,
          intents: bounded,
          note: "Free discovery read straight from the Telegraph node. No payment path exists in this tool.",
        });
      } catch (err) {
        return fail(`Telegraph intents discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "telegraph_list_miners",
    {
      title: "List Telegraph miners",
      description:
        "Lists miners serving the live Telegraph node (free discovery, no payment), optionally filtered by intent. Each entry carries id, name, kind, capabilities and min_price_usdc when advertised. Use it to identify an appropriate specialist for an intent.",
      inputSchema: {
        intent: z.string().max(120).optional().describe("Filter miners by intent id (e.g. CRYPTO_PRICE_USD). Omit for all miners."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ intent }) => {
      try {
        const miners = await deps.listMiners(intent);
        const bounded = miners.slice(0, MAX_MINERS);
        return ok({
          count: bounded.length,
          totalAvailable: miners.length,
          truncated: miners.length > bounded.length,
          miners: bounded,
          note: "Free discovery read straight from the Telegraph node. A miner listing is not a verified answer; check the Mind capability matrix before paying for anything.",
        });
      } catch (err) {
        return fail(`Telegraph miners discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "nightshift_list_minds",
    {
      title: "List NIGHTSHIFT Minds",
      description:
        "Lists the NIGHTSHIFT Minds catalogue: specialist intelligence capabilities with status, readiness, verified dimension counts and named boundaries. Only status=available Minds have a working investigation path. Pairs with nightshift_get_mind_coverage and the investigation tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const minds = MINDS.map((mind) => {
        const dims = CAPABILITIES[mind.slug]?.dimensions ?? [];
        return {
          slug: mind.slug,
          name: mind.name,
          domain: mind.domain,
          status: mind.status,
          statusLabel: MIND_STATUS_LABEL[mind.status],
          readiness: READINESS_LABEL[readinessFor(mind.slug, mind.status)],
          summary: mind.summary,
          counts: {
            verified: dims.filter((d) => d.status === "verified").length,
            partial: dims.filter((d) => d.status === "partial").length,
            gaps: dims.filter((d) => d.status === "gap").length,
          },
          boundaries: mind.boundaries.slice(0, 5),
        };
      });
      return ok({
        count: minds.length,
        minds,
        note:
          "Free investigations: nightshift_create_free_investigation (objective-based). Paid intelligence: nightshift_request_intelligence, which always stops at the human approval gate.",
      });
    },
  );

  server.registerTool(
    "nightshift_get_mind_coverage",
    {
      title: "Get Mind capability coverage",
      description:
        "Returns a Mind's verified capability matrix (committed, no network call) or, with live=true, re-probes every supported dimension against the live node UNPAID — a routable dimension means the node accepted the schema, pinned provider and live price; it is NOT a purchased answer. Names every gap explicitly.",
      inputSchema: {
        slug: z.string().max(120).describe("Mind slug from nightshift_list_minds (e.g. counterparty-intelligence)."),
        live: z.boolean().optional().describe("Re-probe the live node unpaid (default false: committed matrix only)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ slug, live }) => {
      const mind = mindBySlug(slug);
      if (!mind) {
        return fail(`unknown Mind: ${slug}`, { availableSlugs: MINDS.map((m) => m.slug) });
      }
      const committed = (CAPABILITIES[slug]?.dimensions ?? []).slice(0, MAX_DIMENSIONS).map(dimensionView);
      if (!live) {
        return ok({
          mind: { slug: mind.slug, name: mind.name, status: mind.status, readiness: READINESS_LABEL[readinessFor(slug, mind.status)] },
          mode: "matrix",
          dimensions: committed,
          note: "Committed capability matrix. Set live=true to re-probe supported dimensions for free; no payment is ever signed by this tool.",
        });
      }
      try {
        const probe = await deps.probeMindCoverage(slug);
        return ok({
          mind: { slug: mind.slug, name: mind.name, status: mind.status, readiness: READINESS_LABEL[readinessFor(slug, mind.status)] },
          mode: "live",
          probedAt: probe.probedAt,
          routable: probe.routable,
          gaps: probe.gaps,
          considered: probe.considered,
          plannedCostUsdCents: probe.plannedCostUsdCents,
          dimensions: probe.dimensions.slice(0, MAX_DIMENSIONS),
          note: "Free unpaid probes only. A routable dimension means the node accepted the canonical schema, pinned provider and live price; it is not a purchased answer.",
        });
      } catch (err) {
        return fail(`coverage probe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  /* ----------------------- Investigations ----------------------- */

  server.registerTool(
    "nightshift_create_free_investigation",
    {
      title: "Create a free NIGHTSHIFT investigation",
      description:
        "Runs a FREE investigation (mode \"free\") for an objective that names a company to investigate — e.g. \"Investigate MARA HOLDINGS INC in the US\". Plans no purchase at all, spends $0.00, and awaits execution: the unpaid dossier and the reasoned report come back in this call. Nothing is signed and no approval gate is involved because nothing can spend.",
      inputSchema: {
        objective: z.string().min(1).max(MAX_OBJECTIVE).describe("Investigation objective; must name a company (optionally with jurisdiction)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ objective }) => {
      const trimmed = objective.trim();
      const planned = planMindInvestigation(trimmed, "free");
      if (planned.blocker || planned.steps.length === 0) {
        return fail(planned.blocker ?? "the objective produced no investigation plan", {
          note: "Nothing was created and nothing was spent. Free investigations currently investigate named companies through the Counterparty Intelligence path.",
        });
      }
      try {
        const task = await deps.createTask({
          goal: trimmed,
          requiresApproval: false,
          origin: { source: "mcp" },
          jobType: "mind_investigation",
          plan: planned.steps,
          criteria: planned.criteria,
          assumptions: planned.assumptions,
        });
        if (task.state !== "executing") {
          return fail(`the task did not start executing (state ${task.state})`, { taskId: task.id });
        }
        const run = await deps.runTask(task.id);
        return ok({
          ...taskView(run, false),
          cost: "FREE — this mode plans no purchase and spends $0.00",
          nextSteps: ["nightshift_get_task_evidence for the evidence trail", "nightshift_verify_task for independent verification"],
        });
      } catch (err) {
        return fail(`free investigation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "nightshift_request_intelligence",
    {
      title: "Request paid intelligence (stops at approval)",
      description:
        "Creates a PAID intelligence investigation (mode \"intel\") that ALWAYS stops at the human approval gate. The tool creates the task with its plan and budget and returns it in awaiting_approval: no payment is signed, no paid step executes, and this tool cannot approve it. The operator or the task owner approves the exact plan afterwards (Approvals console or POST /api/tasks/:id/action). Requires the operator bearer token (Authorization: Bearer <NIGHTSHIFT_API_TOKEN>) or a wallet session.",
      inputSchema: {
        objective: z.string().min(1).max(MAX_OBJECTIVE).describe("Investigation objective; must name a company (optionally with jurisdiction)."),
        spendLimitUsdCents: z
          .number()
          .int()
          .positive()
          .max(20_000)
          .optional()
          .describe("Maximum spend ceiling in USD cents for the whole task (default: the deployment spend limit)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ objective, spendLimitUsdCents }) => {
      const trimmed = objective.trim();
      // Same gate the web API applies: operator passes, a wallet user is
      // capped by their daily allowance, anonymous callers are refused.
      const gate = await paidRunGate(request(), "intel investigations", spendLimitUsdCents);
      if (gate.kind === "deny") return fail(gate.error, { httpStatus: gate.status });

      const planned = planMindInvestigation(trimmed, "intel");
      if (planned.blocker || planned.steps.length === 0) {
        return fail(planned.blocker ?? "the objective produced no investigation plan", {
          note: "Nothing was created and nothing was spent.",
        });
      }
      try {
        const task = await deps.createTask({
          goal: trimmed,
          spendLimitUsdCents,
          requiresApproval: true,
          origin: { source: "mcp" },
          ...(gate.operator ? {} : gate.userAddress ? { owner: gate.userAddress } : {}),
          jobType: "mind_investigation",
          plan: planned.steps,
          criteria: planned.criteria,
          assumptions: planned.assumptions,
        });
        return ok({
          ...taskView(task, false),
          note:
            "Created at the approval gate. NO payment was signed and NO paid step executed. The plan runs only after a human approves this exact task.",
        });
      } catch (err) {
        if (err instanceof EngineError) return fail(err.message);
        return fail(`creating the paid investigation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  /* ------------- Task inspection and verification ------------- */

  server.registerTool(
    "nightshift_get_task",
    {
      title: "Get a NIGHTSHIFT task",
      description:
        "Returns one task at the caller's clearance: full record (objective, plan, timeline, result, spend ledger totals) for the operator or the task's owner; the discovery-level public projection for everyone else. Unknown ids return an error, never a fabricated task.",
      inputSchema: {
        taskId: z.string().min(1).max(128).describe("Task id as returned by the investigation tools."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ taskId }) => {
      try {
        const stored = await deps.getTask(taskId);
        if (!stored) return fail(`task ${taskId} not found`);
        const task = await reapIfStalled(stored, deps.now());
        const view = taskForCaller(request(), task);
        return ok(taskView(view.task, view.redacted));
      } catch (err) {
        return fail(`reading the task failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "nightshift_get_task_evidence",
    {
      title: "Get a task's evidence trail",
      description:
        "Returns the evidence behind a task for the operator or its owner: verification criteria, recorded evidence kinds with hashes (Telegraph signals, receipts, on-chain settlements, public reads), the spend ledger, and the verification status of each purchased dimension/fact. Private for everyone else; anonymous callers are refused rather than shown redacted evidence.",
      inputSchema: {
        taskId: z.string().min(1).max(128).describe("Task id."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ taskId }) => {
      try {
        const stored = await deps.getTask(taskId);
        if (!stored) return fail(`task ${taskId} not found`);
        const task = await reapIfStalled(stored, deps.now());
        const view = taskForCaller(request(), task);
        if (view.redacted) {
          return fail(
            "this task's evidence is private to its owner and the deployment operator; authenticate (Authorization: Bearer <NIGHTSHIFT_API_TOKEN>) to inspect it",
            { taskId, state: task.state, redacted: true },
          );
        }
        const result = task.result;
        return ok({
          taskId: task.id,
          state: task.state,
          criteria: task.criteria,
          evidence: result?.evidence ?? [],
          ledger: {
            limitUsdCents: task.spend?.limitUsdCents ?? 0,
            spentUsdCents: task.spend?.spentUsdCents ?? 0,
            entries: (task.spend?.entries ?? []).slice(0, 30),
          },
          purchased: result?.capabilityReport
            ? {
                kind: "capability_run",
                dimensions: result.capabilityReport.dimensions.slice(0, MAX_DIMENSIONS).map((d) => ({
                  dimension: d.dimension,
                  status: d.status,
                  intent: d.intent,
                  provider: d.provider,
                  signalHash: d.signalHash,
                  receiptHash: d.receiptHash,
                  priceUsdCents: d.priceUsdCents,
                  verificationReason: d.verificationReason,
                  detail: clip(d.detail ?? "", 300),
                })),
              }
            : result?.mindReport?.intel
              ? {
                  kind: "mind_investigation",
                  intelUsed: result.mindReport.intelUsed,
                  signalHash: result.mindReport.intel.signalHash,
                  receiptHash: result.mindReport.intel.receiptHash,
                  verificationStatus: result.mindReport.intel.verificationStatus,
                  costUsdCents: result.mindReport.intel.costUsdCents,
                  facts: result.mindReport.intel.facts.slice(0, 40),
                  missing: result.mindReport.intel.missing,
                  disagreements: result.mindReport.intel.disagreements.slice(0, 10),
                }
              : null,
          note:
            "Provenance of every hash can be re-checked with nightshift_verify_task, which re-reads the node and the chain instead of trusting these records.",
        });
      } catch (err) {
        return fail(`reading the evidence failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "nightshift_verify_task",
    {
      title: "Independently verify a completed task",
      description:
        "Independent verification (mission #20): re-checks a task's evidence WITHOUT trusting the provider or the task's own labels. Re-reads the Telegraph node's signal store for every signal hash and re-derives the accepted-answer match with the engine's matcher, re-reads settlement transactions on the public chain, reconciles the spend ledger, and reports per-evidence provenance: verified, verification_failed, unverified, missing or analysis — plus unresolved gaps. The node's own 'verified' assertion is recorded but never accepted as proof. Missing evidence never becomes a successful verification. Requires the operator or the task owner.",
      inputSchema: {
        taskId: z.string().min(1).max(128).describe("Task id."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ taskId }) => {
      try {
        const stored = await deps.getTask(taskId);
        if (!stored) return fail(`task ${taskId} not found`);
        const task = await reapIfStalled(stored, deps.now());
        const view = taskForCaller(request(), task);
        if (view.redacted) {
          return fail(
            "verification reads the task's private evidence; authenticate as the task owner or the operator (Authorization: Bearer <NIGHTSHIFT_API_TOKEN>)",
            { taskId, state: task.state, redacted: true },
          );
        }
        const report = await independentlyVerifyTask(view.task, defaultVerifyTaskDeps());
        return ok(report);
      } catch (err) {
        return fail(`verification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return server;
}
