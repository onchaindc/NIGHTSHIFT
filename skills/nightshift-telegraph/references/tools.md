# NIGHTSHIFT MCP tools — reference

Endpoint: `POST https://<deployment>/api/mcp` (Streamable HTTP, stateless,
JSON responses). All tools return a single JSON object as text content.
Expected failures return `isError: true` with `{"error": "..."}` — bad input,
authorization refusals, unknown tasks, unreachable upstream services. Unknown
task ids never fabricate records. Output sizes are bounded; `truncated: true`
flags a cut list.

## Discovery

### telegraph_list_intents
Input: none.
Output: `{ count, totalAvailable, truncated, intents: [{ intent_id, intent_name, miner_count }], note }`
Live read of the node catalogue (`/engine/v1/intents`). Free. Errors when the
node is unreachable (`Telegraph intents discovery failed: ...`).

### telegraph_list_miners
Input: `{ intent?: string }` (max 120 chars).
Output: `{ count, totalAvailable, truncated, miners: [{ id, name, kind, capabilities[], min_price_usdc? }], note }`
Bounded to the first 60 miners. Free.

### nightshift_list_minds
Input: none.
Output: `{ count, minds: [{ slug, name, domain, status, statusLabel, readiness, summary, counts: {verified, partial, gaps}, boundaries[] }], note }`
Static catalogue + capability matrix (no network call). `status` is honest:
only `available` Minds have a working investigation path.

### nightshift_get_mind_coverage
Input: `{ slug: string, live?: boolean }`.
Output (matrix mode): `{ mind, mode: "matrix", dimensions: [{ id, label, status, intent?, provider?, priceUsdCents?, verification?, limitation?, missingReason? }], note }`
Output (live mode): `{ mind, mode: "live", probedAt, routable, gaps, considered, plannedCostUsdCents, dimensions: [probe records], note }`
`live=true` re-probes every supported dimension UNPAID (x402 challenge only,
nothing signed). `routable` = schema, pinned provider and live price accepted
by the node — **not** a purchased answer. Unknown slug → error listing
available slugs.

## Investigations

### nightshift_create_free_investigation
Input: `{ objective: string }` (1–2000 chars; must name a company, optionally
with jurisdiction).
Behavior: plans mode "free" (`planMindInvestigation`), creates a
`mind_investigation` task via the engine with `requiresApproval: false`, then
runs it to completion (unpaid probe + report) and awaits it.
Output: bounded task view `{ taskId, state, jobType, createdAt, updatedAt,
spend, redacted, owner, goal, plan[], events[], error, result: {summary,
evidence[], completedAt, hasMindReport, hasCapabilityReport}, nextSteps[],
cost: "FREE..." }` plus `note` fields. No payment path exists in this mode.
Blocker (objective names no company) → `isError` with the planner's message;
nothing is created.

### nightshift_request_intelligence
Input: `{ objective: string, spendLimitUsdCents?: number }` (positive int,
≤ 20000 = $200 hard cap from the tool schema).
Behavior: applies the SAME gate as `POST /api/mind/investigations` mode
"intel" (`paidRunGate`: operator passes; wallet users are subject to the
daily spend cap; anonymous callers refused 401). Creates the task with
`requiresApproval: true` — the engine parks it at `awaiting_approval`.
**No payment is signed and no paid step executes here.** This tool cannot
approve the task.
Output: task view including `approval: { required: true, status:
"awaiting_approval", note }` and the full plan with per-step budget.
Approval (human, afterwards): Approvals console or
`POST /api/tasks/:id/action {"action":"approve"}` as operator/owner.
Errors: gate denial message (`sign in with your wallet to run intel
investigations...` / daily-cap message), planner blocker, engine error.

## Task inspection and verification

### nightshift_get_task
Input: `{ taskId: string }`.
Output: bounded task view at the caller's clearance. Operator/owner: full
(goal, plan, last 40 events, result summary ≤ 4000 chars, spend totals).
Anonymous: `{ ...aggregates only, redacted: true, note }` — the objective,
plan, timeline, report, evidence and ledger entries never cross this gate.

### nightshift_get_task_evidence
Input: `{ taskId: string }`.
Output (operator/owner): `{ taskId, state, criteria, evidence[], ledger:
{limitUsdCents, spentUsdCents, entries[]}, purchased: {kind, signalHash?,
receiptHash?, verificationStatus?, costUsdCents?, facts[], missing[],
disagreements[]} | capability dimension records, note }`.
Anonymous/non-owner → `isError` refusal (evidence is private). Unknown task →
error.

### nightshift_verify_task
Input: `{ taskId: string }`.
Behavior: independent re-verification (mission #20) using the existing
machinery — `lookupSignal` per signal hash, `signalRecordMatchesAnswer`
(engine matcher) against the stored committed response / purchased facts /
reconstructed answer, `reconcileLedger`, and a fresh public-chain receipt
read per settlement tx. Never mutates the task.
Output: `{ taskId, taskState, claimedComplete, verdict: "verified"|"failed"|
"unverified", ledger: {consistent, entries, accountedCents,
uncertainPricedAttempts, problems[]}, checks: [{ id, label, status:
"verified"|"verification_failed"|"unverified"|"missing"|"analysis", detail,
signalHash?, txHash? }], failures[], unresolvedGaps[], nodeAssertedLabels[],
verifiedAt, note }`.
Verdict rules: any failing check → `failed`; completion claim + all applicable
network checks verified + consistent ledger → `verified`; otherwise
`unverified` (missing evidence is NEVER success). The node's own
`verification.verified` flag is reported under `nodeAssertedLabels` and
ignored as proof. Anonymous/non-owner → `isError` refusal.

## Bounded sizes

| Bound | Value |
| --- | --- |
| intents returned | 500 |
| miners returned | 60 |
| capability dimensions | 120 |
| task events | last 40 |
| result/summary text | 4000 chars |
| objective input | 2000 chars |
| spendLimitUsdCents input | 20000 ($200) |
