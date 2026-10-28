/**
 * Visual verification helper: screenshots the rendered page at desktop and
 * mobile sizes into /tmp. Not part of the app; used only when verifying.
 * Run: node scripts/screenshot-home.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// playwright-core comes from the bunx playwright package cache; resolve it
// explicitly so the project itself never needs the dependency.
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(os.tmpdir(), "bunx-0-playwright@latest", "node_modules", "playwright-core"));

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exeDirName = "chromium_headless_shell-1248";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", exeDirName, "chrome-headless-shell-linux64", "chrome-headless-shell");

const browser = await chromium.launch({ executablePath: exe });

async function shot(name, viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/ns_${name}.png`, fullPage: true });
  console.log(`saved /tmp/ns_${name}.png`);
  await page.close();
}

await shot("desktop", { width: 1440, height: 900 });
await shot("mobile", { width: 390, height: 844 });
await browser.close();
