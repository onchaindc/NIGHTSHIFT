# NIGHTSHIFT

A live explorer for the **Telegraph** network. It shows who is answering questions, what
they cover, what one ask costs right now, and every payment and receipt behind an answer.

Nothing on the screen is mocked. Miner, evaluator and validator registries are read from the
public node at request time, and the price shown is the node's own payment challenge.

---

## What you can do here

| Route | What it is for |
| --- | --- |
| `/` | Overview: live counts, the four roles, and today's price for one ask |
| `/miners` | Every miner answering, with endpoints, supported intents and price |
| `/evaluators` | Evaluators scoring answers, per intent |
| `/validators` | Validators countersigning settlement |
| `/intents` | The shared vocabulary of question types |
| `/signals` | Signals produced by the Telegraph daemon, with detail pages |
| `/activity` | Recorded requests, payments, receipts and reconciliation |
| `/terminal` | Compose one ask, see the exact price, approve it, get the answer |
| `/developers` | Integration guide: endpoints, request shape, payment flow, code samples |

## The ask flow

```
1. Discover   free       read the miner catalog
2. Probe      HTTP 402   the node returns a priced offer
3. Pay        x402       you sign the exact amount, once
4. Answer     HTTP 200   the answer arrives with a receipt and a signal hash
```

The Terminal follows the same four steps in the browser. Nothing is signed until you approve
the exact amount that was quoted, and a paid response that cannot be verified is never
retried, so an uncertain payment can never become a double charge.

## Data and persistence

- **Reads** for the explorer come from the public Telegraph node. A failed read is shown as a
  failed read, never as an empty success.
- **Writes** (asks, terminal attempts, watches) go through one storage layer
  (`src/lib/storage`) with a Postgres implementation and a file-based fallback for local
  development.
- The Postgres backend applies its schema on first use, so a fresh database becomes usable
  without a manual migration step. Migrations are versioned and recorded in `ns_migrations`.
- If more than one database URL is configured, each candidate is probed with a read-only
  `select 1` and the first one that answers is used. A candidate that cannot be reached is
  reported by hostname and error code only.

Useful commands:

```bash
bun run db:migrate   # apply the schema explicitly
bun run db:verify    # apply schema, round-trip a probe row, remove only that row
```

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Integration and storage status |
| `GET /api/network` | Registry aggregates used by the overview |
| `GET/POST /api/tasks` | Task records behind Activity |
| `POST /api/terminal/execute` | The approved, paid step of a Terminal ask |
| `GET/POST /api/watches` | Protocol watches |
| `GET /api/daemon/...` | Daemon signals and metadata |
| `POST /api/telegram/webhook` | Telegram bot adapter |

## Local development

```bash
bun install
bun run dev        # http://localhost:3000
bun run typecheck  # tsc -b --noEmit
bun run test       # vitest
```

## Configuration

Secrets live in `.env.local` and are never read or printed by the app or by tooling. The keys
this project understands:

| Key | Used for |
| --- | --- |
| `DATABASE_URL` | Postgres for tasks, watches and leases (use a pooled URL on serverless) |
| `NIGHTSHIFT_DATABASE_URL` | Optional primary database URL, takes precedence over `DATABASE_URL` |
| `DATABASE_URL_UNPOOLED` | Fallback only, used when no primary URL is set |
| `TELEGRAPH_EVM_PRIVATE_KEY` | Signing x402 payments in the Terminal |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Telegram adapter |

Without a database URL the app runs on the file store, which is fine for local work and not
intended for production.

## Design

The interface is a light editorial console: warm paper background, white surfaces with hairline
borders, one amber accent, and Geist with a serif display face for headings. Numbers always
render on a tabular grid. Motion is limited to what explains state: a packet travelling the ask
rail, a live dot, a caret, and short section reveals. All of it is disabled under
`prefers-reduced-motion`.
