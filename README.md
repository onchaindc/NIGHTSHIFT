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

## Storage

Single interface in `src/lib/storage`. Two implementations:

- Postgres (`src/lib/storage/postgres.ts`) — schema applied on first use; migrations tracked in `ns_migrations`. On serverless, prefers a pooled URL.
- File (`src/lib/storage/file.ts`) — local development only.

If multiple database URLs are set, each is probed with `SELECT 1`; the first reachable candidate is used. Unreachable candidates are reported by hostname, not by full URL.
