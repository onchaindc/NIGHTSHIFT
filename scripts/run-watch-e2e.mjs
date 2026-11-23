/**
 * End-to-end verification of a real free-source watch: create via the UI,
 * run a manual free check, verify the busy state, snapshot persistence,
 * repeat-check dedupe, and source-failure handling. Free checks only; never
 * investigates (paid). Run: node scripts/run-watch-e2e.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(os.homedir(), ".bun", "install", "cache", "playwright-core", "1.64.1@@@1", "index.js"));

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");

const out = [];
const note = (m) => out.push(m);
const watchName = `e2e-watch-${Date.now().toString(36)}`;

// clean any leftover audit watches from earlier runs of this script
{
  const { watches } = await (await fetch(base + "/api/watches")).json();
  for (const w of watches.filter((w) => w.name.startsWith("audit-rss-") || w.name.startsWith("e2e-watch-"))) {
    const r = await fetch(base + `/api/watches/${w.id}`, { method: "DELETE" });
    note(`cleanup pre-existing ${w.name}: ${r.status}`);
  }
}

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });

await page.goto(base + "/watch", { waitUntil: "networkidle", timeout: 45000 });
await page.locator("button:has-text('New watch')").first().click();
await page.fill("#wname", watchName);
await page.fill("#wprotocol", "Audit Protocol");
await page.locator("[aria-label='Source 1 type']").selectOption("github_releases");
await page.locator("[aria-label='Source 1 target']").fill("Uniswap/uniswap-v3-sdk");
await page.locator("button:has-text('+ Add source')").click();
await page.locator("[aria-label='Source 2 type']").selectOption("rss_feed");
await page.locator("[aria-label='Source 2 target']").fill("https://blog.ethereum.org/feed.xml");
await page.locator("button:has-text('+ Add source')").click();
await page.locator("[aria-label='Source 3 type']").selectOption("rss_feed");
await page.locator("[aria-label='Source 3 target']").fill("https://audit-stub.invalid/feed.xml");
await page.locator("button:has-text('Create watch')").click();
await page.waitForTimeout(1200);

const row = page.locator(`article:has-text('${watchName}')`);
if ((await row.count()) !== 1) note(`BUG: watch row missing after create`);
else note("create: watch row rendered");

// manual free check with busy-state sampling
const checkBtn = row.locator("button:has-text('Check now (free)')");
await checkBtn.click();
let sawBusy = false;
const t0 = Date.now();
while (Date.now() - t0 < 3000) {
  if ((await row.locator("button:has-text('Checking…')").count()) === 1) { sawBusy = true; break; }
  await page.waitForTimeout(60);
}
await page.waitForTimeout(7000);
note(`busy state during run: ${sawBusy ? "VISIBLE (Checking…)" : "BUG: never shown"}`);

const alerts = await row.locator("[role='alert']").allTextContents();
note(`row alerts after check 1: ${JSON.stringify(alerts)}`);

// server-side assertions
const fetchState = async () => {
  const { watches } = await (await fetch(base + "/api/watches")).json();
  const w = watches.find((w) => w.name === watchName);
  const { tasks } = await (await fetch(base + "/api/tasks")).json();
  const runs = tasks.filter((t) => t.watch?.watchName === watchName).sort((a, b) => b.createdAt - a.createdAt);
  return { w, latest: runs[0], count: runs.length };
};

let { w, latest } = await fetchState();
note(`run 1: state=${latest?.state} spent=${latest?.spend.spentUsdCents}c error=${JSON.stringify(latest?.error ?? null)}`);
const okFlags = latest.events.filter((e) => e.type === "watch_source_checked").map((e) => (e.data?.error ? "FAIL" : "OK"));
note(`run 1 source reads: ${okFlags.join(",")}`);
note(`fingerprints persisted: ${w ? JSON.stringify(Object.keys(w.fingerprints)) : "MISSING watch"}`);
note(`lastCheckedAt persisted: ${w?.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : "null"}`);
note(`budget persisted in config: ${w?.spendLimitUsdCents}c, task limit matches: ${latest.spend.limitUsdCents === w?.spendLimitUsdCents}`);
note(`baseline events: ${latest.events.filter((e) => e.type === "watch_baseline").length} (expect 2: uniswap + eth blog)`);
note(`source_error findings recorded: ${JSON.stringify((latest.result?.summary ?? "").includes("[SOURCE ERROR]") ? "in summary" : "NOT in summary")}`);

// repeat check: no duplicate findings, same state family
const countBefore = await row.locator("button:has-text('Check now (free)')").click().then(() => null);
await page.waitForTimeout(8000);
({ w, latest } = await fetchState());
note(`run 2: count=${latest ? "ok" : "?"} state=${latest?.state} error=${JSON.stringify(latest?.error ?? null)}`);
note(`run 2 change findings: ${JSON.stringify(latest.events.filter((e) => e.type === "watch_change_detected").length)} (expect 0: unchanged sources)`);
note(`run 2 alerts after repeat check: ${JSON.stringify(await row.locator("[role='alert']").allTextContents())}`);

// delete the test watch to leave real workspace data clean
const del = await fetch(base + `/api/watches/${w.id}`, { method: "DELETE" });
note(`cleanup delete: ${del.status}`);

await page.screenshot({ path: ".data/shots/watch-e2e-desktop.jpeg", fullPage: true, type: "jpeg", quality: 45 });
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
note(`mobile overflow: ${overflow}`);
await page.screenshot({ path: ".data/shots/watch-e2e-mobile.jpeg", fullPage: true, type: "jpeg", quality: 45 });
note(`console errors: ${consoleErrors.length} ${JSON.stringify(consoleErrors.slice(0, 4))}`);
await browser.close();

console.log(JSON.stringify(out, null, 1));
