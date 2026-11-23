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

### Minds (Animoca) integration — verified surface only

Verified as of 2026-11-23 and used, without invention:

- Minds by Animoca Brands (`hellominds.ai`) is a persistent agentic AI platform;
  capabilities extend through the Bazaar as "Tools (API-connected apps)" — the
  pattern the investigations endpoint implements.
- Builder API keys come from `build.hellominds.ai/console` and travel as the
  `X-Builder-Api-Key` header (deprecated `X-Access-Key` may accompany).

Deliberately NOT implemented because it cannot be verified today: the exact
Builder API messaging paths. The June-2026 documented surface ("list Minds /
send message / SSE", spec at `/docs/openapi.json`) now returns 404, and the
official npm client is unlicensed. Outbound report delivery therefore runs
only when the operator supplies both `MINDS_BUILDER_API_KEY` and the full
`MINDS_BUILDER_SEND_URL`; otherwise delivery is skipped and reported honestly.
The path to full messaging access is the builder programme
(`build.hellominds.ai/program`) — a human step, not a code change.

## Storage

Single interface in `src/lib/storage`. Two implementations:

- Postgres (`src/lib/storage/postgres.ts`) — schema applied on first use; migrations tracked in `ns_migrations`. On serverless, prefers a pooled URL.
- File (`src/lib/storage/file.ts`) — local development only.

If multiple database URLs are set, each is probed with `SELECT 1`; the first reachable candidate is used. Unreachable candidates are reported by hostname, not by full URL.
