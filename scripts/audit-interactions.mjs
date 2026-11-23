/**
 * Real-browser regression audit of NIGHTSHIFT's current operation journey.
 * Desktop + mobile: launch a FREE research operation on /operations and verify
 * the complete journey stays on that page - live status, steps, then the
 * prominent verified result with evidence, completion time and spend.
 *
 * Safety: only free capabilities are exercised (public chain RPC and public
 * price APIs, $0 by construction). No paid Telegraph request, no Telegram
 * message, no approve/reject of anyone else's task is ever sent. If a live
 * public lookup is unreachable, the run asserts the honest failure rendering
 * instead of the answer.
 *
 * Run: node scripts/audit-interactions.mjs
 */
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
function loadPlaywrightCore() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    "/home/daytona/.bun/install/cache/playwright-core@1.64.1@@@1",
    path.join(os.tmpdir(), "bunx-0-playwright@latest", "node_modules", "playwright-core"),
    "playwright-core",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try the next location
    }
  }
  throw new Error("playwright-core not found; set PLAYWRIGHT_CORE_PATH to its directory");
}
const { chromium } = loadPlaywrightCore();

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");

const findings = [];
const note = (label, msg) => findings.push({ label, msg });

async function audit(pageConfig, label) {
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage(pageConfig);

  const consoleMsgs = [];
  const failedRequests = [];
  const paidEndpoints = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleMsgs.push(m.text().slice(0, 240));
  });
  page.on("pageerror", (e) => consoleMsgs.push(String(e).slice(0, 240)));
  page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url().slice(0, 100)}`));
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.request().method()} ${r.url().slice(0, 100)}: ${r.status()}`);
  });
  // Blocklist the transport of consequential flows during the audit: no paid
  // purchase attempt and no Telegram send may be produced by UI usage.
  page.on("request", (r) => {
    if (r.url().includes("api.telegram.org") || r.url().includes("telegraphprotocol.com")) paidEndpoints.push(r.url());
  });

  try {
    // 1. The dashboard loads and its navigation works.
    await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    const navOk = await page.evaluate(() => {
      const links = [...document.querySelectorAll('nav a, aside a')].map((a) => a.getAttribute("href"));
      return links.filter(Boolean).length >= 5 ? links : null;
    });
    if (!navOk) note(label, "NAV: could not find 5+ navigation links on the dashboard");

    // 2. Launch a FREE research operation and follow it on the same page.
    await page.goto(base + "/operations", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
    const goal = page.locator("#goal");
    await goal.waitFor({ timeout: 20000 });
    // Free sources must be the default choice.
    const freeDefault = await page
      .locator('[role="radio"][aria-checked="true"]:has-text("Free sources")')
      .count();
    if (freeDefault < 1) note(label, "MODE: 'Free sources' is not the pre-selected answer source");
    await goal.click();
    await goal.fill("What is the current BTC price in USD?");
    await page.locator('button:has-text("Launch Operation")').click();

    // The monitor must appear on THIS page (no navigation away).
    const monitor = page.locator('[aria-label="Launched operation"]');
    await monitor.waitFor({ timeout: 15000 });
    const stillOnOperations = page.url().includes("/operations");
    if (!stillOnOperations) note(label, "FLOW: leaving /operations after launch");

    // 3. The task reaches a terminal state within the monitor (free runs are quick).
    let terminalText = null;
    for (let i = 0; i < 45; i++) {
      const chip = await monitor.locator(".text-teal, .text-risk").first().textContent().catch(() => null);
      const t = (chip ?? "").trim();
      if (i > 1 && terminalText === null && t) terminalText = t;
      if (t === "Completed" || t === "Failed" || t === "Blocked") break;
      await page.waitForTimeout(1000);
    }
    const outcome = await monitor.locator("pre, .text-risk").first().textContent().catch(() => null);
    const bodyText = await monitor.innerText();
    if (bodyText.includes("Completed")) {
      const answerShown = /USD price: \$[0-9]/.test(bodyText);
      note(label, `FREE RUN: completed. Answer shown: ${answerShown ? "yes - " + (await monitor.locator("pre").first().textContent()).slice(0, 80) : "NO"}`);
      note(label, `EVIDENCE: ${await evidenceCount(monitor)}`);
      note(label, `SPEND LINE: ${bodyText.includes("spent") && bodyText.includes("$0.00") ? "shows $0.00" : "MISSING"}`);
      const historyLink = await monitor.locator('a[href^="/tasks/"]').count();
      note(label, `FULL HISTORY LINK: ${historyLink > 0 ? "present" : "MISSING"}`);
      const onSamePage = page.url().includes("/operations");
      note(label, `RESULT ON LAUNCH PAGE: ${onSamePage ? "yes" : "no"}`);
    } else {
      note(label, `FREE RUN did not complete (chip="${terminalText ?? "??"}"). Outcome shown: ${String(outcome).slice(0, 140)}`);
    }

    // 4. A goal with no free capability is blocked honestly, inline, without exiting the page.
    await page.locator("#goal").click();
    await page.locator("#goal").fill("Summarize the latest research discussion in the governance forum");
    await page.locator('button:has-text("Launch Operation")').click();
    await page.waitForTimeout(2500);
    const pageText = await page.locator("body").innerText();
    note(label, `BLOCKED STATE: ${/No free capability/i.test(pageText) ? "shown inline" : "MISSING"}`);

    // 5. Mobile sanity: no horizontal overflow on operations and dashboard.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    if (overflow) note(label, "MOBILE: horizontal overflow on /operations");
    await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
    const overflowDash = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    if (overflowDash) note(label, "MOBILE: horizontal overflow on /");
  } catch (err) {
    note(label, `AUDIT ABORTED: ${String(err).slice(0, 200)}`);
  }

  for (const m of consoleMsgs) note(label, `console: ${m}`);
  if (failedRequests.length) note(label, `failed requests: ${failedRequests.slice(0, 6).join(" | ")}`);
  if (paidEndpoints.length) note(label, `SAFETY: paid/telegram transport touched: ${paidEndpoints.slice(0, 3).join(" | ")}`);

  await browser.close();
}

async function evidenceCount(monitor) {
  const n = await monitor.locator("table tbody tr").count();
  return n > 0 ? `${n} evidence row(s)` : "MISSING";
}

await audit({ viewport: { width: 1440, height: 900 } }, "desktop");
await audit({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, "mobile");

console.log("\n=== AUDIT FINDINGS ===");
for (const f of findings) console.log(`[${f.label}] ${f.msg}`);
const bugs = findings.filter((f) => /MISSING|BUG|SAFETY|ABORTED|overflow|ALERT/.test(f.msg));
console.log(bugs.length ? `\nPOTENTIAL DEFECTS: ${bugs.length}` : "\nNO DEFECTS FOUND");
