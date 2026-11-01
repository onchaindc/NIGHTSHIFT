/**
 * Command Center browser audit: verifies every navigation destination, header
 * context + primary action, metric tiles, system strip, launcher honesty, the
 * approvals/history/detail flows, and captures desktop+mobile screenshots.
 * Never submits an operation and never approves anything (no spend, no state change).
 * Run: node scripts/shots-cc.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function findPlaywrightCore() {
  for (const p of ["/tmp/pw/node_modules/playwright-core", path.join(os.tmpdir(), "pw", "node_modules", "playwright-core")]) {
    try { require.resolve(p); return p; } catch { /* next */ }
  }
  throw new Error("playwright-core not found; install with: mkdir -p /tmp/pw && cd /tmp/pw && bun add playwright-core");
}
function findChromium() {
  for (const p of [
    "/tmp/chrome/chrome-linux/headless_shell",
    path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell"),
  ]) {
    try { if (fs.existsSync(p)) return p; } catch { /* next */ }
  }
  throw new Error("chromium not found; stage the headless shell at /tmp/chrome/chrome-linux/headless_shell");
}
const require = createRequire(import.meta.url);
const { chromium } = require(findPlaywrightCore());
const exe = findChromium();

const base = process.env.SHOT_BASE || "http://localhost:3000";
const notes = [];
const note = (m) => notes.push(m);

const all = (await (await fetch(base + "/api/tasks")).json()).tasks;
const realCompleted = all.find((t) => t.state === "completed" && !(t.labels ?? []).includes("audit-rehearsal")) ?? all.find((t) => t.state === "completed");

async function run(browser, viewport, label) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type === "error") errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

  // 1. Overview
  await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1200);
  const headerText = await page.locator("header").textContent();
  note(`${label} header: NIGHTSHIFT=${headerText.includes("NIGHTSHIFT")}, context Overview=${headerText.includes("Overview:") || headerText.includes("Overview")}, status=${/Operational|Degraded|API unreachable|Store unavailable|Checking/.test(headerText)}`);
  const metricsText = await page.locator("section[aria-label=Metrics]").textContent();
  note(`${label} metrics: spend-today=${metricsText.includes("Spend today")}, approvals=${metricsText.includes("Pending approvals")}, watch=${metricsText.includes("Protocol Watch")}`);
  const systemText = await page.locator("section[aria-label='Connected services']").textContent();
  note(`${label} system strip: store=${systemText.includes("Task store")}, telegraph=${systemText.includes("Telegraph")}, telegram=${systemText.includes("Telegram bot")}, rpc=${systemText.includes("Chain RPC")}`);
  const feedRows = await page.locator("section[aria-label='Live activity'] tbody tr").count();
  note(`${label} activity feed rows (desktop): ${feedRows}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-overview.jpeg`, type: "jpeg", quality: 70 });
  const launchBtn = await page.locator("header a[href='/operations']").count();
  note(`${label} header primary action (New operation): ${launchBtn > 0}`);

  // 2. Sidebar navigation through every route (desktop sidebar / mobile drawer)
  const needMobileNav = viewport.width < 1024;
  const navTo = async (name, path) => {
    if (!needMobileNav) {
      await page.click(`aside nav a[href='${path}']`);
    } else {
      await page.click("button[aria-controls='mobile-nav']");
      await page.click("#mobile-nav nav[aria-label=Main] a[href='" + path + "']");
    }
    await page.waitForTimeout(1600);
    note(`${label} nav ${name}: url=${page.url().endsWith(path)} h1=${(await page.locator("h1").first().textContent())?.trim()}`);
  };

  // 3. Operations
  await navTo("Operations", "/operations");
  const jobCards = await page.locator('[role=group][aria-label="Job type"] button').count();
  const watchCard = await page.locator('[role=group][aria-label="Job type"] a[href="/watch"]').count();
  const planned = await page.locator('[role=group][aria-label="Job type"] button:disabled').count();
  note(`${label} operations: jobButtons=${jobCards}, watch-link-card=${watchCard === 1}, planned-disabled=${planned}`);
  // form validation only: limit invalid shows error
  await page.fill("#limit", "0");
  const limitErr = await page.locator("text=Enter a ceiling of at least $0.01").count();
  note(`${label} operations: limitValidation=${limitErr > 0}`);
  await page.fill("#limit", "1.00");
  await page.click('[role=group][aria-label="Job type"] button:has-text("Custom Operation")');
  await page.waitForTimeout(400);
  const customPanel = await page.locator('form[aria-label="Configure Custom Operation"]').count();
  note(`${label} operations: custom job switches config panel=${customPanel > 0}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-operations.jpeg`, type: "jpeg", quality: 70 });

  // 4. Protocol Watch
  await navTo("Protocol Watch", "/watch");
  const watchText = await page.locator("main").textContent();
  note(`${label} watch: creates=${/New watch/.test(watchText)}, scheduler-note=${/Automatic checks run every/.test(watchText)}, runs-section=${await page.locator("section[aria-label='Recent watch runs']").count() > 0}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-watch.jpeg`, type: "jpeg", quality: 70 });

  // 5. Approvals
  await navTo("Approvals", "/approvals");
  const approvalCards = await page.locator("article").count();
  const emptyOrCards = (await page.locator("main").textContent()).includes("Nothing is waiting for approval");
  note(`${label} approvals: pending cards=${approvalCards}, empty-state-shown=${emptyOrCards}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-approvals.jpeg`, type: "jpeg", quality: 70 });

  // 6. Agents (via capability link, not nav)
  await page.goto(base + "/agents", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const agentStatus = await page.locator("main").textContent();
  note(`${label} agents page: research capabilities=${(agentStatus.match(/Telegraph|settlement|reconciliation/gi) || []).length}, planned count=${(agentStatus.match(/Planned/g) || []).length}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-agents.jpeg`, type: "jpeg", quality: 70 });

  // 7. Settings
  await navTo("Settings", "/settings");
  const settingsText = await page.locator("main").first().textContent();
  note(`${label} settings: integration statuses=${(settingsText.match(/Configured|Not configured/g) || []).length}, default ceiling shown=${/\$\d\.\d\d/.test(settingsText)}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-settings.jpeg`, type: "jpeg", quality: 70 });

  // 8. History + a real detail page
  await navTo("History", "/history");
  const rows = await page.locator("a.history-row").count();
  note(`${label} history: rows=${rows}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-history.jpeg`, type: "jpeg", quality: 70 });
  if (realCompleted) {
    await page.goto(`${base}/tasks/${realCompleted.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const detail = await page.locator("main").first().textContent();
    note(`${label} detail: outcome present=${detail.includes("Result") || detail.includes("verified")}, breadcrumb History link=${(await page.locator('main >> text=History').count()) > 0}`);
    await page.screenshot({ path: `.data/shots/cc-${label}-detail.jpeg`, type: "jpeg", quality: 70 });
  }

  note(`${label} console errors: ${errors.length}${errors.length ? " :: " + errors.join(" | ") : ""}`);
  await ctx.close();
}

fs.mkdirSync(".data/shots", { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
await run(browser, { width: 1440, height: 900 }, "desktop");
await run(browser, { width: 390, height: 844 }, "mobile");
await browser.close();
console.log(notes.join("\n"));
