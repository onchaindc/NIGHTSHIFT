import Link from "next/link";

import { CodeBlock } from "@/components/developers/code-block";

export const metadata = { title: "Developers" };

/**
 * Developer Centre (Phase 6). Two sources only:
 *   1. The official docs (docs.telegraphprotocol.com — x402, engine-ask,
 *      mcp-server, daemon-signals, roles/miners/scoring/validators), linked
 *      in place, not duplicated wholesale.
 *   2. The contracts actually implemented in THIS codebase — every app
 *      endpoint below is documented exactly as src/app/api gates it.
 * Nothing invented: no endpoints, SDKs, capabilities or auth rules beyond
 * those two sources, and no fake playground (copy is the only control here).
 */

const SECTIONS = [
  { id: "getting-started", label: "Getting started" },
  { id: "api-reference", label: "API reference" },
  { id: "sdks", label: "SDKs" },
  { id: "mcp", label: "MCP" },
  { id: "payments", label: "Payments" },
  { id: "examples", label: "Code examples" },
  { id: "network-guides", label: "Network guides" },
];

const SNIP_DISCOVERY = `curl https://devnode.telegraphprotocol.com/api/miners?intent=WEATHER_FORECAST
curl https://devnode.telegraphprotocol.com/engine/v1/intents`;

const SNIP_PROBE = `# Unpaid pre-flight: body errors are refused for FREE, a valid body
# answers with the live 402 challenge (base64 in the PAYMENT-REQUIRED header).
curl -si https://devnode.telegraphprotocol.com/engine/v1/ask \\
  -H "Content-Type: application/json" \\
  -d '{"query":"What is the current exchange rate USD to EUR?"}'`;

const SNIP_PAID_ASK = `import { wrapFetchWithPayment } from "@x402/fetch";
import { createSigner } from "@x402/evm";

// Handles the 402 -> sign -> retry cycle; you just make the call.
const signer = createSigner(process.env.EVM_PRIVATE_KEY);
const fetchWithPayment = wrapFetchWithPayment(fetch, signer);

const res = await fetchWithPayment(
  "https://devnode.telegraphprotocol.com/engine/v1/ask",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "What is the current price of Bitcoin?" }),
  },
);
const body = await res.json();
console.log(body.result, body.signal_hash, body.cost_usd);`;

const SNIP_RECEIPT = `import { extractReceipt } from "@/lib/telegraph/client";

// Base64 JSON once a 200 is delivered. Key reconciliation on receipt_hash,
// NOT tx_hash: the facilitator batches concurrent payments into a single
// settlement transaction.
const receipt = extractReceipt(res.headers);
if (receipt) {
  console.log(receipt.receipt_hash, receipt.amount_uusdc, receipt.tx_hash);
}`;

const SNIP_DAEMON = `# The Daemon's autonomous signal feed is free and keyless.
curl "https://devnode.telegraphprotocol.com/daemon/api/questions?limit=10&since_hours=24"
curl "https://devnode.telegraphprotocol.com/daemon/api/categories"
curl "https://devnode.telegraphprotocol.com/daemon/health"`;

const SNIP_VERIFY = `const rec = await fetch(
  \`https://devnode.telegraphprotocol.com/engine/v1/signal/\${signalHash}\`,
).then((r) => r.json());

// Re-derive the hash over the recorded payload instead of trusting the node:
// keccak256 over the canonical, compact, key-sorted JSON serialization
// (wallet_address lower-cased; < > & escaped as unicode escapes).
// rec.signal, rec.result and rec.payload hold the record the hash commits to;
// rec.verification carries the node's own commitment check.`;

const MCP_SETUP = `node -v            # v20 or newer; paid tools fail on Node 18 with
                   # "Failed to create payment payload: Crypto API not available"
git clone https://github.com/telegraphprotocol/Telegraph-MCP
cd Telegraph-MCP
npm install && npm run build
cp .env.example .env    # set TELEGRAPH_EVM_PRIVATE_KEY at minimum
npm start               # or ./start-mcp.sh; npm run dev for hot reload
npm run inspect         # or: npx @modelcontextprotocol/inspector dist/index.js`;

const MCP_CONFIG = `{ "mcpServers": {
  "telegraph": {
    "command": "node",
    "args": ["/path/to/Telegraph-MCP/dist/index.js"],
    "env": {
      "TELEGRAPH_NODE_URL": "https://devnode.telegraphprotocol.com",
      "TELEGRAPH_ENGINE_URL": "https://devnode.telegraphprotocol.com/engine",
      "TELEGRAPH_DAEMON_URL": "https://devnode.telegraphprotocol.com/daemon",
      "TELEGRAPH_EVM_PRIVATE_KEY": "0xyour_key_here"
    }
  }
} }`;

const SNIP_KEY = `import { decodeChallenge, extractReceipt, telegraphNodeUrl } from "@/lib/telegraph/client";

// 1. Free probe: HTTP 402 + PAYMENT-REQUIRED (base64 challenge).
const probe = await fetch(\`\${telegraphNodeUrl()}/engine/v1/ask\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: question }),
});
const challenge = decodeChallenge(probe.headers.get("payment-required"));
const offer = challenge?.accepts.find(
  (a) => a.scheme === "exact" && a.network.startsWith("eip155:"),
);

// 2. Sign the CHALLENGE (never the body; body summaries cannot be signed)
//    with an x402 client and retry the identical request with PAYMENT-SIGNATURE.
// 3. On 200: keep signal_hash + X-TELEGRAPH-RECEIPT. Payment settles only on 2xx.
const receipt = extractReceipt(res.headers); // reconcile on receipt.receipt_hash`;

const REPO_ASK = `curl -X POST https://<this-deployment>/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"goal":"Explain the Telegraph referral system","spendLimitUsdCents":100}'
# -> { task }   then poll GET /api/tasks/<id> for the live execution timeline.`;

const REPO_TERMINAL = `curl https://<this-deployment>/api/terminal/verify \\
  -H "Content-Type: application/json" \\
  -d '{"signalHash":"0x7f5b2c422d37be741feb13a5711cf7efa1c19cc3042842fcdc1c1d3dcea9f154"}'
# -> re-derives the hash over the node's recorded payload; only a match is
#    reported as fully verified.`;

/* ------------------------------------------------------------------ */

function Section({ id, n, title, children }: { id: string; n: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-edge pt-10">
      <p className="x-label">SECTION {n}</p>
      <h2 className="x-display-2 mt-2 text-ink">{title}</h2>
      <div className="mt-4 max-w-[76ch] space-y-5 text-[13.5px] leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-soft">{children}</p>;
}

function Api({ method, path, access, children }: { method: string; path: string; access: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-edge/60 py-3.5 first:pt-2 last:border-0">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${
            method === "POST" ? "bg-blue/10 text-blue" : method === "MIX" ? "bg-panel-3 text-ink-soft" : "bg-teal/10 text-teal"
          }`}
        >
          {method}
        </span>
        <code className="tabular text-[12.5px] text-ink">{path}</code>
        <span className="rounded-full border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-ink-faint">{access}</span>
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed">{children}</p>
    </div>
  );
}

function FieldList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="rounded-lg border border-edge bg-panel px-4 py-3">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap items-baseline gap-x-3 border-b border-edge/50 py-2.5 last:border-0">
          <dt className="shrink-0 font-mono text-[11.5px] text-ink">{k}</dt>
          <dd className="min-w-0 flex-1 break-words text-[12.5px] leading-relaxed text-ink-soft">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="pt-2 text-[13px] font-semibold tracking-wide text-ink">{children}</h3>;
}

function Doc({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

function InLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-amber underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-amber/40 bg-amber/5 px-4 py-3 text-[12.5px] leading-relaxed text-ink">{children}</p>;
}

export default function DevelopersPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <p className="x-tag">NIGHTSHIFT · DEVELOPER CENTRE</p>
      <h1 className="x-display-1 mt-3 text-ink">Build on the Telegraph network</h1>
      <p className="mt-3 max-w-[74ch] text-[14px] leading-relaxed text-ink-soft">
        What an integration needs: the public node API, the x402 payment flow, the response formats as they really
        are, the official SDKs and MCP server, and starting points for the network roles. Sourced from the official
        documentation and from the contracts actually implemented here — never invented — and kept as a primer, not a
        mirror of the full docs. Copy actions on every code block; no fake playground.
      </p>
      <div className="mt-5 flex flex-wrap gap-x-2 gap-y-1 text-[12.5px]">
        <InLink href="/terminal">Try the interactive Terminal</InLink>
        <span className="text-ink-faint">·</span>
        <InLink href="/signals">Browse live signals</InLink>
        <span className="text-ink-faint">·</span>
        <InLink href="/miners">Study live miners</InLink>
        <span className="text-ink-faint">·</span>
        <InLink href="/activity">Inspect paid activity records</InLink>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav aria-label="Developer sections" className="lg:sticky lg:top-24 lg:self-start">
          <ul className="hidden lg:block">
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block border-b border-edge/60 py-2.5 text-[13px] text-ink-soft transition-colors hover:text-amber"
                >
                  <span className="tabular mr-2 text-[11px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
          <ul className="flex gap-2 overflow-x-auto pb-1 lg:hidden" aria-label="Developer sections, compact">
            {SECTIONS.map((s) => (
              <li key={s.id} className="shrink-0">
                <a
                  href={`#${s.id}`}
                  className="inline-block whitespace-nowrap rounded-full border border-edge bg-panel px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-12">
          {/* ------------------------------------------------ 1 */}
          <Section id="getting-started" n="01" title="Getting started">
            <P>
              Telegraph is an HTTP-native intelligence network: agents pay a micropayment for an answer routed to a
              marketplace of independent miners. There is no account and no API key —{" "}
              <strong className="text-ink">the x402 payment itself is the authentication</strong>. Discovery, the
              Daemon&apos;s signal feed and verification reads are free and keyless; a wallet holding test USDC on
              Base Sepolia (or Solana Devnet) plus an x402 client is enough for the paid path.
            </P>
            <P>
              Two facts from the{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/using/engine-ask">official docs</Doc>{" "}
              worth keeping on a sticky note: miner IDs care not stable over time — always read them from discovery,
              never hardcode them; and the 402 challenge header is authoritative — the body only carries a bare price
              summary that cannot be signed.
            </P>
            <FieldList
              rows={[
                ["1 · Discover", "GET /api/miners (?intent=&status=&limit=) and GET /engine/v1/intents. Free."],
                ["2 · Probe", "POST /engine/v1/ask -> 402 + PAYMENT-REQUIRED (the base64 challenge is the signable offer)."],
                ["3 · Pay & retry", "Sign with an x402 client and retry with PAYMENT-SIGNATURE. Payment settles only on 2xx."],
                ["4 · Verify", "Keep signal_hash; GET /engine/v1/signal/{hash} and re-derive the hash yourself."],
              ]}
            />
            <CodeBlock code={SNIP_DISCOVERY} title="SHELL · DISCOVERY IS FREE" />
            <CodeBlock code={SNIP_PAID_ASK} title="TYPESCRIPT · FIRST PAID ASK" />
            <P>
              Want to feel the flow before writing code? The <InLink href="/terminal">Terminal</InLink> walks the exact
              same sequence interactively: unpaid probe, offer approval, paid execution, signal check.
            </P>
          </Section>

          {/* ------------------------------------------------ 2 */}
          <Section id="api-reference" n="02" title="API reference">
            <P>
              Two layers, kept clearly separate: the <strong className="text-ink">node</strong> is the Telegraph
              network&apos;s public API (testnet at <code className="text-[11.5px]">https://devnode.telegraphprotocol.com</code>),
              and the <strong className="text-ink">app API</strong> is this platform&apos;s own REST surface — documented
              here exactly as implemented, including the auth gate each route actually applies.
            </P>

            <H3>TELEGRAPH NODE (TESTNET) — PUBLIC</H3>
            <div className="rounded-lg border border-edge bg-panel px-4">
              <Api method="GET" path="/api/miners" access="free">
                Live miner catalog: id, slug, endpoints, schemas, supported intents, activation status, minimum price.
                Server-side filters help: ?intent=, ?status= and limit.
              </Api>
              <Api method="GET" path="/miner-dispatcher/openapi.json" access="free">
                Machine-readable OpenAPI spec of all miner endpoints (also as .yaml).
              </Api>
              <Api method="GET" path="/engine/v1/intents" access="free">
                Canonical intent registry — the live set in the{" "}
                <InLink href="/intents">Explorer&apos;s Intents view</InLink>.
              </Api>
              <Api method="GET" path="/engine/v1/signal/{signal_hash}" access="free">
                The recorded signal for a paid call: signal, result, payload, verification.
              </Api>
              <Api method="POST" path="/engine/v1/ask" access="x402 paid">
                Auto-routed inference, fresh and on-demand.
              </Api>
              <Api method="POST" path="/engine/v1/ask/{minerId}" access="x402 paid">
                Direct inference by miner ID; no routing fields in the response; pre-request validation stops invalid
                direct requests with 422 (not charged).
              </Api>
              <Api method="GET" path="/daemon/api/{questions|categories|health}" access="free">
                The Daemon&apos;s autonomous feed and its health. Documented filters: category, source, sort
                (recent|interest), since_hours, min_interest, limit, offset — the browse surface is{" "}
                <InLink href="/signals">Signals</InLink>.
              </Api>
            </div>

            <H3>ENGINE ASK · THE 200 RESPONSE</H3>
            <FieldList
              rows={[
                ["result", "The miner's raw output — shape varies per miner; null-check before rendering."],
                ["parsed", "Optional convenience value read from result (field/status/value/unit); never stored, never signed."],
                ["miner_id · miner_name · endpoint", "Who served (possibly the fallback) and the upstream path that was called."],
                ["cost_usd · duration_ms · timestamp", "Actual cost as a number, execution time, server timestamp."],
                ["reasoning · intent", "Why the router chose the miner and the classified intent — auto path only."],
                ["signal_hash", "The record to verify against; omitted when the ask failed."],
                ["warnings", "Non-fatal advisories (body size, shared rate limit). The request still ran."],
              ]}
            />
            <Callout>
              Errors, verbatim from the official docs: 400 invalid_params (checked before any miner or payment, free);
              422 predicted-to-fail on the direct path (not charged; resend with acknowledge_warnings true to run
              anyway); bare 402 on a signed payload (payment did not verify, nothing settled, do NOT re-send); 429
              rate limit — the allowance is shared per miner across the whole node, so another miner for the intent
              usually beats waiting.
            </Callout>

            <H3>THIS DEPLOYMENT — APP API</H3>
            <P>
              Every app route reads and writes through the same swappable persistence (local JSON files, or Postgres
              when a database is configured); the <InLink href="/activity">Activity</InLink> and History views read
              exactly those records. No card trickery below: the auth column is the code&apos;s own behavior.
            </P>
            <div className="rounded-lg border border-edge bg-panel px-4">
              <Api method="GET" path="/api/status" access="public">
                Truthful status: which integrations are configured (names, never values) and store/connection health.
              </Api>
              <Api method="GET" path="/api/tasks · /api/tasks/{id}" access="public">
                Task records with full execution timelines, spend entries and evidence.
              </Api>
              <Api method="POST" path="/api/tasks" access="public">
                Submit a goal: goal, spendLimitUsdCents, requiresApproval, mode (auto|free|paid). A request marked
                free can never be purchased.
              </Api>
              <Api method="POST" path="/api/tasks/{id}/action" access="public">
                Explicit plan approval or rejection before paid steps run.
              </Api>
              <Api method="POST" path="/api/terminal/preview" access="public">
                Unpaid pre-flight of an assembled ask; returns the live 402 offer without signing.
              </Api>
              <Api method="POST" path="/api/terminal/execute" access="approval-pinned">
                Signs only when the request carries approved plus the exact offer; the live challenge is re-checked
                against pinned fields before anything is signed.
              </Api>
              <Api method="POST" path="/api/terminal/verify" access="public">
                The verification read: signal lookup plus independent hash re-derivation.
              </Api>
              <Api method="GET" path="/api/network · /api/daemon/signals" access="public">
                Read-only aggregates for the Explorer and a relay of the Daemon feed (no operator data).
              </Api>
              <Api method="MIX" path="/api/watches/{id}/(check|scheduler-tick)" access="token-gated">
                Protocol Watch management, check runs and scheduler tick are gated behind the NIGHTSHIFT_API_TOKEN
                bearer when configured — the only privileged operator surface this deployment exposes.
              </Api>
              <Api method="POST" path="/api/telegram/webhook" access="secret-checked">
                Telegram Bot API webhook validated by TELEGRAM_WEBHOOK_SECRET (accepts all updates while unset, e.g.
                local dev).
              </Api>
            </div>
            <Callout>
              Wallet key material is server-side only and never appears in any response; the payer&apos;s derived
              public address is the only wallet identifier exposed by the payment flow.
            </Callout>
          </Section>

          {/* ------------------------------------------------ 3 */}
          <Section id="sdks" n="03" title="SDKs">
            <P>
              The officially documented client packages are the{" "}
              <Doc href="https://github.com/x402-foundation/x402">x402 SDKs</Doc> — TypeScript first,{" "}
              <strong className="text-ink">Node.js 20+</strong> required (WebCrypto):{" "}
              <code className="text-[11.5px]">@x402/fetch</code> wraps fetch with the 402/sign/retry cycle,{" "}
              <code className="text-[11.5px]">@x402/evm</code> signs the EIP-712 exact-scheme payment,{" "}
              <code className="text-[11.5px]">@x402/core</code> is the shared client machinery and{" "}
              <code className="text-[11.5px]">@x402/svm</code> adds Solana payments. This platform itself reaches the
              network through those packages — <code className="text-[11.5px]">@x402/fetch</code> and{" "}
              <code className="text-[11.5px]">@x402/evm</code> (v2) — and there is no separate &quot;Telegraph SDK&quot;:
              the node is plain HTTP and the payment is the SDK&apos;s job. No other client libraries are officially
              documented, so none are listed here.
            </P>
            <CodeBlock
              code={`npm i @x402/fetch @x402/evm
# Node.js 20+ (WebCrypto); payments fail on Node 18 with
# "Failed to create payment payload: Crypto API not available".`}
              title="SHELL · INSTALL THE OFFICIAL PACKAGES"
            />
            <P>
              Going beyond the basic wrapper is worth it in production: this platform&apos;s engine pins every
              signature to the exact challenge entry (network, asset, payTo, atomic amount), checks the amount against
              its budget before signing anything and allowlists exactly the challenge asset in{" "}
              <code className="text-[11.5px]">spendControls</code>, so an unvetted or re-priced requirement can never
              be signed silently. The receipts and signal hashes of every paid step end up verifiable in the{" "}
              <InLink href="/activity">Activity centre</InLink>.
            </P>
          </Section>

          {/* ------------------------------------------------ 4 */}
          <Section id="mcp" n="04" title="MCP">
            <P>
              The <Doc href="https://github.com/telegraphprotocol/Telegraph-MCP">Telegraph MCP Server</Doc> is the
              official zero-crypto-code path: a local Node process that exposes the network as Model Context Protocol
              tools, handles x402 inside itself and never reveals the wallet key to the agent. Tool families: node
              discovery (<code className="text-[11.5px]">tg_node_*</code>), Engine inference (paid{" "}
              <code className="text-[11.5px]">tg_engine_ask</code>, direct{" "}
              <code className="text-[11.5px]">tg_engine_ask_subnet</code>), Daemon feed (<code className="text-[11.5px]">tg_daemon_*</code>, free), plus dynamic
              per-miner tools named <code className="text-[11.5px]">tg_&lt;miner&gt;_&lt;endpoint&gt;</code> that auto-refresh
              every five minutes. Several names still say &quot;subnet&quot; — official note: read it as miner.
            </P>
            <CodeBlock code={MCP_SETUP} title="SHELL · OFFICIAL SETUP" />
            <FieldList
              rows={[
                ["TELEGRAPH_NODE_URL", "https://devnode.telegraphprotocol.com"],
                ["TELEGRAPH_ENGINE_URL", "https://devnode.telegraphprotocol.com/engine"],
                ["TELEGRAPH_DAEMON_URL", "https://devnode.telegraphprotocol.com/daemon"],
                ["TELEGRAPH_EVM_PRIVATE_KEY", "Required for paid tools; never leaves the MCP process"],
                ["TELEGRAPH_SOLANA_PRIVATE_KEY", "Optional — payments on Solana Devnet"],
                ["REFRESH_INTERVAL_MS", "Dynamic miner-tool refresh interval (default 300000)"],
              ]}
            />
            <CodeBlock code={MCP_CONFIG} title="JSON · ANY MCP CLIENT OVER STDIO" />
            <P>
              The documented integrations (Claude Desktop, Cursor, ElizaOS, LangChain/LangGraph TypeScript and Python,
              OpenClaw, Goose, VS Code/Continue) all use exactly this block with small file-format differences — and
              the same works with any client speaking MCP stdio{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/using/mcp-server">(official guide)</Doc>. Security
              notes that matter: use a burner wallet; the key never leaves the MCP process; the server is stdio-only,
              with no network port.
            </P>
          </Section>

          {/* ------------------------------------------------ 5 */}
          <Section id="payments" n="05" title="Payments">
            <P>
              x402 runs in five steps inside one HTTP cycle: call, receive 402 with a base64{" "}
              <code className="text-[11.5px]">PAYMENT-REQUIRED</code> challenge, hand the decoded challenge to an x402
              client which signs a transfer of the exact <code className="text-[11.5px]">amount</code> of{" "}
              <code className="text-[11.5px]">asset</code> to <code className="text-[11.5px]">payTo</code>, retry the
              identical request with <code className="text-[11.5px]">PAYMENT-SIGNATURE</code>, and get 200 with the
              answer. The node verifies payment with its facilitator before calling the miner, so failed calls are{" "}
              <strong className="text-ink">never charged</strong> — payment settles only on 2xx.
            </P>
            <CodeBlock
              code={`HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi...

{ "x402Version": 2,
  "accepts": [
    { "scheme": "exact", "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "10000", "payTo": "0x...", "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" } }
  ] }`}
              title="JSON · DECODED CHALLENGE (AMOUNT IS 6-DECIMAL USDC: '10000' = $0.01)"
            />
            <FieldList
              rows={[
                ["authoritative header", "Sign from the decoded header, never from the body: the body summary prices a bare $0.01 without asset or amount."],
                ["payTo", "Per node — read it from the challenge you received, never hardcode it."],
                ["asset", "USDC on Base Sepolia (0x036CbD53842c5426634e7929541eC2318f3dCF7e) or Solana Devnet; not every client knows it by default, so allowlist it in spendControls."],
                ["extra", "The signature domain ({name USDC, version 2} on Base Sepolia; feePayer on Solana) — the SDK reads these for you."],
                ["dynamic pricing", "min_price_usdc times a demand multiplier from rolling 24-hour volume; the charged amount lands in the challenge."],
                ["escrow", "The same endpoints accept scheme \"escrow\": pre-fund once, then skip the per-request settlement."],
                ["Solana path", "Same receipt fields, epoch_id 0 (settled on its own chain, no Telegraph epoch)."],
              ]}
            />
            <P>
              A 200 answers two different questions with two headers:{" "}
              <code className="text-[11.5px]">PAYMENT-RESPONSE</code> proves the payment settled,{" "}
              <code className="text-[11.5px]">X-TELEGRAPH-RECEIPT</code> records what the payment bought. Reconcile on{" "}
              <code className="text-[11.5px]">receipt_hash</code> — the facilitator batches concurrent payments into one
              settlement transaction (40 payments sharing 25 transactions measured on the live network), so{" "}
              <code className="text-[11.5px]">tx_hash</code> can cover several calls.
            </P>
            <CodeBlock
              code={`{ "receipt_hash": "0x3f1c…", "rail": "x402", "payer": "0xyourwallet…",
  "miner": "377", "intent": "STOCK_PRICE", "amount_uusdc": "10000",
  "epoch_id": 314, "settlement": "onchain", "chain": "eip155:84532",
  "tx_hash": "0x6bb27730…", "timestamp": 1789466181 }`}
              title="JSON · X-TELEGRAPH-RECEIPT (BASE64-ENCODED HEADER)"
            />
            <CodeBlock code={SNIP_KEY} title="TYPESCRIPT · THE CYCLE, KEY-FIELDS ONLY" />
            <CodeBlock code={SNIP_RECEIPT} title="TYPESCRIPT · RECONCILE ON receipt_hash" />
            <P>
              Verification after a paid call: every paid request is recorded as a{" "}
              <strong className="text-ink">signal</strong> whose hash commits to request and response together. GET{" "}
              <code className="text-[11.5px]">/engine/v1/signal/&#123;signal_hash&#125;</code> returns the signal, the
              result behind it AND the payload it was computed over, so you re-derive the hash rather than take the
              node&apos;s word. The official docs do not publish a client-side hash recipe, so this platform treats only
              a re-derived match as verified and reports everything else honestly — the{" "}
              <code className="text-[11.5px]">/api/terminal/verify</code> contract does exactly that.
            </P>
          </Section>

          {/* ------------------------------------------------ 6 */}
          <Section id="examples" n="06" title="Code examples">
            <P>
              Complete and copyable, aimed at the live testnet node; each does exactly what it says and nothing more —
              no simulated responses. The <InLink href="/signals">Signals</InLink> and{" "}
              <InLink href="/activity">Activity</InLink> views show the same operations from this platform&apos;s own
              running history.
            </P>
            <CodeBlock code={SNIP_DISCOVERY} title="SHELL · WHAT THE NETWORK OFFERS TODAY" />
            <CodeBlock code={SNIP_PROBE} title="SHELL · THE FREE PRE-FLIGHT (402 = PRICED)" />
            <CodeBlock code={SNIP_DAEMON} title="SHELL · FREE DAEMON SIGNAL FEED" />
            <CodeBlock code={SNIP_PAID_ASK} title="TYPESCRIPT · PAID AUTO-ROUTED ASK" />
            <CodeBlock code={SNIP_VERIFY} title="TYPESCRIPT · VERIFY A PAID ANSWER" />
            <CodeBlock code={REPO_ASK} title="SHELL · THIS DEPLOYMENT: SUBMIT A GOAL" />
            <CodeBlock code={REPO_TERMINAL} title="SHELL · THIS DEPLOYMENT: VERIFY A SIGNAL" />
          </Section>

          {/* ------------------------------------------------ 7 */}
          <Section id="network-guides" n="07" title="Network guides">
            <P>
              Summarized to get you oriented, linked to the real guides rather than re-taught. The live side of each
              role is already visible here: <InLink href="/miners">Miners</InLink>,{" "}
              <InLink href="/evaluators">Evaluators</InLink>, <InLink href="/validators">Validators</InLink>.
            </P>

            <H3>BECOME A MINER (SUPPLY ANSWERS, EARN FROM DEMAND)</H3>
            <P>
              Expose an AI capability behind a live HTTP API, describe it in a declarative YAML (intents, endpoint
              mapping, input/output schemas, pricing), host the YAML at a public URL (IPFS recommended) and register
              on-chain with an EVM fee address{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/miners/miner-overview">(What Miners Do)</Doc>. The{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/miners/validation-api">Validation API</Doc> checks the
              YAML before registration is accepted, and schema failures surface the validator&apos;s full output — including
              rejection_reason via the registration record — so most rejects are readable without touching the node
              <Doc href="https://docs.telegraphprotocol.com/docs/troubleshooting"> (official troubleshooting)</Doc>.
            </P>

            <H3>BUILD AN EVALUATOR (SCORE THE ANSWERS)</H3>
            <P>
              The quality layer: build a scoring module that fits the registry&apos;s evaluation flow, train an
              evaluation adapter, and contribute evaluation data so the graduated scoring stays honest — one{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/scoring/build-a-scoring-module">building</Doc>,{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/scoring/train-a-scoring-adapter">training</Doc> and{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/scoring/contribute-evaluation-data">data contribution</Doc> guide each.
            </P>

            <H3>RUN A VALIDATOR (GUARANTEE HONEST SIGNALS)</H3>
            <P>
              The neutral guarantee layer: run a Telegraph validator node continuously (availability matters — missed
              consensus rounds cost emissions), participate in the Byzantine-fault-tolerant finalization that turns
              raw scores into validator-signed finalized signals — without touching payments, routing or miner
              choice <Doc href="https://docs.telegraphprotocol.com/docs/validators/validator-overview">(What Validators Do)</Doc>. Key management and node setup are their own guides{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/validators/key-management">keys</Doc>,{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/validators/validator-setup">setup</Doc>. Testnet runs
              five-minute epochs with a 64-active-validator cap{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/protocol/addresses-and-params">(protocol parameters)</Doc>.
            </P>

            <P>
              And for consuming intelligence, agents need no role at all — pay per request by x402, pre-fund an escrow,
              or use on-chain job contracts for deterministic access. The{" "}
              <Doc href="https://docs.telegraphprotocol.com/docs/protocol/roles">Roles</Doc> page is the map.
            </P>
          </Section>

          <p className="x-label pt-6">
            SOURCES · OFFICIAL TELEGRAPH DOCS (DOCS.TELEGRAPHPROTOCOL.COM, NOV 2026) · THE IMPLEMENTED CONTRACTS IN
            THIS REPO · LIVE TESTNET NODE
          </p>
        </div>
      </div>
    </div>
  );
}
