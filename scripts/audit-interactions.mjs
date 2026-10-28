/**
 * Real-browser regression audit of NIGHTSHIFT. Clicks and keys every control,
 * records console errors, failed requests, and states. Approve clicks are
 * intercepted (never spends); reject hits the real API (never spends).
 * Run: node scripts/audit-interactions.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(os.tmpdir(), "bunx-0-playwright@latest", "node_modules", "playwright-core"));

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");

const findings = [];
const note = (scope, msg) => findings.push({ scope, msg });

async function audit(viewport, label) {
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport });

  const consoleMsgs = [];
  const failedRequests = [];
  const approvesInitial = [];
  const rejectPosts = [];
  page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300) }));
  page.on("pageerror", (e) => consoleMsgs.push({ type: "PAGEERROR", text: String(e).slice(0, 300) }));
  page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url().slice(0, 120)}: ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.request().method()} ${r.url().slice(0, 120)}: HTTP ${r.status()}`); });
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/action")) {
      const body = r.postData() ?? "";
      if (body.includes("approve")) approvesInitial.push(r.url());
      else rejectPosts.push(r.url());
    }
  });
  // Intercept approve clicks only. Reject goes to the real API (free, no spend).
  await page.route("**/api/tasks/*/action", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes("approve")) {
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  });

  await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(900);

  for (const m of consoleMsgs) {
    if (m.type === "error" || m.type === "warning" || m.type === "PAGEERROR") note(label, `console ${m.type}: ${m.text}`);
  }

  // Composer structure
  const composer = page.locator('[aria-label="Start a task"]');
  const textarea = page.locator("#goal");
  const submitBtn = page.locator('button:has-text("Start task")').last();

  // 1. Enter submits the goal (approval ON so nothing is ever spent)
  const toggle = page.locator('[role="switch"]');
  if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
  await textarea.click();
  await textarea.fill("What is the current BTC price in USD?");
  await textarea.press("Enter", { delay: 20 });
  await page.waitForTimeout(3500);
  if (rejectPosts.length > 0 || approvesInitial.length > 0) note(label, "unexpected action posts during Enter submit");
  const btcCard = page.locator('article[data-state]:has-text("What is the current BTC price in USD?")').first();
  const btcState = await btcCard.getAttribute("data-state").catch(() => null);
  note(label, `Enter submit => task state: ${btcState}`);
  if (btcState !== "awaiting_approval") note(label, `BUG: Enter-submitted task not awaiting_approval (state=${btcState})`);

  // 2. Shift+Enter inserts a newline without submitting
  await textarea.click();
  await textarea.fill("line one");
  const tasksById = await page.evaluate(() => document.querySelectorAll("article[data-task-id]").length);
  await textarea.press("Shift+Enter");
  const val = await textarea.inputValue();
  if (!(val.includes("\n") && (await page.evaluate(() => document.querySelectorAll("article[data-task-id]").length)) === tasksById)) {
    note(label, "BUG: Shift+Enter did not insert a clean newline");
  }

  // 3. Example chips: click feasibility (pointer) + fills the textarea
  const chip = page.locator('button:has-text("BTC price")').first();
  await chip.scrollIntoViewIfNeeded();
  const box = await chip.boundingBox();
  if (box) {
    const tag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [box.x + box.width / 2, box.y + box.height / 2]);
    if (tag === "BODY") note(label, "BUG: example chip pointer-blocked");
  }
  await chip.click();
  await page.waitForTimeout(150);
  if (!(await textarea.inputValue()).includes("BTC")) note(label, "BUG: chip did not fill textarea");

  // 4. Budget: invalid value blocks submit with an inline message
  await page.fill("#limit", "0.00");
  await textarea.fill("What is the current ETH price in USD?");
  await page.waitForTimeout(150);
  if (!(await submitBtn.isDisabled())) note(label, "BUG: invalid ceiling left the primary button enabled");
  const errText = await page.locator('[aria-label="Start a task"] p.text-stop, [aria-label="Start a task"] [aria-invalid="true"]').count();
  if (errText === 0) note(label, "no inline validation surfaced for a bad ceiling");
  await page.fill("#limit", "0.50");

  // 5. Duplicate goal: submitting the same live goal is blocked with a message
  await textarea.fill("What is the current BTC price in USD?");
  await submitBtn.click();
  await page.waitForTimeout(400);
  const dupNote = await page.locator('[aria-label="Start a task"] [role="alert"]').first().textContent().catch(() => null);
  if (!dupNote || !dupNote.includes("already running")) note(label, `BUG: duplicate goal not blocked (saw: ${dupNote})`);
  else note(label, "duplicate live goal correctly blocked with an inline message");

  // 6. Real reject flow (no spend): newest approval card flips to Rejected immediately
  await textarea.fill("What is the current ETH price in USD?");
  await submitBtn.click();
  await page.waitForTimeout(4000);
  const ethBefore = await page.locator('article[data-state]:has-text("What is the current ETH price in USD?")').first().getAttribute("data-state");
  if (ethBefore !== "awaiting_approval") note(label, `BUG: ETH task state before reject is ${ethBefore}`);
  // the reject buttons live inside awaiting cards below the goal text
  const rejectedBtn = page.locator('button:has-text("Reject")').first();
  await rejectedBtn.click();
  await page.waitForTimeout(1500); // immediate update, not on the next poll tick
  const ethAfter = await page.locator('details:has-text("What is the current ETH price in USD?")').count();
  const rejectedCount = await page.locator('details.x-disc:has(span:has-text("Rejected"))').count();
  note(label, `reject: eth card now in history rows = ${ethAfter}, rows marked Rejected = ${rejectedCount}`);
  const totalRejected = await page.evaluate(() => document.querySelectorAll('details.history-row').length);
  note(label, `history rows total: ${totalRejected}`);
  const serverStates = await (await fetch(base + "/api/tasks")).json();
  const ethTasks = serverStates.tasks.filter((t) => t.goal.includes("ETH"));
  const anyRejectedFromThisRun = ethTasks.some((t) => t.state === "rejected" && new Date(t.updatedAt) > new Date(Date.now() - 60000));
  if (!anyRejectedFromThisRun) note(label, "BUG: reject click did not record a rejected task server-side");
  else note(label, "reject: server recorded a new rejected ETH task");

  // 7. Button + form response: chip click once more still usable
  if (rejectPosts.length === 0) note(label, "BUG: no reject POST went out");
  else note(label, `reject POSTs sent to real API: ${rejectPosts.length}`);

  // 8. Polling continues
  let gets = 0;
  page.on("request", (r) => { if (r.method() === "GET" && r.url().includes("/api/tasks")) gets++; });
  await page.waitForTimeout(9000);
  if (gets < 2) note(label, `BUG: polling dead (${gets} GETs in 9s)`);

  // 9. Composition facts: page height, hero type, row compactness
  const facts = await page.evaluate(() => ({
    pageHeight: document.body.scrollHeight,
    h1: document.querySelector("h1")?.getBoundingClientRect().height,
    h1Font: getComputedStyle(document.querySelector("h1")).fontFamily.split(",")[0],
    historyRows: document.querySelectorAll("details.history-row").length,
    activeCards: document.querySelectorAll("article[data-task-id]").length,
    hasEmDash: document.body.textContent?.includes("—"),
    focusables: [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null && (b.getBoundingClientRect().height < 38 || b.getBoundingClientRect().width < 38)).map((b) => ({ t: (b.textContent ?? "").trim().slice(0, 26), h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width) })),
  }));
  note(label, `facts: ${JSON.stringify(facts)}`);

  await page.screenshot({ path: `.data/shots/audit-${label}.jpeg`, fullPage: false, type: "jpeg", quality: 55 });
  await page.screenshot({ path: `.data/shots/audit-${label}-full.jpeg`, fullPage: true, type: "jpeg", quality: 50 });

  const clientErrors = consoleMsgs.filter((m) => m.type === "error" || m.type === "PAGEERROR").length;
  note(label, `console client errors: ${clientErrors}; failed requests: ${JSON.stringify(failedRequests)}`);
  await browser.close();
}

await audit({ width: 1440, height: 900 }, "desktop");
await audit({ width: 390, height: 844 }, "mobile");
console.log(JSON.stringify(findings, null, 1));
