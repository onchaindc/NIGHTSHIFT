/**
 * Real-browser interaction audit of the Protocol Watch view: clicks New watch,
 * Create watch, Check now (free), runs the check twice (repeat behavior), and
 * records console errors, failed requests, and page states. Never investigates
 * (paid) — only free checks. Run: node scripts/audit-watch.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(os.homedir(), ".bun", "install", "cache", "playwright-core", "1.64.1@@@1", "index.js"));

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");
mkdirSync(".data/logs", { recursive: true });

const findings = [];
const note = (m) => findings.push(m);
const stamp = Date.now().toString(36);
const watchName = `audit-rss-${stamp}`;

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleMsgs = [];
const failedRequests = [];
page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 500) }));
page.on("pageerror", (e) => consoleMsgs.push({ type: "PAGEERROR", text: String(e).slice(0, 500) }));
page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url().slice(0, 120)}: ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.request().method()} ${r.url().slice(0, 120)}: HTTP ${r.status()}`); });

await page.goto(base + "/watch", { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(800);
note(`page loaded, h1: ${await page.locator("h1").textContent()}`);

// 1. New watch -> form opens
const newBtn = page.locator("button:has-text('New watch')");
if ((await newBtn.count()) === 0) note("BUG: no New watch button");
await newBtn.first().click();
await page.waitForTimeout(300);
if ((await page.locator("#wname").count()) === 0) note("BUG: configure form did not open");

// 2. Fill and create a real free-source watch (RSS feed)
await page.fill("#wname", watchName);
await page.fill("#wprotocol", "Audit Chain");
await page.locator("[aria-label='Source 1 type']").selectOption("rss_feed");
await page.locator("[aria-label='Source 1 target']").fill("https://aavegotchi.s3.amazonaws.com/blog/feed.xml");
// add a second source that will fail (dead URL) for the failure-handling test
await page.locator("button:has-text('+ Add source')").click();
await page.locator("[aria-label='Source 2 type']").selectOption("rss_feed");
await page.locator("[aria-label='Source 2 target']").fill("https://audit-stub.invalid/feed.xml");
await page.fill("#wlimit", "2.00");
await page.locator("button:has-text('Create watch')").click();
await page.waitForTimeout(1500);

const watchRow = page.locator(`article:has-text('${watchName}')`);
const rowCount = await watchRow.count();
if (rowCount === 0) {
  note(`BUG: watch row missing after create. Alerts: ${JSON.stringify(await page.locator("[role='alert']").allTextContents())}`);
} else {
  note(`watch created: row rendered with ${await watchRow.locator("span:has-text('2 sources')").count()} source chip pair`);
  const lastCheck = await watchRow.locator("text=Never checked").count();
  note(`row shows 'Never checked': ${lastCheck === 1}`);
}

// 3. Check now (free) — real run
const checkBtn = watchRow.locator("button:has-text('Check now (free)')");
if ((await checkBtn.count()) !== 1) {
  note(`BUG: Check now (free) button count = ${await checkBtn.count()}`);
} else {
  await checkBtn.click();
  await page.waitForTimeout(400);
  note(`button busy state: ${await watchRow.locator("button:has-text('Checking…')").count() === 1 ? "Checking… shown" : "no busy state"}`);
  await page.waitForTimeout(6000); // fetch + engine over dev server
  note(`after check: busy = ${await watchRow.locator("button:has-text('Checking…')").count()}`);
  const alert = await page.locator("article [role='alert']").allTextContents();
  if (alert.length) note(`run errors on the row: ${JSON.stringify(alert)}`);
  const rowText = await watchRow.textContent();
  note(`row after check shows last-check time: ${/Last check/.test(rowText ?? "")}`);

  // 4. repeat the check (repeat behavior): should complete again, no crash
  await checkBtn.click();
  await page.waitForTimeout(7000);
  const alert2 = await page.locator("article [role='alert']").allTextContents();
  if (alert2.length) note(`errors on repeat check: ${JSON.stringify(alert2)}`);
}

// 5. server-side evidence: the watch config + its runs via the APIs
const watches = await (await fetch(base + "/api/watches")).json();
const mine = watches.watches.find((w) => w.name === watchName);
if (!mine) note("BUG: watch not persisted server-side");
else {
  note(`persisted: fingerprints keys = ${JSON.stringify(Object.keys(mine.fingerprints))}, lastCheckedAt set = ${mine.lastCheckedAt !== null}`);
  note(`fingerprint after failed source: ${JSON.stringify(mine.fingerprints[mine.sources[1].id]) ?? "absent (source error not stored)"}`);
}
const tasks = await (await fetch(base + "/api/tasks")).json();
const runs = tasks.tasks.filter((t) => t.goal.includes(watchName) || (t.watch && t.watch.watchName === watchName));
note(`runs recorded server-side: ${runs.length}`);
for (const r of runs) {
  const summary = r.result?.summary ?? "";
  const srcErrors = (r.events.filter((e) => e.type === "watch_source_checked").map((e) => e.data?.ok ?? "?")).join(",");
  note(`run ${r.id.slice(0, 8)} state=${r.state} spent=${r.spend.spentUsdCents}c sourceOkFlags=${srcErrors} summaryHasError=${srcErrors.includes("false")}`);
}
if (mine) {
  // delete test watch config to keep real workspace data clean
  const del = await fetch(base + `/api/watches/${mine.id}`, { method: "DELETE" });
  note(`cleanup delete status: ${del.status}`);
}

// screenshots
await page.screenshot({ path: ".data/shots/watch-audit-desktop.jpeg", fullPage: true, type: "jpeg", quality: 45 });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(base + "/watch", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
note(`mobile horizontal overflow: ${overflow}`);
await page.screenshot({ path: ".data/shots/watch-audit-mobile.jpeg", fullPage: true, type: "jpeg", quality: 45 });

const clientErrors = consoleMsgs.filter((m) => m.type === "error" || m.type === "PAGEERROR");
note(`console client errors: ${clientErrors.length} ${JSON.stringify(clientErrors.slice(0, 5))}`);
note(`failed requests: ${JSON.stringify(failedRequests)}`);
await browser.close();

console.log(JSON.stringify(findings, null, 1));
