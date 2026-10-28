/**
 * Command Center browser audit: verifies every sidebar route, the header
 * branding/status, metric cards, agents honesty, the launcher's planned jobs,
 * the approvals/history/detail flows, and captures desktop+mobile screenshots.
 * Never submits an operation and never touches approvals (no paid, no state changes).
 * Run: node scripts/shots-cc.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

function findPlaywrightCore() {
  for (const p of ["/tmp/pw/node_modules/playwright-core", path.join(os.tmpdir(), "pw", "node_modules", "playwright-core")]) {
    try { require.resolve(p); return p; } catch { /* next */ }
  }
  throw new Error("playwright-core not found; install with: mkdir -p /tmp/pw && cd /tmp/pw && bun add playwright-core");
}
const require = createRequire(import.meta.url);
const { chromium } = require(findPlaywrightCore());
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");

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

  // 1. Dashboard
  await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1200);
  const brand = await page.locator("header").textContent();
  note(`${label} header brand: NIGHTSHIFT=${brand.includes("NIGHTSHIFT")}, PENNYWISE=${brand.includes("PENNYWISE")}, status=${/Operational|Degraded|API unreachable|Store unavailable|Checking/.test(brand)}`);
  const metricCards = await page.locator('a:has(p):near(h1)').count();
  const metricsText = await page.locator("section[aria-label=Metrics]").textContent();
  note(`${label} metrics: has today spend=${metricsText.includes("Spend today")}, completed=${metricsText.includes("Completed tasks")}, approvals=${metricsText.includes("Pending approvals")}`);
  const agentsText = await page.locator("section[aria-label='Your Agents']").textContent();
  note(`${label} agents: research available=${agentsText.includes("Research & Verify") && agentsText.includes("Available")}, planned labels=${(agentsText.match(/Planned/g) || []).length}`);
  const feedRows = await page.locator("section[aria-label='Live activity'] tbody tr").count();
  note(`${label} activity feed rows (desktop): ${feedRows}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-dashboard.jpeg`, type: "jpeg", quality: 70 });
  const launch = page.locator('header + * >> text=Launch Operation'); // page-level main CTA
  const launchBtn = await page.getByRole("link", { name: "Launch Operation" }).count();
  note(`${label} launch CTA visible: ${launchBtn > 0}`);

  // 2. Sidebar navigation through every route
  const needMobileNav = viewport.width < 768;
  const navTo = async (name, path) => {
    if (!needMobileNav) await page.click(`aside nav a[title=${name}]`);
    else await page.click(`header nav[aria-label=Main] a:has-text("${name}")`);
    await page.waitForTimeout(700);
    note(`${label} nav ${name}: url=${page.url().endsWith(path)} h1=${(await page.locator("h1").first().textContent())?.trim()}`);
  };
  // 3. Operations
  await navTo("Operations", "/operations");
  const jobCards = await page.locator('[role=group][aria-label="Job type"] button').count();
  const planned = await page.locator('[role=group][aria-label="Job type"] button:disabled').count();
  note(`${label} operations: jobCards=${jobCards}, planned-disabled=${planned}`);
  // form validation only: empty goal submit must be disabled, limit invalid shows error
  const submitDisabled = await page.locator('button[type=submit][disabled]').count();
  await page.fill("#limit", "0");
  const limitErr = await page.locator("text=Enter a ceiling of at least $0.01").count();
  note(`${label} operations: submitDisabled=${submitDisabled > 0}, limitValidation=${limitErr > 0}`);
  await page.fill("#limit", "1.00");
  await page.click('[role=group][aria-label="Job type"] button:has-text("Custom Operation")');
  await page.waitForTimeout(400);
  const customPanel = await page.locator('form[aria-label="Configure Custom Operation"]').count();
  note(`${label} operations: custom job switches config panel=${customPanel > 0}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-operations.jpeg`, type: "jpeg", quality: 70 });

  // 4. Approvals
  await navTo("Approvals", "/approvals");
  const approvalCards = await page.locator("article").count();
  note(`${label} approvals: pending cards=${approvalCards}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-approvals.jpeg`, type: "jpeg", quality: 70 });

  // 5. Agents
  await navTo("Agents", "/agents");
  const agentStatus = await page.locator("main").textContent();
  note(`${label} agents page: research capabilities=${(agentStatus.match(/Telegraph|settlement|reconciliation/gi) || []).length}, planned count=${(agentStatus.match(/Planned/g) || []).length}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-agents.jpeg`, type: "jpeg", quality: 70 });

  // 6. Settings
  await navTo("Settings", "/settings");
  const settingsText = await page.locator("main").first().textContent();
  note(`${label} settings: integration statuses=${(settingsText.match(/Configured|Not configured/g) || []).length}, default ceiling shown=${/\$\d\.\d\d/.test(settingsText)}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-settings.jpeg`, type: "jpeg", quality: 70 });

  // 7. History + a real detail page + back
  await navTo("History", "/history");
  const rows = await page.locator("a.history-row").count();
  note(`${label} history: rows=${rows}`);
  await page.screenshot({ path: `.data/shots/cc-${label}-history.jpeg`, type: "jpeg", quality: 70 });
  if (realCompleted) {
    await page.goto(`${base}/tasks/${realCompleted.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const detail = await page.locator("main").first().textContent();
    note(`${label} detail: outcome present=${detail.includes("Result") || detail.includes("verified")}, shell nav=history link=${(await page.locator('text=All work history').count()) > 0}`);
    await page.screenshot({ path: `.data/shots/cc-${label}-detail.jpeg`, type: "jpeg", quality: 70 });
  }

  note(`${label} console errors: ${errors.length}${errors.length ? " :: " + errors.join(" | ") : ""}`);
  await ctx.close();
}

const browser = await chromium.launch({ executablePath: exe });
await run(browser, { width: 1440, height: 900 }, "desktop");
await run(browser, { width: 390, height: 844 }, "mobile");
await browser.close();
console.log(notes.join("\n"));
