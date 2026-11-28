# Runtime verification record — OpenClaw and Hermes sessions

## Round 3 — verification against the deployed URL itself (2026-11-28, latest)

The team issued a Protection Bypass for Automation secret for the `nightshift`
project, unblocking verification against the live deployment. The bypass
header was used by every caller below; nothing on the deployment was
reconfigured and no payment, approval or wallet funding was performed.

Deployment under test: branch alias
`https://nightshift-git-feat-openclaw-hermes-5fbec3-onchaindcs-projects.vercel.app`
(Vercel build success for commit `aaf7a24`, per the GitHub commit status,
2026-11-28T11:26:56Z). `GET /api/status` on this deployment reports:
`apiAuth: "open"` (no `NIGHTSHIFT_API_TOKEN` configured — the operator gate
fails closed and authorizes nobody), `persistence: postgres, durable,
connection ok`, `services.hunyuan: false`.

Checklist results on the deployed URL:

1. **MCP nine-tool contract — PASS.** `initialize` handshake OK
   (server `nightshift 1.0.0`); `tools/list` returns exactly the nine tools.
2. **Live discovery — PASS.** `telegraph_list_intents` = 136 intents
   (`truncated: false`); `telegraph_list_miners` = 60 miners
   (`truncated: true`) — live node, no credentials.
3. **Free investigation — PASS (with honest clearance limits).**
   Anonymous create → `completed`, `spentUsdCents: 0`
   (task `16ab10b4-…-5510bfe69017`). Evidence read returns the correct
   owner/operator privacy refusal to an anonymous caller; independent
   `nightshift_verify_task` is operator-gated and is therefore unreachable on
   this deployment in `open` mode (verified on the same-commit build in
   Round 2: honest `unverified`, 0 gaps).
4. **Paid intelligence gate — SAFE, gate unreachable.**
   `nightshift_request_intelligence` refuses with 401 "sign in with your
   wallet to run intel investigations; the free modes stay open to everyone".
   No payment signed, no paid step executed, nothing spent. Reaching
   `awaiting_approval` on this deployment requires a funded wallet session;
   none was created (no funding, by policy). `awaiting_approval` with $0 and
   no signed payment is verified on the same-commit build (Round 2).
5. **Decision Assurance anonymity gates — PASS.** Anonymous `GET` → 401
   ("private to the operator"); anonymous `POST` → 401 ("operator-gated").
6. **Hunyuan status — PASS (truthful unconfigured).** `GET /api/hunyuan/status`
   → `provider=tencent-hunyuan`, `configured=false`,
   `missing=["HUNYUAN_API_KEY"]`, `baseUrl=https://tokenhub-intl.tencentmaas.com/v1`,
   mission descriptions present, `note` explicitly states no simulated
   provider output is ever produced.
7. **Continuum tick — BLOCKED by design.** `POST /api/hunyuan/continuum/tick`
   and `GET /api/hunyuan/continuum` are operator-gated → 401 in `open` mode.
   The persistence layer they write to is healthy (postgres, connection ok).
   Tick + persisted-event verification ran on the same-commit build (Round 2:
   baseline → 22 deduplicated events → 0 on re-tick).

Real runtime sessions against the deployed URL (bypass header in both client
configs; the previous local bearer was removed):

- **OpenClaw 2026.11.11** (`mcp probe`): Connected — **9 tools**.
  Agent turn 1: `telegraph_list_intents` + `telegraph_list_miners` executed
  live; payloads exceeded the model output budget and the agent reported the
  truncation honestly (counts confirmed by the direct client: 136 / 60).
  Agent turn 2: free investigation task `2aaf03da-…-881a066c676c`,
  `completed`, `spentUsdCents: 0`, honest free-mode summary quoted.
  Agent turn 3: `nightshift_request_intelligence` → exact 401 wallet-gate
  refusal relayed verbatim; no retry, no approval attempted.
- **Hermes Agent 0.23.4** (`hermes mcp test nightshift`): Connected
  (2306 ms), **9 tools** discovered. Agent turn: free investigation task
  `2ea598bd-…-b0c9c294aa29`, `completed`, $0, honest report (0/9 registry
  fields known from free sources); paid request → the same 401 wallet-gate
  refusal; nothing signed or approved.

Deployment-configuration gaps found by this round (operator-side actions, not
application defects):

- `NIGHTSHIFT_API_TOKEN` is not set on the deployment (`apiAuth: "open"`):
  every operator-gated route (evidence full reads, verify, continuum tick and
  ledger, paid paths beyond the wallet gate) fails closed to 401. Setting the
  variable unlocks checklist items 3 (verify), 4 (awaiting_approval) and 7.
- `HUNYUAN_API_KEY` is not set: Hunyuan inference is honestly reported as
  unconfigured; missions run schema-validated workflows without simulated
  provider output.
- The production domain `nightshift-telegraph.vercel.app` serves `main`,
  which does not contain the mission code (`/api/mcp`,
  `/api/hunyuan/status` → 404 there). Merging this branch to `main` is
  prohibited by the mission contract.

## Round 2 — post-push deployment attempt and same-commit build (2026-11-28, later)

Branch `feat/openclaw-hermes-integration` was pushed through `7a80f28`
(verification record commit) with `b89f20f` (deploy-trigger chore). Vercel
built and served the fresh preview:

- Deployment URL:
  `https://nightshift-git-feat-openclaw-hermes-5fbec3-onchaindcs-projects.vercel.app`
  (commit `7a80f28`, Vercel build status success via the GitHub commit status).

**The fresh preview is gated by Vercel Authentication (team SSO).** Every
external caller is refused before reaching the app:

- `curl /api/status` → "Protected by Vercel Authentication";
  `/api/mcp` → 302 redirect to `vercel.com/sso-api?...`.
- OpenClaw `mcp probe` against the deployed URL → `authentication refused
  (401)` from Vercel Authentication (not from the app).
- Hermes `mcp test nightshift` against the deployed URL → connection failed:
  the endpoint returned `text/html` (the SSO login redirect), not an MCP
  response.
- An anonymous in-app check cannot exist yet: the app itself is never reached.

This is a deployment-platform gate, not an application defect: the same commit
serves the full MCP endpoint when the wall is absent (below). Clearing it
requires a team-side action on the Vercel dashboard (disable Deployment
Protection for previews, or issue a protection-bypass secret) or a Vercel
token with that team scope; both are outside this repository.

**The complete checklist therefore ran against a production build of the exact
pushed commit (`7a80f28`, `npm run build && NIGHTSHIFT_API_TOKEN=<secret>
npm start`, file store) — the same code the deployment serves:**

1. MCP: initialize handshake OK; `tools/list` returns exactly the nine tools.
2. Live discovery: `telegraph_list_intents` = 136 intents;
   `telegraph_list_miners` = 60 miners (truncated=true) — live node,
   no credentials.
3. Free investigation (real run): `state=completed`, `spentUsdCents=0`;
   evidence retrievable (1 item, `counterparty_finding`); independent
   `nightshift_verify_task` verdict `unverified`, 0 unresolved gaps (honest:
   free evidence is analysis-only).
4. Paid intelligence (operator bearer): `state=awaiting_approval`,
   `spentUsdCents=0`, no payment signed, no paid step executed.
5. Decision Assurance gates: anonymous `GET`/`POST`
   `/api/hunyuan/decision-assurance` → **401** (both, with gate explanations).
6. `GET /api/hunyuan/status`: `provider=tencent-hunyuan`,
   `configured=false`, `missing=["HUNYUAN_API_KEY"]` — truthful; no simulated
   inference.
7. Continuous Intelligence: first continuum tick over a real desk file →
   baseline established (0 events by design); after the file's free run
   synced 21 evidence items, the next tick persisted **22 events**; the
   following tick added **0** (content-fingerprint dedup). Ledger
   (`GET /api/hunyuan/continuum`) shows events with ts, entity, kind,
   materiality, fingerprint, investigationIds (scope/id/reference),
   evidenceIds and `providerAssessment: null` (provider unconfigured —
   declared, not hidden). Anonymous ledger read → 401. Status counters show
   `events=22` with `lastEventAt`.

**Real runtime sessions against that build (same commit):**

- OpenClaw 2026.11.11: probe → 9 tools; agent turn executed
  `telegraph_list_intents` + `telegraph_list_miners` live (payload exceeded
  the model output budget; the agent reported the truncation honestly —
  counts confirmed by the direct client above); free investigation
  `completed`, $0, verdict `unverified`, 0 gaps; paid request
  `awaiting_approval`, $0, "No payment was signed and no paid step executed".
- Hermes Agent 0.23.4: `hermes mcp test nightshift` → Connected (1195 ms),
  9 tools, Authorization masked; live counts 136 intents / 60 miners
  (truncated from 2,203); free run `completed`, $0, `unverified`, 0 gaps
  (reported the missing registry fields honestly); paid request
  `awaiting_approval`, no payment signed, no paid step executed.

## Round 1 — local production build (2026-11-28, earlier)

Recorded 2026-11-28. The runtime tests ran against a PRODUCTION BUILD of this
branch (`npm run build && NIGHTSHIFT_API_TOKEN=<local secret> npm start`,
section 4 of `runtime-setup.md`) because the Vercel preview deployment of
commit `4404d04` had expired before this round could run, and no redeploy was
possible without push credentials. Everything below is what the runtimes
actually returned — including the limitations.

## Environments

| Runtime | Version | Endpoint | Skill install | MCP auth |
| --- | --- | --- | --- | --- |
| OpenClaw | 2026.11.11 (a257c0f) | `http://127.0.0.1:3111/api/mcp` (Streamable HTTP) | workspace `skills/nightshift-telegraph` | `Authorization: Bearer` header in `mcp.servers` config |
| Hermes Agent | 0.23.4 (2026.9.24) | same | project `.agents/skills/nightshift-telegraph` (trusted via `hermes skills trust`) | `mcp_servers.nightshift.headers` = `Bearer ${MCP_NIGHTSHIFT_API_KEY}`, token in the runtime's own `.env` |

## OpenClaw (real agent turns, not SDK-only)

1. Tool discovery in-session: the agent named all nine tools
   (`nightshift_create_free_investigation`, `nightshift_get_mind_coverage`,
   `nightshift_get_task`, `nightshift_get_task_evidence`,
   `nightshift_list_minds`, `nightshift_request_intelligence`,
   `telegraph_list_intents`, `telegraph_list_miners`,
   `nightshift_verify_task`).
2. `telegraph_list_intents` (live): the tool call executed and returned the
   live node catalogue; the full payload exceeded the agent's model-output
   budget and the turn reported the truncation honestly. Count confirmed
   separately below.
3. `nightshift_create_free_investigation` (live): task
   `ef9f9867-7f6b-4124-8b64-02e6f71285c7`, `state: completed`,
   `jobType: mind_investigation`, `spentUsdCents: 0`, summary
   "INVESTIGATION COMPLETED for MARA HOLDINGS INC in free mode: no specialist
   intelligence was purchased; the report states exactly what remains
   unknown."
4. `nightshift_get_task_evidence` + `nightshift_verify_task`: evidence kind
   `counterparty_finding`; verdict **`unverified`** — the honest outcome for a
   free run (no purchased node signal exists to re-check), `spendUsdCents: 0`,
   no unresolved gaps.
5. `nightshift_request_intelligence` (operator bearer): task
   `b4cf2abe-5c39-41eb-a90b-cd6c034b7096`, `state: awaiting_approval`,
   "No payment has been signed and nothing has executed." The agent was not
   given and did not use any approval path.

## Hermes Agent (real agent turns, not SDK-only)

1. `hermes mcp test nightshift`: Connected (1133 ms), 9 tools discovered,
   Authorization masked as `***` (header auth active from the runtime's
   `.env`).
2. Tool discovery in-session: all nine tools named; `telegraph_list_intents`
   returned the live catalogue: **136 intents**, first title
   `ACADEMIC_SEARCH_GENERAL`.
3. Free investigation: task `09874a57-0900-4145-bb13-10ccc6088deb`,
   `completed`, `mind_investigation`, `spentUsdCents: 0`, same honest free
   summary as OpenClaw.
4. Evidence + verification: `counterparty_finding`, verdict **`unverified`**
   (honest, $0.00), no unresolved gaps.
5. Paid request: task `60528841-3287-4be4-8d35-99ada45e7bae`,
   `awaiting_approval`, same no-payment-signed quote. Auth proven by the paid
   gate passing (anonymous callers are refused with 401).

## Endpoint-level checks on the same build

- Anonymous `GET /api/hunyuan/decision-assurance` → **401**; anonymous `POST`
  → **401** (audit fix).
- `GET /api/hunyuan/status` (operator) reports the provider's actual state:
  `{"provider":"tencent-hunyuan","configured":false,"missing":["HUNYUAN_API_KEY"],...}`
  — honest, no simulated live inference.
- `/api/mcp` initialize handshake works anonymously (discovery-level
  clearance by design).
- Live intents via direct client: 136 intents on
  `https://devnode.telegraphprotocol.com` (free discovery, no key).

## Known limitations

- The free run's verdict is `unverified` by design: free evidence is analysis,
  not a purchased node signal, so the independent verifier refuses `verified`
  (audit-fix behaviour).
- Live-intent payloads are large; in agent turns the result must be narrowed
  (count/title) to fit the model budget.
- The fresh preview for `7a80f28` is live and healthy but gated by Vercel
  Authentication (team SSO): external agents receive 401/HTML before the app
  (Round 2 records the exact refusals). Until deployment protection is
  disabled or a bypass secret is issued, agent-facing verification must use a
  build of the same commit — the deployed round against the public URL is the
  one remaining step, blocked on a team-side Vercel action.
