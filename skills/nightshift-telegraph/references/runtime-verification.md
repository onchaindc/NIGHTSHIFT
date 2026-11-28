# Runtime verification record — OpenClaw and Hermes sessions

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
- The Vercel preview for `4404d04` (where the earlier deployment
  verification round passed) expired; these runtime tests used the local
  production build. Re-run against a fresh preview before merging if that
  deployment matters for the record.
