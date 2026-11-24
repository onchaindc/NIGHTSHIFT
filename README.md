# NIGHTSHIFT

**Explore the network. Put its intelligence to work.**

NIGHTSHIFT is an interactive interface to the Telegraph network. Explore its miners, discover available intelligence, inspect network activity, and query specialized services through a terminal powered by x402.

It brings Telegraph's infrastructure into one place, making it easier to understand what the network offers, access its capabilities, and see what each request returns.

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

## Mind investigations

NIGHTSHIFT's autonomous investigation Mind runs on the same task engine as every
other job (`jobType: "mind_investigation"`): plan → approval gate → execution →
verification → report, with the spend ledger and permission allowlist shared.

```
Objective  →  deterministic plan (src/lib/mind/plan.ts)
Baseline   →  FREE unpaid probe: validates the pinned specialist ask and
              assembles the without-intelligence dossier (0 registry facts —
              stated plainly, never guessed)
Approval   →  human approves the exact plan before anything is signed
Intel      →  PAID specialist ask through Counterparty Intelligence
              (pinned intent CORPORATE_REGISTRY_LOOKUP_GENERAL at
              zk-corp-atlas; one attempt, no retry, refuses offer drift)
Evaluate   →  keccak signal verification + the hash-committed payload
              classification (facts / missing fields / disagreements)
Report     →  reasoned report with the with/without-Telegraph comparison,
              every claim traced to recorded evidence
```

- Endpoint: `POST /api/mind/investigations` `{ objective, mode: "free"|"intel", spendLimitUsdCents? }` —
  gated by the operator bearer token like every spending-capable API; the
  caller polls `/api/tasks/:id` for live state and the report. Minds agents
  call it as a Bazaar-style "Tool (API-connected app)".
- Modes: `free` never plans a purchase; `intel` waits at `awaiting_approval`
  until a human approves via `/api/tasks/:id/action`.
- The comparison is meaningful by construction: the baseline pass and the paid
  pass answer the same canonical field set, so the report states exactly which
  fields intelligence added, what stayed unknown, which conflicts remain
  unresolved, and the verified cost.

### Minds (Animoca) integration — official Builder API

Verified 2026-11-24 from the official builder documentation and live host:

- Base host `api.build.hellominds.ai`; auth uses `X-Api-Key` with a Builder API
  key from `build.hellominds.ai/console` (OAuth access tokens use
  `Authorization: Bearer`). `X-Access-Key` and `X-Builder-Api-Key` are not sent.
- A stable alias must be bound to a Mind first, with
  `POST /v1/messaging/conversation` or `minds chat create`.
- Sending is `POST /v1/messaging/message` with `{ alias, messageText }`.
  There is no guessed path and no mocked delivery.

Outbound report delivery is environment-gated: set `MINDS_BUILDER_API_KEY` and
`MINDS_BUILDER_ALIAS` (already bound to a Mind). Without both, delivery is
skipped and reported honestly. `MINDS_BUILDER_SEND_URL` is only an optional
proxy/enterprise override. A live unauthenticated POST returns the API's
structured auth-required error, which verifies the route and auth boundary;
no message has been delivered from this workspace because no key is configured.

Docs: https://build.hellominds.ai/docs/get-started/client-library

## Storage

Single interface in `src/lib/storage`. Two implementations:

- Postgres (`src/lib/storage/postgres.ts`) — schema applied on first use; migrations tracked in `ns_migrations`. On serverless, prefers a pooled URL.
- File (`src/lib/storage/file.ts`) — local development only.

If multiple database URLs are set, each is probed with `SELECT 1`; the first reachable candidate is used. Unreachable candidates are reported by hostname, not by full URL.
