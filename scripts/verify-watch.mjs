/**
 * Rendered-interface verification for the Protocol Watch UI: screenshots plus
 * real DOM checks of the /watch page at desktop and mobile sizes. Not part of
 * the app. Run: node scripts/verify-watch.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(os.homedir(), ".bun", "install", "cache", "playwright-core", "1.64.1@@@1", "index.js"));

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");
mkdirSync(".data/shots", { recursive: true });

async function check(page, name, viewport) {
  await page.goto(base + "/watch", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `.data/shots/${name}.jpeg`, fullPage: false, type: "jpeg", quality: 55 });
  await page.screenshot({ path: `.data/shots/watch-${name}-full.jpeg`, fullPage: true, type: "jpeg", quality: 40 });
  const info = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const main = document.querySelector("main");
    const body = document.body;
    const buttons = [...document.querySelectorAll("button")].map((b) => ({ label: b.textContent?.trim().slice(0, 40), disabled: b.disabled, visible: b.getBoundingClientRect().width > 0 }));
    const links = [...document.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), text: a.textContent?.trim().slice(0, 30) }));
    const headings = [...document.querySelectorAll("h2, h3")].map((h) => h.textContent?.trim()).filter(Boolean);
    const hasEmDash = body.textContent?.includes("—") ?? null;
    const bodyFont = getComputedStyle(body).fontFamily.split(",")[0];
    const mainWidth = main ? Math.round(main.getBoundingClientRect().width) : null;
    const overflowing = document.documentElement.scrollWidth > window.innerWidth + 1;
    return {
      h1: h1?.textContent?.trim(),
      headings,
      navLinks: links.filter((l) => l.href?.startsWith("/") && !l.href.includes("//")),
      buttonCount: buttons.length,
      disabledButtons: buttons.filter((b) => b.disabled).map((b) => b.label),
      bodyFont,
      mainWidth,
      viewportWidth: window.innerWidth,
      horizontalOverflow: overflowing,
      hasEmDash,
      mentionsWatch: body.textContent?.toLowerCase().includes("watch") ?? false,
    };
  });
  console.log(JSON.stringify({ name, viewport: { ...viewport }, ...info }, null, 1));
}

const browser = await chromium.launch({ executablePath: exe });
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await check(page, "watch-desktop", { w: 1440 });
  await page.close();
}
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await check(page, "watch-mobile", { w: 390 });
  await page.close();
}
await browser.close();
console.log("done");
