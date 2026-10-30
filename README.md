# NIGHTSHIFT

An autonomous task-execution agent. It takes a goal, plans the work, executes permitted
actions, buys intelligence from the **Telegraph** network when useful, adapts to failures,
and verifies the final outcome, all within explicit spending limits and permission
boundaries.

**Until the work is done.**

---

## What is implemented vs. what is not

**Implemented and working:**

- A shared server-side **task engine** (`src/lib/engine/`) used by both the web app and the   Telegram bot: task states, structured execution events, JSON-file persistence, spending
  limits enforced against the network's actual price, permission boundaries, retries,
  failure handling, and evidence-based result verification.
- A real **Telegraph integration** (`src/lib/telegraph/client.ts`) following the official
  x402 flow documented at `docs.telegraphprotocol.com` (see below): free discovery → 402
  payment challenge → spend check → payment signature → receipt decode → signal lookup.
- A **Telegram bot adapter** (`src/lib/telegram/adapter.ts`) over the official Bot API with
  a webhook route and secret-token verification. `/goal`, `/tasks`, `/status`, `/approve`,
  `/reject` all drive the same engine.
- A dark **web console** (`/`): goal input, task state, execution timeline, spend meter,
  final result with verifiable evidence.
- A **goal-completion loop**, not just a purchase: each task (1) buys an answer via the
  Engine auto route, (2) feeds the purchase's own settlement `tx_hash` into a real,
  read-only Base Sepolia RPC check that independently confirms the payment was mined, and
  (3) completes only if every success criterion (defined before execution) passes against
  recorded evidence (signal match, plausibility, freshness, on-chain settlement).
- **Recovery**: failures are classified. Transient routing blips are retried within a
  strict cap; budget refusals and missing credentials are never retried; paid responses
  that arrive unverifiable are never re-sent, so an uncertain paid outcome can never
  become a double charge.
- Both surfaces served by the same engine: the **web console** (`/`) and the **Telegram
  bot** (`@nightshiftagent_bot`, via `setWebhook` against `/api/telegram/webhook`). Every
  flow enforces the same spending limits, permission boundary, and approval gate.
- Newer application structure (same engine, same APIs): a dark **Command Center** at `/`
  (Dashboard, Agents, Operations, Approvals, History, Settings navigation; real metrics from
  the task store and spending ledger; an operations launcher for supported job types),
  dedicated **Task Detail** routes (`/tasks/:id`) with the full timeline, spending and every
  recorded evidence item, a **Work History** view with status filters, and test records from
  the automated interaction audit tagged and separated, never presented as ordinary user work.
- **Protocol Watch**, the flagship capability (`src/lib/watch/`, `/watch`): monitor a
  protocol's legitimate public sources, detect real changes, investigate what matters, and
  deliver a verified report.

  * Supported source types: GitHub releases and commits, public docs pages, Discourse
    governance forums, and RSS/Atom security feeds. All fetched for real; a source that
    cannot be read is recorded as a source error, never invented.
  * Free checks read sources and diff against persisted per-source fingerprints:
    first observations record a baseline instead of a false alarm, unchanged content
    produces nothing, and a changed source produces a finding grounded in the fetched
    data itself (`source-direct` confidence).
  * Optional paid investigation buys a bounded Telegraph insight, cross-checks its words
    against the fetched source data, and marks findings `cross-checked` only when the two
    agree; otherwise `uncertain`. All-sources-failed runs fail honestly with the reason.
  * A **scheduler** (`src/lib/watch/scheduler.ts`, registered in `instrumentation.ts`)
    runs free checks every 10 minutes while the server process lives; monitoring pauses
    when the process stops (stated in the UI) and resumes without repeating old changes.
  * Reports land in the Command Center history and, when a chat id is configured, are
    delivered via the Telegram bot; delivery failures are recorded, not hidden.
  * API: `GET/POST /api/watches`, `GET/PUT/DELETE /api/watches/:id`,
    `POST /api/watches/:id/check` (body `{"investigate": true}` for the paid step).
  * Config, budget per run and fingerprints persist in `.data/watches.json`.
- 91 tests: task state transitions and goal-intent classification, permission checks
  (including the read-only `chain.read` boundary), budget refusals, recovery retries,
  verification failures (unmined settlement, implausible answers, stale evidence,
  wrong-asset answers), the spending ceiling and approval values the composer sends,
  duplicate-submission guards, the Telegram adapter's at-most-once update handling and
  approval flow, and Protocol Watch's source failures, duplicate suppression, evidence
  verification, budget enforcement, Telegram delivery failures, and persistence.

**Production hardening (Protocol Watch):**

- **SSRF guard**: user-supplied source targets must be http(s), resolve to public
  addresses only (private, loopback, link-local, CGNAT, ULA including
  `fd00:ec2::254`-style cloud metadata are blocked), and every fetch CONNECTS to the
  validated IP (hostname used only for TLS SNI and the `Host` header) with manual
  redirect following, so DNS rebinding and redirect-to-metadata cannot bypass the
  check. Targets are revalidated again at watch creation.
- **Worker reliability**: the schedule derives from persisted `lastCheckedAt`, so a
  restart resumes and catches up; a live worker writes `scheduler-state.json` and
  takes a ttl lease (`scheduler.lock`), so a second process skips the tick instead of
  stacking scans; even overlapping scans are idempotent because findings are
  fingerprint-gated. `/api/status` and the watch page report last success, next run,
  other-worker detection and named degraded reasons; monitoring honestly pauses when
  the process stops.
- **API authorization**: with `NIGHTSHIFT_API_TOKEN` set, watch creation, deletion and
  check triggering require `Authorization: Bearer <token>`; `/api/status` reports the
  auth mode as `open` or `token` so an operator can never mistake the two.
- **Hosting note**: the JSON stores (`.data/*.json`) require a persistent volume in
  production. On an ephemeral filesystem, config, fingerprints and run history reset
  and the first observation after that just re-baselines without raising false alarms,
  but real continuous monitoring needs a persisted volume (or swap-in database).

**Deliberately not implemented (no fakery):**

- No simulated purchases, miners, rankings, verifications, or transactions. If paid
  inference is not configured (`TELEGRAPH_EVM_PRIVATE_KEY` missing), tasks end in the
  `blocked` state with an explicit event. It never fabricates success.
- No invented multi-agent swarm. The planner (`src/lib/engine/planner.ts`) maps every
  goal honestly to the capabilities that exist today: purchase, an independent on-chain
  settlement check, and criteria verification. Richer planning (more intents, more tools)
  is future work.
- Single-process JSON-file persistence (`.data/tasks.json`); swap
  `src/lib/engine/store.ts` for a database when multi-instance deployment matters.

## Telegraph: how the integration actually works

Verified against the official docs (docs.telegraphprotocol.com, "Paying with x402",
"Intents", "Addresses & Parameters") and against the live testnet node:

1. **Discovery is free and keyless.** `GET /api/miners` / `GET /engine/v1/intents` on the
   node return the live miner catalog and the 134 canonical intents.
2. **Inference is paid via x402 (HTTP-native, no API key).** `POST /engine/v1/ask` returns
   **HTTP 402** with a `PAYMENT-REQUIRED` header (base64 JSON challenge). The challenge's
   `accepts` list is authoritative for network, asset, `amount` (6-decimal USDC units
   where `10000` = $0.01) and `payTo`; NIGHTSHIFT reads the amount and checks it against the
   task's remaining spending limit **before signing anything**.
3. **Payment & retry.** Official packages `@x402/fetch` + `@x402/evm` (used by the
   Telegraph MCP server) sign an EIP-712 exact-scheme USDC authorization on Base Sepolia
   (chain `84532`) and retry the identical request with `PAYMENT-SIGNATURE`. The node
   verifies through the PayAI facilitator before calling the miner.
4. **Receipt.** A delivered 200 carries `X-TELEGRAPH-RECEIPT` (base64 JSON with
   `receipt_hash`, `amount_uusdc`, `miner`, `intent`, `tx_hash`, …). NIGHTSHIFT keys spend
   accounting on `receipt_hash` (not `tx_hash`, which can be batched by the facilitator).    Note: the challenge's `amount` is in **6-decimal USDC units** (10000 = $0.01), so a
   conversion bug here amounts to a 100× accounting error, and the unit conversion has
   been verified against the on-chain wallet balance.
5. **Verification.** Every paid call is committed as a signal. NIGHTSHIFT calls
   `GET /engine/v1/signal/{signal_hash}` and compares the node's recorded `result` against
   the answer it accepted; a mismatch or missing record fails the task. A task reaches
   `completed` **only** when every success criterion passes: matching signal record,
   receipt on file, plausible answer, evidence freshness, and the payment's settlement
   transaction mined on Base Sepolia (read directly from a public RPC, trusting no miner    claim (we observed a miner misclaim "transaction not found" for a successfully mined
    settlement).

**What you must provide to buy intelligence:** a wallet private key with test USDC on
Base Sepolia. Faucet: `https://faucet.circle.com` (20 test USDC per 2 h) plus test ETH for
gas. There is no Telegraph API key, the 402 flow *is* the authentication. Without the key
the app still runs; tasks simply end `blocked` with the missing key named.

**Known doc limitation (reported):** the official docs say to re-derive the signal hash
yourself but do not publish the exact hash recipe, so client-side verification checks
existence + result equality against the node record, the strongest check available today.

## Setup

```bash
npm install            # or bun install
cp env.example .env.local    # then fill values (none are required to run unblocked)
npm run dev            # http://localhost:3000
```

Environment variables (all optional for a first look):

| Key | Purpose | Missing => |
|---|---|---|
| `TELEGRAPH_NODE_URL` | Telegraph node (defaults to the official testnet) | falls back to testnet |
| `TELEGRAPH_EVM_PRIVATE_KEY` | x402 payment signer (Base Sepolia USDC) | tasks end `blocked` at the purchase step; nothing is charged |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | bot replies that it is not configured |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook authenticity check | webhook accepts all updates (e.g. local dev) |
| `NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS` | Default per-task ceiling (default 100 = $1.00) | uses default |
| `NIGHTSHIFT_API_TOKEN` | Operator token gating watch-management calls | watch management is open |
| `NIGHTSHIFT_WATCH_AUTOCHECK` | Set to `0` to disable scheduled watch scans | auto checks on |
| `NIGHTSHIFT_WATCH_INTERVAL_MS` | Auto-scan interval (default 600000 = 10 min) | uses default |
| `NIGHTSHIFT_DATABASE_URL` | Postgres connection string (Neon pooled endpoint recommended; `DATABASE_URL` also honored) | JSON file stores under `.data` (durable locally, non-durable on serverless) |

## Durable persistence (Postgres)

Set `NIGHTSHIFT_DATABASE_URL` and every store — task history, watch configs
and fingerprints, Telegram dedup state, scheduler state and leases — moves to
versioned, indexed Postgres tables (`ns_tasks`, `ns_watches`, `ns_kv`,
`ns_seen_updates`, `ns_leases`). The connection is serverless-safe (single
pooled connection per runtime, no named prepared statements). Atomicity comes
from the database: unique-key upserts, `ON CONFLICT DO NOTHING` claims,
transactional lease acquisition, `SELECT … FOR UPDATE` watch mutations.

Apply migrations with:

```bash
bun run db:migrate   # runs scripts/db-migrate.ts; idempotent, safe against an up-to-date DB
```

Without a database everything still works on the local JSON stores; on Vercel
without one, `/api/status` reports `persistence.durable: false` and names the
`/tmp` fallback honestly instead of pretending history survives cold starts.

## Deploying to Vercel

NIGHTSHIFT runs on Vercel as-is (verified paths below), with two platform
realities the app handles for you and one you must configure:

1. **Writable storage.** Vercel functions have a read-only deployment
   filesystem; only `/tmp` is writable. Every JSON store (tasks, watches,
   fingerprints, scheduler state) writes to `/tmp/nightshift-data`
   automatically on Vercel, so nothing fails at launch. `/tmp` is per function
   instance and wiped on cold starts, so `/api/status` reports
   `persistence.durable: false` there. For durable history and fingerprint
   continuity across cold starts, set `NIGHTSHIFT_DATA_DIR` to a mounted
   persistent volume (or swap the store module for a database later; the
   engine is storage-agnostic). With the default `/tmp` behavior the first
   scan after a cold start simply re-baselines instead of raising false
   alarms.
2. **Background execution.** Operations, watch checks, approvals and Telegram
   updates all run *after* the HTTP response via Next.js `after()`, so a
   function duration limit never cuts a paid or network-bound run mid-flight;
   routes export `maxDuration = 60` (raise it in `vercel.json`/plan settings
   for longer windows).
3. **Scheduled monitoring (you must configure this).** There is no long-lived
   process on Vercel, so the in-process interval timer deliberately does not
   run there. Schedule scans by pointing a cron at
   `GET /api/watches/scheduler-tick` (free checks only, idempotent via
   fingerprints). `vercel.json` ships with a daily cron; on Vercel Pro raise
   its frequency (Hobby allows one daily cron), or use any external scheduler.
   Set `NIGHTSHIFT_EXTERNAL_CRON=1` when the trigger is configured so
   `/api/status` knows scheduled checks are expected to happen. Ungated open
   deployments expose this endpoint publicly; it only runs free source reads,
   but set `NIGHTSHIFT_API_TOKEN` to lock it down.

Telegram on Vercel: register the webhook exactly as in the Setup section,
with `TELEGRAM_WEBHOOK_SECRET` set, and keep `TELEGRAM_BOT_TOKEN` in Vercel
env vars. If `NIGHTSHIFT_API_TOKEN` is set, the web dashboard's watch
management buttons require the same bearer token, which the UI does not send;
use the API directly, or leave the token unset for UI-driven management.

Telegram webhook registration (after the app is reachable over HTTPS):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<domain>/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

## API surface

- `POST /api/tasks` `{ goal, spendLimitUsdCents?, requiresApproval? }`: create (+ run) a task
- `GET /api/tasks` / `GET /api/tasks/:id`: task records with full execution timelines
- `GET /` **Command Center**: dashboard, agents, operations, approvals, history, settings
- `GET /watch` **Protocol Watch**: configure watches, run checks, review recorded runs
- `GET /history`: filtered work history (status groups, test records separated and labeled)
- `GET /tasks/:id`: single task with timeline, spending, outcome, and evidence
- `POST /api/tasks/:id/action` `{ action: "approve" | "reject" }`: approval gate
- `GET/POST /api/watches` + `GET/PUT/DELETE /api/watches/:id` + `POST /api/watches/:id/check`: Protocol Watch
- `POST /api/telegram/webhook`: Telegram Bot API webhook (secret-token verified)

## Checks

```bash
npm run test        # 65 tests (engine, watch, UI form rules, Telegram adapter)
npm run typecheck   # tsc -b --noEmit
npm run build       # production build
```

## Invariants (enforced and tested)

1. State transitions are whitelisted; no illegal jump passes.
2. `telegraph.ask` runs only if in the task's `allowedActions`.
3. The 402 challenge amount is checked against the remaining budget before any payment is
   signed; budget refusals are never retried into an overspend.
4. `requiresApproval` tasks stay in `awaiting_approval` until an explicit approve.
5. Only a delivered 200 with a receipt is accounted as spend; failed calls cost nothing
   on the network and are never logged as spend.
6. `completed` requires evidence (matching signal record + receipt); every failure path
   stays `failed`/`blocked` with machine-readable reasons.
