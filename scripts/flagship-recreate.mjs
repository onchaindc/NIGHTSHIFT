/**
 * One-shot: recreate the Uniswap flagship demo v2 watch, run a free baseline
 * check, then a repeat check, and print the results. Not part of the app.
 */
const base = process.env.SHOT_BASE || "http://localhost:3000";

async function main() {
  const body = {
    name: "Uniswap flagship demo v2",
    protocol: "Uniswap",
    sources: [
      { type: "github_releases", label: "SDK releases (GitHub API)", target: "Uniswap/sdks" },
      { type: "rss_feed", label: "SDK releases (GitHub Atom)", target: "https://github.com/Uniswap/sdks/releases.atom" },
      { type: "github_commits", label: "SDK main branch commits (GitHub API)", target: "Uniswap/sdks" },
      { type: "docs_url", label: "Official docs", target: "https://developers.uniswap.org/docs" },
      { type: "discourse_forum", label: "Governance forum", target: "https://gov.uniswap.org" },
    ],
    spendLimitUsdCents: 200,
    requiresApprovalForPaid: true,
    telegramChatId: null,
  };
  const created = await fetch(`${base}/api/watches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const createdBody = await created.json();
  if (!created.ok) {
    console.error("create failed:", createdBody);
    process.exit(1);
  }
  const watch = createdBody.watch;
  console.log("watch:", watch.id, watch.name, "sources:", watch.sources.length);

  async function check(label) {
    const res = await fetch(`${base}/api/watches/${watch.id}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const t = (await res.json()).task;
    console.log(
      `${label} task ${t.id.slice(0, 8)} state=${t.state} baseline=${t.events.filter((e) => e.type === "watch_baseline").length} changes=${t.events.filter((e) => e.type === "watch_change_detected").length} errors=${t.events.filter((e) => e.type === "criteria_failed" || (e.type === "watch_source_checked" && e.message.includes("FAILED"))).length} spent=${t.spend.spentUsdCents}`,
    );
  }
  await check("baseline");
  await check("repeat ");
}

await main();
