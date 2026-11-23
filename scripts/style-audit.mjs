/**
 * Rendered-style audit for the DROPTEST-language restyle.
 * Verifies computed styles on real pages at desktop and mobile sizes.
 * Run: node scripts/style-audit.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/tmp/pw/node_modules/playwright-core");
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");

const base = process.env.SHOT_BASE || "http://localhost:3000";
const fails = [];

async function check(browser, viewport, label) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const c = (name, got, want) => {
    if (got !== want) fails.push(`${label} ${name}: got ${got}, want ${want}`);
  };
  const css = (l, prop) => l.evaluate((el, p) => getComputedStyle(el)[p], prop);

  // Workspace
  await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1000);
  c("body bg", await css(page.locator("body"), "backgroundColor"), "rgb(247, 246, 242)");
  c("body color", await css(page.locator("body"), "color"), "rgb(22, 24, 29)");
  c("body family", (await css(page.locator("body"), "fontFamily")).includes("Geist") ? "geist" : "other", "geist");
  const h1 = page.locator("h1").first();
  const h1Size = await css(h1, "fontSize");
  c("h1 size", ["36px", "30px"].includes(h1Size) ? h1Size : "unexpected", h1Size);
  const submit = page.locator('button[type="submit"]');
  c("submit bg", await css(submit, "backgroundColor"), "rgb(22, 24, 29)");
  c("submit radius", await css(submit, "borderRadius"), "4px");
  const composer = page.locator("form").first();
  c("composer bg", await css(composer, "backgroundColor"), "rgb(255, 255, 255)");
  const header = page.locator("header").first();
  c("header bg luminous+translucent", (await css(header, "backgroundColor")).includes("/ 0.8"), true);
  // dark-theme leftovers: only the slim primary buttons may use the ink color
  const darkish = await page.evaluate(() =>
    [...document.querySelectorAll("main *")].filter((el) => {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
      const dark = m && Number(m[4] ?? 1) > 0.5 && Number(m[1]) < 60 && Number(m[2]) < 60 && Number(m[3]) < 60;
      const intentional = dark && el.matches("button, a") && (el.classList.contains("bg-ink") || el.classList.contains("border-ink"));
      return dark && !intentional;
    }).length
  );
  c("dark panels in main", darkish, 0);
  await page.screenshot({ path: `.data/shots/${label}-workspace.jpeg`, type: "jpeg", quality: 70 });

  // History
  await page.goto(base + "/history", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const activeFilter = page.locator('[aria-label="Filter by status"] button:has-text("All")');
  c("history filter active bg", await css(activeFilter, "backgroundColor"), "rgb(22, 24, 29)");
  const row = page.locator("a.history-row").first();
  const rowBorder = await css(row, "borderBottomColor");
  if (!rowBorder.includes("227") && !rowBorder.includes("0.13")) fails.push(`${label} history row border: ${rowBorder}`);
  await page.screenshot({ path: `.data/shots/${label}-history.jpeg`, type: "jpeg", quality: 70 });

  // Task details (real completed task from the API)
  const all = (await (await fetch(base + "/api/tasks")).json()).tasks;
  const done = all.find((t) => t.state === "completed");
  await page.goto(`${base}/tasks/${done.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const outcome = page.locator("main").locator("div.rounded-sm").first();
  c("detail visible", await outcome.isVisible(), true);
  await page.screenshot({ path: `.data/shots/${label}-detail-completed.jpeg`, type: "jpeg", quality: 70 });

  c("console errors", errors.length, 0);
  if (errors.length) fails.push(`${label} console errors: ${errors.join(" | ").slice(0, 300)}`);
  await ctx.close();
}

const browser = await chromium.launch({ executablePath: exe });
await check(browser, { width: 1440, height: 900 }, "desktop");
await check(browser, { width: 390, height: 844 }, "mobile");
await browser.close();

console.log(fails.length ? "FAIL:\n" + fails.join("\n") : "style-audit: all checks pass");
