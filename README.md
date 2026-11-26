# NIGHTSHIFT

**Explore the network. Put its intelligence to work.**

NIGHTSHIFT is a commercial intelligence workspace built on the [Telegraph network](https://telegraph.network). It helps people discover specialist intelligence providers, investigate companies and assets, compare evidence, and turn network answers into decisions that can be reviewed and acted on.

NIGHTSHIFT brings Telegraph network discovery, specialist intelligence, evidence verification, and commercial investigation workflows into one integrated workspace.

Production: https://nightshift-telegraph.vercel.app  
Repository: https://github.com/onchaindc/NIGHTSHIFT

## What it does

NIGHTSHIFT currently brings four investigation workflows together in the Deal Desk:

| Workflow | Purpose |
| --- | --- |
| Counterparty Due Diligence | Build an evidence-backed view of a company or business counterparty. |
| Listing Underwriting | Assemble and assess intelligence relevant to a digital-asset listing decision. |
| Asset Intelligence | Investigate digital-asset, mining, and energy-related assets. |
| Trade & Supplier Intelligence | Examine suppliers, trade records, documents, and logistics-related information. |

The workspace also includes the network Explorer, Terminal, Minds integrations, activity records, developer information, and a Virtuals ACP provider surface.

The product is designed around a simple distinction: discovering an answer is not the same as establishing that the answer is reliable. NIGHTSHIFT retains the source material and verification outcome so users can see what is known, what failed verification, what remains unconfirmed, and what is analysis.

## Product surfaces

- **Explorer** — discover miners, canonical intents, signals, and network activity.
- **Terminal** — inspect a specialist service's live offer, approve the exact terms, execute an x402 request, and inspect its receipt and signal.
- **Deal Desk** — open structured investigations, collect evidence, review discrepancies, and produce an assessment with explicit limitations and next actions.
- **Minds** — expose investigation workflows to Minds through an API-connected tool pattern, with optional report delivery through the supported Builder API configuration.
- **ACP** — publish the Deal Desk workflows as Virtuals Agent Commerce Protocol services and track incoming jobs and deliverables.
- **Activity** — inspect task and investigation records according to the caller's access level.
- **Developers** — inspect the integration surface and API guidance.

## How an investigation works

A Deal Desk file is a structured investigation, not a single prompt and response.

1. **Open a file.** Choose a workflow and provide the subject details. User-supplied information is retained as declared input; it is not silently promoted to verified evidence.
2. **Map the requirements.** The workflow identifies the capabilities it needs and records unsupported requirements as explicit gaps.
3. **Run the free pre-flight.** NIGHTSHIFT checks the relevant Telegraph route and live offer without paying. This establishes availability and price, not the truth of the eventual answer.
4. **Review and approve.** A paid run waits for human approval. The approved offer and spend ceiling are recorded before a payment is signed.
5. **Execute specialist requests.** The engine makes the approved requests and records their answers, receipts, signal references, and costs.
6. **Verify and reconcile.** Where a signal supports independent re-derivation, NIGHTSHIFT checks the committed payload. Provider disagreements and missing fields remain visible.
7. **Produce the report.** Findings, discrepancies, evidence, confidence, limitations, and next actions are assembled into a reviewable investigation record.

The same task engine, spend ledger, permissions, and approval rules are reused across the product rather than reimplemented for each interface.

## Evidence and verification

Evidence integrity is a core product rule.

Every evidence item is assigned a provenance class:

| Class | Meaning |
| --- | --- |
| `verified` | The payload was independently re-derived against its committed signal, or the value came from a supported direct source read. |
| `verification_failed` | The retained payload did not pass independent signal re-derivation. It remains available for inspection but is not treated as a verified fact. |
| `unverified` | The answer is based on a node assertion, lacks independent confirmation, or comes from a declared input. |
| `missing` | A required value was not supplied or the network could not answer the requirement. |
| `analysis` | NIGHTSHIFT's synthesis of recorded evidence. It is labelled as analysis and linked to the evidence it uses. |

A successful HTTP response is not, by itself, proof of correctness. A node's own `verified` label is not substituted for independent verification. If a committed payload fails re-derivation, NIGHTSHIFT preserves the answer, signal, receipt, and failure reason, but classifies it as `verification_failed`.

Reports distinguish verified facts from failed verification, node-asserted answers, missing information, and analysis. They also preserve provider disagreements rather than silently choosing one value. The final assessment is decision support, not a legal opinion, sanctions clearance, credit rating, or investment recommendation.

## Terminal and x402 payment flow

The Terminal uses a probe / approve / execute / verify sequence:

```
Discover  -> free network catalog reads
Probe     -> unpaid request; inspect the live 402 challenge
Approve   -> explicitly pin amount, recipient, network, and asset
Execute   -> sign and send the x402 payment; receive answer and receipt
Verify    -> resolve the signal and independently re-derive its payload
```

Important safeguards:

- A payment signature requires explicit approval of the live offer.
- If the offer changes after approval, execution is refused.
- Paid specialist requests are not automatically retried after an ambiguous or unreconciled payment.
- Uncertain payment outcomes remain uncertain; they are not treated as permission to charge again.
- Paid Deal Desk and Minds investigation steps stop at a human approval gate.
- Spend ceilings and ledger entries are retained with the task.

The current configured x402 integration uses USDC on Base Sepolia for the documented test flow. Check the live challenge in the Terminal for the actual network and terms; do not assume a price or recipient from an old example.

## Minds integration

NIGHTSHIFT can expose an investigation endpoint to a Minds agent as an API-connected tool. The Mind submits an objective and selects either:

- **Free mode:** unpaid pre-flight and a baseline report. It does not purchase specialist intelligence.
- **Intel mode:** baseline, a paid specialist request, and a comparison report. The paid step waits for human approval.

The investigation planner is deterministic. It extracts a company and, where stated, a jurisdiction. If it cannot identify a usable subject, it blocks instead of inventing one. The resulting report compares what was available before specialist intelligence with what the paid evidence added, while retaining unresolved gaps and disagreements.

Builder API outbound delivery is optional and environment-gated. A configured key and a bound Mind alias are required. Without those settings, delivery is skipped and reported as such; the existence of an investigation report does not imply that a message was delivered.

Official documentation: https://build.hellominds.ai/docs/get-started/client-library

## Virtuals ACP provider

NIGHTSHIFT includes a provider integration for [Virtuals ACP](https://app.virtuals.io/). The four Deal Desk workflows are represented as service offerings with workflow-specific input schemas.

At a high level, the provider lifecycle is:

1. Receive an ACP job and validate its requirements against the selected workflow.
2. Set the service budget through the ACP v2 acceptance flow.
3. On funding, create or resume one Deal Desk investigation for that on-chain job.
4. Run the existing investigation engine, including its free pre-flight and human approval gate for any paid Telegraph work.
5. Submit the evidence-backed report as the job deliverable.
6. Mark the job complete only when the evaluator's on-chain completion event is received.

ACP settlement is tracked separately from Telegraph x402 payments. The two payment systems are not conflated.

The code includes a mock transport for controlled simulation and a real adapter based on `@virtuals-protocol/acp-node-v2`. Real mode is gated by `ACP_ENABLED=true` and the provider wallet / signer configuration. A configured code path is not the same as a verified live connection: check the ACP status surface and deployment diagnostics before treating the provider as operational. Do not fund or run a paid ACP job until the real connection, wallet permissions, and spend controls have been verified.

## Architecture

NIGHTSHIFT is a Next.js application with a shared server-side task and investigation engine.

| Area | Responsibility |
| --- | --- |
| `src/app` | App Router pages and API routes. |
| `src/lib/engine` | Task lifecycle, planning, execution, approvals, and spend accounting. |
| `src/lib/desk` | Deal Desk investigation records, workflows, evidence, reports, and assessment. |
| `src/lib/terminal` | x402 probe, approval, execution, and signal-verification flow. |
| `src/lib/mind` | Mind objective parsing, deterministic plans, and report integration. |
| `src/lib/acp` | ACP provider boundary, lifecycle handling, mock transport, and real SDK adapter. |
| `src/lib/storage` | Shared persistence interface and storage implementations. |

The storage layer uses Postgres in deployed environments and a file-backed implementation for local development. The Postgres adapter supports pooled connections for serverless deployments. Database migrations are tracked by the application.

Access is identity-aware. Wallet-signed sessions provide user access to owned records, while operator access can inspect operational records. Anonymous views use restricted projections; private objectives, full reports, purchased intelligence, and payment details are not exposed as public activity data.

## Local development

### Requirements

- Node.js 20 or newer
- npm
- A reachable Postgres database for database-backed local testing

### Install and run

```bash
git clone https://github.com/onchaindc/NIGHTSHIFT.git
cd NIGHTSHIFT
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

For database setup and verification:

```bash
npm run db:migrate
npm run db:verify
```

The local file store is intended for development and tests, not multi-instance production persistence.

## Configuration

Production integrations are enabled through environment configuration. Never commit secrets or paste private keys into source files, issues, or logs.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string; use a pooled connection URL for serverless deployments where available. |
| `NIGHTSHIFT_API_TOKEN` | Operator API authorization for privileged operations. |
| `NIGHTSHIFT_USER_DAILY_SPEND_CENTS` | Optional per-user rolling daily spend cap for payer-funded Mind runs. |
| `MINDS_BUILDER_API_KEY` | Optional Minds Builder API credential for outbound delivery. |
| `MINDS_BUILDER_ALIAS` | Alias already bound to the intended Mind. |
| `ACP_ENABLED` | Must be `true` before the real ACP transport can be selected. |
| `ACP_PROVIDER_WALLET_ADDRESS` | EVM address for the ACP provider wallet. |
| `ACP_WALLET_ID` | Privy wallet identifier used by the ACP provider adapter. |
| `ACP_SIGNER_PRIVATE_KEY` | Privy authorization signer key required by the ACP SDK adapter. Keep it server-side and secret. |
| `ACP_BUILDER_CODE` | Optional ACP builder code. |
| `ACP_CHAIN_ID` | ACP EVM chain ID; defaults to Base mainnet (8453) in the current adapter. |

Only configure the variables for integrations being deliberately enabled. In particular, do not enable ACP real mode merely to test the UI; use the mock/simulation path until the live provider configuration has been checked.

## Security and operating principles

- Paid actions require explicit approval and a bounded spend.
- User sessions are wallet-signed; privileged operator access remains server-side.
- Public activity responses are restricted projections, not full investigation records.
- Secrets are read from environment configuration and must never be committed.
- Failed verification is retained and disclosed, not hidden or relabelled.
- Missing capabilities and unsupported requirements are reported as gaps, not filled with guesses.
- Mock ACP simulation is not evidence of a live Virtuals connection or settlement.

## Current scope and limitations

NIGHTSHIFT is an active product and its integrations have different readiness levels. The Explorer, Terminal, Deal Desk, evidence model, Minds workflow, and ACP provider implementation are part of the codebase. That does not mean every external integration has been exercised end-to-end in production.

In particular:

- A live ACP provider connection and controlled end-to-end job still need explicit deployment verification before ACP should be described as operational.
- Minds outbound delivery depends on valid Builder API credentials and a bound alias.
- Telegraph answers vary by miner, intent, jurisdiction, and live network availability. A successful request is not a universal reliability guarantee.
- Reports are evidence-led decision support and do not replace independent legal, financial, compliance, or technical review.

## License

No open-source license is currently declared in this repository. All rights reserved unless and until a license is added.
