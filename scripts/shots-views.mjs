/**
 * Browser verification of the Workspace / Work History / Task Details routes,
 * plus real desktop and mobile screenshots of every view.
 * Run: node scripts/shots-views.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
function findPlaywrightCore() {
  for (const p of [
    "/tmp/pw/node_modules/playwright-core",
    path.join(os.tmpdir(), "bunx-0-playwright@latest", "node_modules", "playwright-core"),
  ]) {
    try {
      require.resolve(p);
      return p;
    } catch {
      // try the next location
    }
  }
  throw new Error("playwright-core not found; install it with: mkdir -p /tmp/pw && cd /tmp/pw && bun add playwright-core");
}
const { chromium } = require(findPlaywrightCore());

const base = process.env.SHOT_BASE || "http://localhost:3000";
const exe = path.join(os.homedir(), ".cache", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");

const notes = [];
const note = (m) => notes.push(m);

// Pick real task ids from the store: a legitimate completed task, a test run,
// and an active (awaiting approval) one for the approval UI on details.
const all = (await (await fetch(base + "/api/tasks")).json()).tasks;
const completed = all.find((t) => t.state === "completed" && t.spend.spentUsdCents > 0 && !t.origin.source.includes("telegram"));
const testRun = all.find((t) => (t.labels ?? []).includes("audit-rehearsal"));
const awaiting = all.find((t) => t.state === "awaiting_approval");
note(`picked ids: completed=${completed?.id} testRun=${testRun?.id} awaiting=${awaiting?.id}`);

async function shoot(browser, viewport, label) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  // 1. Workspace direct navigation
  await page.goto(base + "/", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1200);
  const workspaceH1 = (await page.locator("h1").first().textContent())?.trim().slice(0, 40);
  const activeCards = await page.locator("article[data-task-id]").count();
  const recentRows = await page.locator('a[href^="/tasks/"]').count();
  note(`${label} workspace: h1="${workspaceH1}", activeCards=${activeCards}, linksToDetails=${recentRows}`);
  await page.screenshot({ path: `.data/shots/${label}-workspace.jpeg`, fullPage: false, type: "jpeg", quality: 70 });

  // 2. Nav into history from the header
  await page.click('header nav >> text=Work history');
  await page.waitForURL("**/history");
  await page.waitForTimeout(1200);
  const filterCounts = await page.locator("[role=group] button").allTextContents();
  note(`${label} history via nav: filters=${JSON.stringify(filterCounts.map((t) => t.replace(/\s+/g, " ").trim()))}`);
  await page.screenshot({ path: `.data/shots/${label}-history.jpeg`, fullPage: false, type: "jpeg", quality: 70 });
  // full page too
  await page.screenshot({ path: `.data/shots/${label}-history-full.jpeg`, fullPage: true, type: "jpeg", quality: 55 });

  // 3. Test runs filter separates audit artifacts
  await page.click('button:has-text("Test runs")');
  await page.waitForTimeout(500);
  const testRows = await page.locator('details.history-row, a.history-row').count();
  const ordinary = await page.evaluate(() => document.querySelectorAll('[aria-label="Work"] a').length);
  note(`${label} test-runs filter: testRows=${testRows}, ordinary rows visible in work section=${ordinary}`);
  await page.screenshot({ path: `.data/shots/${label}-history-tests.jpeg`, fullPage: false, type: "jpeg", quality: 70 });
  await page.click('button:has-text("All")');

  // 4. Row navigation into task details
  await page.click('[aria-label="Work"] a.history-row >> nth=0');
  await page.waitForTimeout(1500);
  const isDetail = (await page.locator('p:has-text("task ")').count()) > 0 && (await page.locator("main").textContent())?.includes("Purchases") === false;
  const detailChip = await page.locator("main [data-state], main span:has-text('Completed')").first().textContent().catch(() => null);
  note(`${label} detail rows: onDetail=${isDetail}, chip=${(detailChip ?? "").slice(0, 20)}`);
  const detailUrl = page.url();

  // 5. Refresh the detail URL directly (persistence through reload)
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const reloadOk = (await page.locator("main p.font-medium").first().textContent()) != null;
  note(`${label} detail refresh keeps data: ${reloadOk} (${detailUrl})`);
  await page.screenshot({ path: `.data/shots/${label}-detail-completed.jpeg`, fullPage: true, type: "jpeg", quality: 60 });

  // 6. Back navigation works (header link)
  await page.click('header nav >> text=Workspace');
  await page.waitForURL(base + "/");
  note(`${label} nav back to workspace: OK`);

  // 7. Al scrutinize the test-run detail (label visible) if available
  if (testRun) {
    await page.goto(base + `/tasks/${testRun.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const labeled = (await page.locator("main").textContent())?.includes("Test run") ?? false;
    note(`${label} test-run detail shows label: ${labeled}`);
    await page.screenshot({ path: `.data/shots/${label}-detail-testrun.jpeg`, fullPage: true, type: "jpeg", quality: 60 });
  }

  // 8. Awaiting approval task detail: buttons present, nothing clicked
  if (awaiting) {
    await page.goto(base + `/tasks/${awaiting.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const approve = await page.locator('button:has-text("Approve and continue")').count();
    const reject = await page.locator('button:has-text("Reject")').count();
    note(`${label} awaiting detail: approve=${approve > 0}, reject=${reject > 0} (untouched)`);
    await page.screenshot({ path: `.data/shots/${label}-detail-awaiting.jpeg`, fullPage: true, type: "jpeg", quality: 60 });
  }

  // 9. Unknown id: honest not-found with a way back
  await page.goto(base + "/tasks/not-a-real-id", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const nf = (await page.locator("main").textContent()) ?? "";
  note(`${label} unknown id: notFound=${nf.includes("Task not found")}`);
  await page.screenshot({ path: `.data/shots/${label}-detail-missing.jpeg`, fullPage: false, type: "jpeg", quality: 60 });

  // 10. Empty history: mock the list API (client-side empty state render)
  await ctx.route("**/api/tasks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [] }) }));
  await page.goto(base + "/history", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const emptyText = (await page.locator("main").textContent()) ?? "";
  const emptyOk = emptyText.includes("No tasks yet");
  const workspaceLink = await page.locator('main >> text=Go to the workspace').count();
  note(`${label} empty history: emptyState=${emptyOk}, linkToWorkspace=${workspaceLink > 0}`);
  await page.screenshot({ path: `.data/shots/${label}-history-empty.jpeg`, fullPage: false, type: "jpeg", quality: 70 });
  await ctx.unroute("**/api/tasks");

  note(`${label} console errors: ${errors.length ? JSON.stringify(errors) : "0"}`);
  await ctx.close();
}

const browser = await chromium.launch({ executablePath: exe });
await shoot(browser, { width: 1440, height: 900 }, "desktop");
await shoot(browser, { width: 390, height: 844 }, "mobile");
await browser.close();
console.log(JSON.stringify(notes, null, 1));
