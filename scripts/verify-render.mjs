/**
 * Rendered-interface verification: screenshots (small jpegs for review) plus
 * real DOM/CSS checks at desktop and mobile sizes. Not part of the app.
 * Run: node scripts/verify-render.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(os.tmpdir(), "bunx-0-playwright@latest", "node_modules", "playwright-core"));

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");
mkdirSync(".data/shots", { recursive: true });

async function check(page, name, viewport) {
  await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `.data/shots/${name}.jpeg`, fullPage: false, type: "jpeg", quality: 55 });
  const info = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const body = getComputedStyle(document.body);
    const main = document.querySelector("main");
    const composer = document.querySelector('[aria-label="Start a task"]');
    const heroSteps = [...document.querySelectorAll("li")].map((li) => li.textContent?.trim() || "");
    const cards = document.querySelectorAll("article");
    const chips = [...document.querySelectorAll('header span')].map((s) => s.textContent?.trim());
    return {
      h1Font: h1 ? getComputedStyle(h1).fontFamily.split(",")[0] : null,
      h1Size: h1 ? getComputedStyle(h1).fontSize : null,
      bodyBg: body.backgroundColor,
      bodyFont: body.fontFamily.split(",")[0],
      mainMaxWidth: main ? getComputedStyle(main).maxWidth : null,
      composerWidth: composer ? composer.getBoundingClientRect().width : null,
      composerRightEdge: composer ? Math.round(composer.getBoundingClientRect().right) : null,
      viewportWidth: window.innerWidth,
      composerIsRightColumn: composer ? composer.getBoundingClientRect().left > window.innerWidth / 2 : null,
      taskCards: cards.length,
      cardStates: [...cards].map((c) => c.textContent?.match(/Completed|Failed|Blocked|Needs approval|Working|Planning|Verifying|Rejected|Queued/)?.[0]),
      headerRight: document.querySelector("header")?.textContent?.includes("Until the work is done"),
      fontsLoaded: {
        display: document.fonts.check("600 32px Fraunces"),
        sans: document.fonts.check("400 15px Inter"),
        mono: document.fonts.check("400 12px 'JetBrains Mono'"),
      },
      evidenceSummary: document.body.textContent?.includes("Spent $0.08") || document.body.textContent?.includes("Spent $0"),
      hasEmDash: document.body.textContent?.includes("—") ?? null,
    };
  });
  console.log(JSON.stringify({ name, viewport: { ...viewport }, ...info }, null, 1));
}

const browser = await chromium.launch({ executablePath: exe });
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await check(page, "desktop", { w: 1440 });
  await page.close();
}
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await check(page, "mobile", { w: 390 });
  await page.close();
}
await browser.close();
