---
name: nightshift-telegraph
description: Drive NIGHTSHIFT's Telegraph intelligence integration over its remote MCP endpoint — discover intents and miners, inspect NIGHTSHIFT Mind capability coverage, run free investigations, request paid intelligence without approving it, retrieve task results, and independently verify completed tasks against node signals, receipts and the chain. Use when an agent needs verified external intelligence (company registry facts, market data, corporate diligence) with honest provenance and a human approval gate before any spend.
---

# NIGHTSHIFT Telegraph Integration

NIGHTSHIFT is an operations console that purchases verifiable intelligence from
the **Telegraph network** (miners serving intents, x402 payments, hash-committed
signals). This skill teaches an agent to use it **natively** through its remote
MCP endpoint (`/api/mcp`, official TypeScript MCP SDK, Streamable HTTP,
stateless JSON mode) — the same services, authorization gates and approval
flow the web console uses. Nothing here is a shortcut around them.

## Golden rules (read before any tool call)

1. **Discovery and free investigations cost nothing and can never spend.**
   Prefer them first; they answer "what can the network do and what would it
   cost" honestly.
2. **Paid intelligence always stops at the human approval gate.**
   `nightshift_request_intelligence` returns a task in `awaiting_approval`:
   no payment is signed, no paid step runs, and no tool in this skill can
   approve it. Approval is a human action (operator token or task owner via
   the Approvals console / `POST /api/tasks/:id/action`). Never try to
   circumvent this; never assume approval.
3. **Never trust a provider's "verified" label.** Use
   `nightshift_verify_task`, which re-reads the node's signal store and the
   public chain itself. A node-asserted flag is recorded but never accepted
   as proof.
4. **Report limitations verbatim.** If evidence is `unverified`, `missing` or
   `analysis`, or the report names gaps, say so in the final answer. Never
   turn missing evidence into a successful verification.
5. **The API token is a secret.** Configure `Authorization: Bearer
   <NIGHTSHIFT_API_TOKEN>` in the MCP client transport settings or as an
   environment variable of the runtime. Never write it into a skill file,
   tool output, log, commit or browser-visible code.

## Endpoint and authentication

- Endpoint URL: `https://<deployment>/api/mcp` (local development:
  `http://localhost:3000/api/mcp`).
- Transport: MCP Streamable HTTP (stateless; JSON responses; no session id
  is issued, so it survives serverless execution).
- Authentication is per tool, identical to the REST API:
  - open to everyone: `telegraph_list_intents`, `telegraph_list_miners`,
    `nightshift_list_minds`, `nightshift_get_mind_coverage` (matrix mode),
    `nightshift_create_free_investigation`;
  - requires `Authorization: Bearer <NIGHTSHIFT_API_TOKEN>` (or a wallet
    session): `nightshift_request_intelligence`;
  - operator or task owner: `nightshift_get_task` (full record),
    `nightshift_get_task_evidence`, `nightshift_verify_task`. Anonymous
    callers get the discovery-level public projection of tasks and a refusal
    for evidence — that is the intended behavior, not a malfunction.

## Workflow

1. **Discover intents** — `telegraph_list_intents`. Read `intent_id`,
   `intent_name`, `miner_count`. This is what the network can answer.
2. **Identify a specialist** — `telegraph_list_miners` with `intent` filter.
   Compare `capabilities` and `min_price_usdc`.
3. **Inspect capability readiness and price** — `nightshift_list_minds`, then
   `nightshift_get_mind_coverage` with the Mind's `slug`. `routable`
   dimensions carry the pinned provider and live price from an unpaid probe;
   `gap` dimensions are unsupported and must never be mapped onto a loosely
   related intent.
4. **Run free investigations** — `nightshift_create_free_investigation` with
   an objective that names a company, e.g. `"Investigate MARA HOLDINGS INC in
   the US"`. The call awaits the unpaid run (baseline dossier + reasoned
   report; $0.00). The result contains the task view including state and
   summary.
5. **Request paid intelligence WITHOUT approving it** —
   `nightshift_request_intelligence`. Present the returned plan (steps,
   budget, `awaiting_approval`) to the human. Tell them how to approve:
   Approvals console, or `POST /api/tasks/:id/action {"action":"approve"}` as
   the operator/owner. The agent's job ends at the gate.
6. **Retrieve task results** — `nightshift_get_task` (poll while `executing`).
   Full detail requires the operator token or ownership.
7. **Inspect verification evidence** — `nightshift_get_task_evidence`:
   criteria, evidence hashes (signals, receipts, settlements, public reads),
   the spend ledger, and per-dimension/per-fact verification status.
8. **Verify independently and report honestly** — `nightshift_verify_task`
   re-derives everything from the node and the chain. Summarize its `verdict`
   (`verified` / `failed` / `unverified`), per-evidence provenance
   (`verified`, `verification_failed`, `unverified`, `missing`, `analysis`),
   `failures`, `unresolvedGaps` and `nodeAssertedLabels` in the final report.
   Quote gaps as gaps.

## Tool reference

Full input/output schemas, bounded sizes and error behavior:
see `references/tools.md`.

| Tool | Free? | Auth |
| --- | --- | --- |
| telegraph_list_intents | yes | open |
| telegraph_list_miners | yes | open |
| nightshift_list_minds | yes | open |
| nightshift_get_mind_coverage | yes (`live=1` still unpaid) | open |
| nightshift_create_free_investigation | yes ($0.00 by construction) | open |
| nightshift_request_intelligence | no spend here, but paid-bound | operator token / wallet session |
| nightshift_get_task | read | open = public projection; operator/owner = full |
| nightshift_get_task_evidence | read | operator / task owner only |
| nightshift_verify_task | read + live node/chain re-reads | operator / task owner only |

## REST fallback

If the runtime cannot connect to MCP yet, the same capabilities exist as REST:
`GET /api/minds`, `GET /api/minds/:slug/coverage`, `POST /api/mind/investigations`
(`{"objective": "...", "mode": "free"}`), `GET /api/tasks/:id`
(same authentication: bearer token header; paid mode `intel` requires the
token and stops at the same approval gate). Prefer MCP; use REST only as a
fallback and label which path produced a result.

## Installation

OpenClaw and Hermes Agent installation and configuration:
`references/runtime-setup.md`.

**Status:** the MCP server, tools and this skill are implemented and covered
by tests plus a local end-to-end protocol run. Neither an OpenClaw session
nor a Hermes session has been executed against the deployed endpoint yet —
do not claim runtime-tested status until such a session is run.
