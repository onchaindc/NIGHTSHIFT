# Installing the NIGHTSHIFT Telegraph skill (OpenClaw and Hermes Agent)

The skill is a standard AgentSkills `SKILL.md` folder — no code to run — plus
a remote MCP endpoint the runtime connects to. Configure BOTH parts:
the skill folder teaches the workflow; the MCP connection provides the tools.

> Honesty note: these instructions describe the documented skill-loading
> mechanisms of each runtime. Both runtimes have now been exercised for real
> against a production build of this branch (local `npm start` server per
> section 4, token auth via each runtime's own secret store): tool discovery,
> live node discovery, a free investigation, evidence retrieval, independent
> verification and the paid approval gate all ran through real agent turns.
> The full transcript is in `runtime-verification.md`. When connecting to a
> NEW deployment, re-run the verification step below there before claiming
> runtime-tested status for that deployment.

## 1. Install the skill folder

### OpenClaw

OpenClaw loads AgentSkills-format skills from its skill directory (default
`~/.agents/skills`; workspace-local `skills/` folders in a project also work).

```bash
mkdir -p ~/.agents/skills
cp -r /path/to/nightshift/skills/nightshift-telegraph ~/.agents/skills/
```

Restart the OpenClaw session (or reload skills per its Skills config page) and
confirm the agent lists `nightshift-telegraph`.

### Hermes Agent

Hermes discovers skills in `~/.hermes/skills/` (primary), project-local
`.hermes/skills/` or `.agents/skills/`, and any configured external
directories. Pick one:

```bash
# a) copy into the primary directory
mkdir -p ~/.hermes/skills
cp -r /path/to/nightshift/skills/nightshift-telegraph ~/.hermes/skills/

# b) or keep one shared folder and point Hermes at it — ~/.hermes/config.yaml
skills:
  external_dirs:
  - ~/.agents/skills
```

Then run `hermes skills` (or ask the agent which skills it sees) and confirm
`nightshift-telegraph` appears.

Because both runtimes honor `~/.agents/skills`, a single copy can serve both.

## 2. Connect the MCP endpoint

Endpoint: `https://<deployment-host>/api/mcp` — Streamable HTTP transport,
stateless JSON mode (no session id; safe for serverless). Protocol: MCP
(Streamable HTTP, `2025-06-18`/`2025-11-25`).

Authentication: the MCP client sends
`Authorization: Bearer <NIGHTSHIFT_API_TOKEN>` on every request. Store the
token ONLY in the runtime's secret/config store or environment (e.g.
`NIGHTSHIFT_API_TOKEN` in the process environment, referenced by the MCP
connection settings). Never in the skill folder, never in logs, never in
browser-visible code. Without the token the tools still run in their public
clearance: discovery, free investigations, and discovery-level task views —
paid requests and private evidence are refused, by design.

- **OpenClaw**: add a remote MCP server connection in the OpenClaw
  configuration for MCP servers (see its "Connect MCP servers" docs) with the
  URL above and the Authorization header. Confirm with its MCP listing/status
  command that the 9 `telegraph_*` / `nightshift_*` tools are exposed.
- **Hermes Agent**: check the current MCP client mechanism in Hermes'
  "Toolsets Reference" (Tools & Skills Reference section) and register the
  same URL + header there. If MCP is unavailable in your Hermes build, the
  skill's REST fallback (curl over `/api/minds`, `/api/mind/investigations`,
  `/api/tasks`) works with the same bearer token and the same approval gate.

## 3. Verify the setup (required before first real use)

1. Ask the agent: "List your MCP tools" — it should name the nine tools from
   `references/tools.md`.
2. "Use telegraph_list_intents" — live node catalogue returns (`count` ≥ 1).
3. "Use nightshift_create_free_investigation with objective: Investigate
   MARA HOLDINGS INC in the US" — returns a task with `state: completed`
   (or a truthful failure if the node is down) and `spend.spentUsdCents: 0`.
4. "Use nightshift_request_intelligence with objective: ..." — the returned
   task MUST be `awaiting_approval` with no spend; then STOP and hand the
   approval decision to the human. The agent must never approve.
5. "Use nightshift_verify_task on the free investigation's taskId" — returns
   `verdict` with per-evidence provenance and `spendUsdCents: 0` in the task.

Record what actually happened (including failures) in your session notes;
that is what "tested" means.

## 4. Local development endpoint

```bash
npm install && npm run build && NIGHTSHIFT_API_TOKEN=dev-secret npm start
# endpoint: http://localhost:3000/api/mcp
```

Paid tools still stop at the approval gate even locally; approvals happen
through `POST /api/tasks/:id/action` with the same token, or the console.
