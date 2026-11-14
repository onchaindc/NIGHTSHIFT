# NIGHTSHIFT

Explorer and payment terminal for the Telegraph network.

Reads live miner, evaluator, validator, intent and signal registries from the public Telegraph node. Quotes the node's own x402 payment challenge before any signature. Executes a single paid ask only after an explicit approval pinned to that exact offer. Records the receipt and signal hash. Never retries a paid request that cannot be verified.

## Stack

- Next.js 16 (app router), React 19, TypeScript
- Tailwind CSS 4
- x402 (`@x402/evm`, `@x402/fetch`) for USDC payments on Base Sepolia
- Neon Postgres (pooled) with a file-store fallback
- Vitest

## Ask flow

```
Discover  →  free GET of miner/intent catalogs
Probe     →  unpaid POST; node returns 402 + priced challenge
Approve   →  user pins the exact offer (amount, payTo, network, asset)
Execute   →  signed x402 payment; node returns answer + receipt + signal_hash
Verify    →  optional GET /engine/v1/signal/{hash} + local re-derivation
```

Invariants enforced in `src/lib/terminal/ask.ts` and the execute route:

- No signature without an explicit approval that matches the live challenge.
- Server refuses if the challenge has drifted from the approved offer.
- A paid response that cannot be reconciled (missing or mismatched `signal_hash`) is not retried.
- Uncertain payments are recorded as uncertain; they are never converted into a second charge.

## Storage

Single interface in `src/lib/storage`. Two implementations:

- Postgres (`src/lib/storage/postgres.ts`) — schema applied on first use; migrations tracked in `ns_migrations`. On serverless, prefers a pooled URL.
- File (`src/lib/storage/file.ts`) — local development only.

If multiple database URLs are set, each is probed with `SELECT 1`; the first reachable candidate is used. Unreachable candidates are reported by hostname, not by full URL.

Leases (`ns_leases`) prevent concurrent scheduler ticks from double-running the same watch.

## Protocol Watch

Standing monitors against public sources (GitHub releases/commits, docs URL content hash, Discourse JSON, RSS/Atom). Fingerprints are stored; a change produces a finding. Optional Telegram delivery.

On long-running processes the in-process scheduler fires every `NIGHTSHIFT_WATCH_INTERVAL_MS` (default 10 min). On Vercel Hobby the external cron in `vercel.json` is daily (`17 7 * * *`). Set `NIGHTSHIFT_EXTERNAL_CRON=1` so `/api/status` reports `workerMode: "external-trigger"` instead of claiming an in-process worker. Overlapping ticks are idempotent via fingerprints and leases.

## Routes

| Path | Purpose |
| --- | --- |
| `/` | Live counts, roles, current price for one ask |
| `/miners`, `/evaluators`, `/validators`, `/intents` | Registry views |
| `/signals`, `/signals/[id]` | Daemon signals |
| `/activity`, `/activity/[id]` | Recorded asks, payments, receipts, ledger reconciliation |
| `/terminal` | Compose, probe, approve, execute, verify |
| `/watch` | Configure and run Protocol Watches |
| `/developers` | Integration notes and request shapes |
| `/api/status` | Scheduler health, storage mode, node reachability |
| `/api/terminal/preview` | Unpaid probe |
| `/api/terminal/execute` | Approved paid step |
| `/api/terminal/verify` | Signal registry check |
| `/api/watches` | Watch CRUD and check |
| `/api/telegram/webhook` | Telegram adapter |

## Local

```bash
bun install
bun run dev          # http://localhost:3000
bun run typecheck
bun run test
```

## Configuration

Secrets in `.env.local`. Never read or printed by the app.

| Key | Purpose |
| --- | --- |
| `TELEGRAPH_NODE_URL` | Node base (default testnet) |
| `TELEGRAPH_EVM_PRIVATE_KEY` | Signs x402 payments (server only) |
| `DATABASE_URL` / `NIGHTSHIFT_DATABASE_URL` | Postgres (pooled preferred) |
| `DATABASE_URL_UNPOOLED` | Fallback only |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Optional Telegram adapter |
| `NIGHTSHIFT_EXTERNAL_CRON` | `1` on Vercel so status reports external-trigger mode |
| `NIGHTSHIFT_WATCH_INTERVAL_MS` | In-process scheduler interval (long-running only) |

Without a database URL the file store is used. Suitable for local work only.

## Status

`GET /api/status` returns node reachability, storage mode, and scheduler state (`autoChecks`, `intervalMs`, `workerMode`, `degraded`, `degradedReason`, `lastSuccessAt`, `consecutiveFailures`, `cronHint`). Missing integrations are reported as unconfigured. A stopped or lagging scheduler is named as degraded.
